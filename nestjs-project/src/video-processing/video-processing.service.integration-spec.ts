import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import { MediaProcessingError } from '../media/media.errors';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  TEST_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createInvalidMediaFile,
  createTestVideoFile,
  removeTestFile,
} from '../test/fixtures';
import { uploadTestObject } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  thumbnailStorageKey,
  videoStorageKey,
} from '../videos/videos.constants';
import { VideoProcessingService } from './video-processing.service';

jest.setTimeout(60000);

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let service: VideoProcessingService;
  let validVideoPath: string;
  let invalidVideoPath: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(TEST_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingService],
    }).compile();
    await module.init();

    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    service = module.get(VideoProcessingService);

    validVideoPath = await createTestVideoFile(2);
    invalidVideoPath = await createInvalidMediaFile();
  });

  afterAll(async () => {
    await removeTestFile(validVideoPath);
    await removeTestFile(invalidVideoPath);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_processing_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_processing_chan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  async function createProcessingVideo(
    channelId: string,
    extension = 'mp4',
  ): Promise<Video> {
    const id = randomUUID();
    return videoRepository.save(
      videoRepository.create({
        id,
        channel_id: channelId,
        public_id: id.replace(/-/g, '').slice(0, 11),
        title: 'My Video',
        status: VideoStatus.PROCESSING,
        original_filename: `my-video.${extension}`,
        content_type: 'video/mp4',
        size_bytes: 123456,
        storage_key: videoStorageKey(id, extension),
      }),
    );
  }

  it('processes a valid MP4 into ready with metadata and thumbnail', async () => {
    const channel = await createChannel();
    const video = await createProcessingVideo(channel.id);
    const fileBuffer = await fs.readFile(validVideoPath);
    await uploadTestObject(storage, video.storage_key, fileBuffer, 'video/mp4');

    await service.process(video.id);

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBeGreaterThanOrEqual(1.9);
    expect(processed.duration_seconds).toBeLessThanOrEqual(2.1);
    expect(processed.metadata?.width).toBe(320);
    expect(processed.thumbnail_key).toBe(thumbnailStorageKey(video.id));
    expect(processed.processed_at).toBeInstanceOf(Date);
    expect(processed.processing_error).toBeNull();

    const thumbnail = await storage.headObject(thumbnailStorageKey(video.id));
    expect(thumbnail.contentType).toBe('image/jpeg');
  });

  it('throws MediaProcessingError for an invalid object and markFailed records the reason', async () => {
    const channel = await createChannel();
    const video = await createProcessingVideo(channel.id);
    const fileBuffer = await fs.readFile(invalidVideoPath);
    await uploadTestObject(storage, video.storage_key, fileBuffer, 'video/mp4');

    let caughtError: Error | undefined;
    try {
      await service.process(video.id);
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).toBeInstanceOf(MediaProcessingError);

    await service.markFailed(video.id, caughtError!.message);

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.processing_error).toBe(caughtError!.message);
  });
});
