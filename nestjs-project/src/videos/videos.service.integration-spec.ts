import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import {
  TEST_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { drainQueue, getVideoProcessingQueue } from '../test/queue';
import { User } from '../users/entities/user.entity';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { videoJobId } from '../queue/queue.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';
import { Video, VideoStatus } from './entities/video.entity';

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(TEST_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    channelsService = moduleRef.get(ChannelsService);
    storageService = moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    const queue = getVideoProcessingQueue(moduleRef);
    await drainQueue(queue);
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const queue = getVideoProcessingQueue(moduleRef);
    await drainQueue(queue);
  });

  let userCounter = 0;
  async function createUserAndChannel(): Promise<{
    userId: string;
    channelId: string;
  }> {
    const userRepository = dataSource.getRepository(User);
    const email = `videos_svc_${++userCounter}@example.com`;
    const user = await userRepository.save(
      userRepository.create({ email, password: 'hashed' }),
    );
    const channel = await channelsService.createChannel(user.id, email);
    return { userId: user.id, channelId: channel.id };
  }

  describe('create', () => {
    it('persists a draft video with the user channel_id, a real upload_id and storage_key in MinIO', async () => {
      const { userId, channelId } = await createUserAndChannel();

      const result = await videosService.create(userId, {
        filename: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 150_000_000,
      });

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.public_id).toHaveLength(11);
      expect(result.upload.upload_id).toBeDefined();
      expect(result.upload.part_count).toBe(3);

      const persisted = await videoRepository.findOneBy({ id: result.id });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe(VideoStatus.DRAFT);
      expect(persisted!.channel_id).toBe(channelId);
      expect(persisted!.upload_id).toBe(result.upload.upload_id);
      expect(persisted!.storage_key).toBe(`videos/${result.id}/original.mp4`);

      const parts = await storageService.listParts(
        persisted!.storage_key,
        persisted!.upload_id as string,
      );
      expect(parts).toEqual([]);
    });
  });

  describe('createPartUrls + listUploadedParts', () => {
    it('accepts a real PUT on the presigned URL and the part appears in listUploadedParts with an etag', async () => {
      const { userId } = await createUserAndChannel();
      const created = await videosService.create(userId, {
        filename: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      });

      const { parts } = await videosService.createPartUrls(
        created.public_id,
        userId,
        [1],
      );
      expect(parts).toHaveLength(1);
      expect(parts[0].part_number).toBe(1);

      const putResponse = await fetch(parts[0].url, {
        method: 'PUT',
        body: Buffer.from('a'.repeat(1024)),
      });
      expect(putResponse.ok).toBe(true);

      const { parts: uploaded } = await videosService.listUploadedParts(
        created.public_id,
        userId,
      );
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].part_number).toBe(1);
      expect(uploaded[0].etag).toBeDefined();
      expect(uploaded[0].size_bytes).toBe(1024);
    }, 30000);
  });

  describe('completeUpload / abortUpload', () => {
    async function uploadRealParts(
      storageKey: string,
      uploadId: string,
      partSizes: number[],
    ): Promise<{ part_number: number; etag: string }[]> {
      const completed: { part_number: number; etag: string }[] = [];
      for (let index = 0; index < partSizes.length; index++) {
        const partNumber = index + 1;
        const url = await storageService.presignUploadPart(
          storageKey,
          uploadId,
          partNumber,
          3600,
        );
        const response = await fetch(url, {
          method: 'PUT',
          body: Buffer.alloc(partSizes[index], 'x'),
        });
        const etag = response.headers.get('etag');
        if (!etag) {
          throw new Error('Missing ETag header from MinIO PUT response');
        }
        completed.push({ part_number: partNumber, etag });
      }
      return completed;
    }

    it('completes a real 2-part upload: object assembled, status processing, upload_id null, job enqueued', async () => {
      const { userId } = await createUserAndChannel();
      const totalSize = 6 * 1024 * 1024 + 1024;
      const created = await videosService.create(userId, {
        filename: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: totalSize,
      });

      const completedParts = await uploadRealParts(
        `videos/${created.id}/original.mp4`,
        created.upload.upload_id,
        [5 * 1024 * 1024, 1024 * 1024 + 1024],
      );

      const result = await videosService.completeUpload(
        created.public_id,
        userId,
        completedParts,
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.size_bytes).toBe(totalSize);

      const persisted = await videoRepository.findOneBy({ id: created.id });
      expect(persisted!.status).toBe(VideoStatus.PROCESSING);
      expect(persisted!.upload_id).toBeNull();
      expect(persisted!.size_bytes).toBe(totalSize);

      const objectMeta = await storageService.headObject(
        persisted!.storage_key,
      );
      expect(objectMeta.contentLength).toBe(totalSize);

      const queue = getVideoProcessingQueue(moduleRef);
      const job = await queue.getJob(videoJobId(created.id));
      expect(job).toBeDefined();
    }, 30000);

    it('removes the multipart upload and the draft row on abort', async () => {
      const { userId } = await createUserAndChannel();
      const created = await videosService.create(userId, {
        filename: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      });

      await videosService.abortUpload(created.public_id, userId);

      const persisted = await videoRepository.findOneBy({ id: created.id });
      expect(persisted).toBeNull();

      await expect(
        storageService.listParts(
          `videos/${created.id}/original.mp4`,
          created.upload.upload_id,
        ),
      ).rejects.toThrow();
    }, 30000);
  });
});
