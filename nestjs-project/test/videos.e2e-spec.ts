import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import videosConfig from '../src/config/videos.config';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { videoJobId } from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { drainQueue, getVideoProcessingQueue } from '../src/test/queue';
import { registerChannelAndLogin, seedReadyVideo } from '../src/test/videos';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface CreateVideoResponse {
  id: string;
  public_id: string;
  title: string;
  status: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  upload: {
    upload_id: string;
    part_size_bytes: number;
    part_count: number;
    part_url_ttl_seconds: number;
  };
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;
  let videosCfg: ConfigType<typeof videosConfig>;
  let emailCounter = 0;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageService = moduleFixture.get(StorageService);
    videosCfg = moduleFixture.get(videosConfig.KEY);
  }, 30000);

  afterAll(async () => {
    const queue = getVideoProcessingQueue(moduleFixture);
    await drainQueue(queue);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    const queue = getVideoProcessingQueue(moduleFixture);
    await drainQueue(queue);
  });

  function uniqueEmail(prefix: string): string {
    return `${prefix}_${++emailCounter}@example.com`;
  }

  async function createDraftVideo(
    accessToken: string,
    overrides: Partial<{
      filename: string;
      content_type: string;
      size_bytes: number;
      title: string;
    }> = {},
  ): Promise<CreateVideoResponse> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: overrides.filename ?? 'aula.mp4',
        content_type: overrides.content_type ?? 'video/mp4',
        size_bytes: overrides.size_bytes ?? 1024,
        ...(overrides.title !== undefined ? { title: overrides.title } : {}),
      })
      .expect(201);
    return res.body as CreateVideoResponse;
  }

  async function uploadPartsDirectly(
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

  describe('POST /videos', () => {
    it('returns 201 with public_id, derived title and upload parameters', async () => {
      const session = await registerChannelAndLogin(app, uniqueEmail('create'));

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({
          filename: 'aula.mp4',
          content_type: 'video/mp4',
          size_bytes: 150_000_000,
        })
        .expect(201);

      expect(res.body.public_id).toHaveLength(11);
      expect(res.body.title).toBe('aula');
      expect(res.body.status).toBe('draft');
      expect(res.body.upload.part_count).toBe(3);
      expect(res.body.upload.part_size_bytes).toBe(67_108_864);
      expect(res.body.upload.part_url_ttl_seconds).toBe(3600);
      expect(res.body.upload.upload_id).toBeDefined();
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          filename: 'aula.mp4',
          content_type: 'video/mp4',
          size_bytes: 1024,
        })
        .expect(401);
    });

    it('returns 400 with VALIDATION_ERROR on an invalid body', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('invalidbody'),
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ content_type: 'video/mp4', size_bytes: 1024 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 413 with VIDEO_TOO_LARGE above UPLOAD_MAX_SIZE_BYTES', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('toolarge'),
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({
          filename: 'aula.mp4',
          content_type: 'video/mp4',
          size_bytes: videosCfg.maxSizeBytes + 1,
        })
        .expect(413);

      expect(res.body.error).toBe('VIDEO_TOO_LARGE');
    });

    it('returns 415 with VIDEO_UNSUPPORTED_MEDIA_TYPE outside the allowlist', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('unsupported'),
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({
          filename: 'doc.pdf',
          content_type: 'application/pdf',
          size_bytes: 1024,
        })
        .expect(415);

      expect(res.body.error).toBe('VIDEO_UNSUPPORTED_MEDIA_TYPE');
    });
  });

  describe('upload part URLs', () => {
    it('returns 200 with presigned URLs pointing to the public storage endpoint', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('parturls'),
      );
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: 1024,
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/part-urls`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ part_numbers: [1] })
        .expect(200);

      expect(res.body.parts).toHaveLength(1);
      expect(res.body.parts[0].part_number).toBe(1);
      expect(res.body.parts[0].url).toContain('minio:9000');
      expect(res.body.parts[0].expires_at).toEqual(expect.any(String));
    });

    it('returns 400 VALIDATION_ERROR with an empty part_numbers array', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('emptyparts'),
      );
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: 1024,
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/part-urls`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ part_numbers: [] })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 VIDEO_INVALID_PART_NUMBER when a part number is out of range', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('badpartnumber'),
      );
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: 150_000_000,
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/part-urls`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ part_numbers: [999] })
        .expect(400);

      expect(res.body.error).toBe('VIDEO_INVALID_PART_NUMBER');
    });

    it('returns 403 VIDEO_FORBIDDEN when called by a non-owner', async () => {
      const owner = await registerChannelAndLogin(app, uniqueEmail('owner'));
      const other = await registerChannelAndLogin(app, uniqueEmail('other'));
      const video = await createDraftVideo(owner.accessToken, {
        size_bytes: 1024,
      });

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/part-urls`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ part_numbers: [1] })
        .expect(403);

      expect(res.body.error).toBe('VIDEO_FORBIDDEN');
    });

    it('returns 404 VIDEO_NOT_FOUND for a non-existent publicId', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('missing'),
      );

      const res = await request(app.getHttpServer())
        .post('/videos/doesnotexist1/upload/part-urls')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ part_numbers: [1] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('lists an uploaded part with its etag after a real PUT', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('listparts'),
      );
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: 1024,
      });

      const partUrlsRes = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/part-urls`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ part_numbers: [1] })
        .expect(200);

      await fetch(partUrlsRes.body.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(1024, 'x'),
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/upload/parts`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);

      expect(res.body.parts).toHaveLength(1);
      expect(res.body.parts[0].part_number).toBe(1);
      expect(res.body.parts[0].etag).toBeDefined();
    });
  });

  describe('complete / abort upload', () => {
    it('completes a real 2-part upload, returns 200 processing and enqueues a job', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('complete'),
      );
      const totalSize = 6 * 1024 * 1024 + 1024;
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: totalSize,
      });
      const storageKey = `videos/${video.id}/original.mp4`;
      const parts = await uploadPartsDirectly(
        storageKey,
        video.upload.upload_id,
        [5 * 1024 * 1024, 1024 * 1024 + 1024],
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/complete`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ parts })
        .expect(200);

      expect(res.body.status).toBe('processing');
      expect(res.body.size_bytes).toBe(totalSize);

      const queue = getVideoProcessingQueue(moduleFixture);
      const job = await queue.getJob(videoJobId(video.id));
      expect(job).toBeDefined();
    }, 30000);

    it('returns 400 VIDEO_UPLOAD_INVALID_PARTS with a wrong etag', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('badetag'),
      );
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: 1024,
      });
      const storageKey = `videos/${video.id}/original.mp4`;
      await uploadPartsDirectly(storageKey, video.upload.upload_id, [1024]);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/complete`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ parts: [{ part_number: 1, etag: '"not-the-real-etag"' }] })
        .expect(400);

      expect(res.body.error).toBe('VIDEO_UPLOAD_INVALID_PARTS');
    }, 30000);

    it('returns 409 VIDEO_INVALID_STATE when completing a video twice', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('doublecomplete'),
      );
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: 1024,
      });
      const storageKey = `videos/${video.id}/original.mp4`;
      const parts = await uploadPartsDirectly(
        storageKey,
        video.upload.upload_id,
        [1024],
      );

      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/complete`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ parts })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/complete`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ parts })
        .expect(409);

      expect(res.body.error).toBe('VIDEO_INVALID_STATE');
    }, 30000);

    it('returns 204 on abort and a subsequent GET returns 404', async () => {
      const session = await registerChannelAndLogin(app, uniqueEmail('abort'));
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: 1024,
      });

      await request(app.getHttpServer())
        .delete(`/videos/${video.public_id}/upload`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(404);
    });
  });

  describe('GET /videos/:publicId', () => {
    it('returns 200 to an anonymous caller for a ready video', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('readanon'),
      );
      const video = await seedReadyVideo(
        dataSource,
        storageService,
        session.channelId,
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(200);

      expect(res.body.public_id).toBe(video.public_id);
      expect(res.body.status).toBe('ready');
      expect(res.body.duration_seconds).toBeCloseTo(2, 0);
      expect(res.body.metadata).toBeDefined();
      expect(res.body.channel.nickname).toBeDefined();
      expect(res.body.processing_error).toBeUndefined();
    }, 30000);

    it('returns 404 to an anonymous caller and 200 to the owner for a processing video', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('readowner'),
      );
      const video = await createDraftVideo(session.accessToken, {
        size_bytes: 1024,
      });
      const storageKey = `videos/${video.id}/original.mp4`;
      const parts = await uploadPartsDirectly(
        storageKey,
        video.upload.upload_id,
        [1024],
      );
      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload/complete`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ parts })
        .expect(200);

      const anonRes = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(404);
      expect(anonRes.body.error).toBe('VIDEO_NOT_FOUND');

      const ownerRes = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      expect(ownerRes.body.status).toBe('processing');
    }, 30000);

    it('returns 404 for a non-existent publicId', async () => {
      await request(app.getHttpServer())
        .get('/videos/doesnotexist1')
        .expect(404);
    });
  });

  describe('stream / download / thumbnail redirects', () => {
    it('stream redirects to a URL that answers Range requests with 206', async () => {
      const session = await registerChannelAndLogin(app, uniqueEmail('stream'));
      const video = await seedReadyVideo(
        dataSource,
        storageService,
        session.channelId,
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .expect(302);

      const location = res.headers.location;
      expect(location).toBeDefined();

      const rangeRes = await fetch(location, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toMatch(/^bytes 0-99\//);
    }, 30000);

    it('download redirects to a URL with Content-Disposition attachment and the original filename', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('download'),
      );
      const video = await seedReadyVideo(
        dataSource,
        storageService,
        session.channelId,
        { originalFilename: 'My Video.mp4' },
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .expect(302);

      const location = res.headers.location;
      const downloadRes = await fetch(location);
      expect(downloadRes.headers.get('content-disposition')).toContain(
        'attachment; filename="My Video.mp4"',
      );
    }, 30000);

    it('thumbnail redirects to a URL that serves the stored JPEG', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('thumbnail'),
      );
      const video = await seedReadyVideo(
        dataSource,
        storageService,
        session.channelId,
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/thumbnail`)
        .expect(302);

      const location = res.headers.location;
      const thumbnailRes = await fetch(location);
      expect(thumbnailRes.status).toBe(200);
      expect(thumbnailRes.headers.get('content-type')).toContain('image/jpeg');
    }, 30000);

    it('returns 404 for a non-existent publicId on stream, download and thumbnail', async () => {
      await request(app.getHttpServer())
        .get('/videos/doesnotexist1/stream')
        .expect(404);
      await request(app.getHttpServer())
        .get('/videos/doesnotexist1/download')
        .expect(404);
      await request(app.getHttpServer())
        .get('/videos/doesnotexist1/thumbnail')
        .expect(404);
    });
  });

  describe('POST /videos/:publicId/processing (reprocess)', () => {
    async function markFailed(videoId: string): Promise<void> {
      await dataSource
        .getRepository(Video)
        .update(
          { id: videoId },
          { status: VideoStatus.FAILED, processing_error: 'ffmpeg exploded' },
        );
    }

    it('returns 202 for a failed video owned by the caller and moves it to processing', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('reprocess'),
      );
      const video = await seedReadyVideo(
        dataSource,
        storageService,
        session.channelId,
      );
      await markFailed(video.id);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/processing`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(202);

      expect(res.body.status).toBe('processing');

      const getRes = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      expect(getRes.body.status).toBe('processing');

      const queue = getVideoProcessingQueue(moduleFixture);
      const job = await queue.getJob(videoJobId(video.id));
      expect(job).toBeDefined();
    }, 30000);

    it('returns 409 VIDEO_INVALID_STATE for a ready video', async () => {
      const session = await registerChannelAndLogin(
        app,
        uniqueEmail('reprocessready'),
      );
      const video = await seedReadyVideo(
        dataSource,
        storageService,
        session.channelId,
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/processing`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_INVALID_STATE');
    }, 30000);

    it('returns 403 VIDEO_FORBIDDEN for a non-owner', async () => {
      const owner = await registerChannelAndLogin(
        app,
        uniqueEmail('reprocessowner'),
      );
      const other = await registerChannelAndLogin(
        app,
        uniqueEmail('reprocessother'),
      );
      const video = await seedReadyVideo(
        dataSource,
        storageService,
        owner.channelId,
      );
      await markFailed(video.id);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/processing`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(403);

      expect(res.body.error).toBe('VIDEO_FORBIDDEN');
    }, 30000);
  });
});
