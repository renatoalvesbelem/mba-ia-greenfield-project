import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { ConfigType } from '@nestjs/config';
import { Worker } from 'bullmq';
import queueConfig from '../config/queue.config';
import { PROCESS_VIDEO_JOB, videoJobId } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { drainQueue, getVideoProcessingQueue } from '../test/queue';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'producer-video-id',
    channel_id: 'channel-id',
    public_id: 'ZZZZZZZZZZZ',
    title: 'Title',
    status: VideoStatus.PROCESSING,
    original_filename: 'aula.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
    storage_key: 'videos/producer-video-id/original.mp4',
    thumbnail_key: null,
    upload_id: null,
    duration_seconds: null,
    metadata: null,
    processing_error: null,
    processed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as unknown as Video['channel'],
    ...overrides,
  };
}

async function failJobOnce(
  queueCfg: ConfigType<typeof queueConfig>,
  jobId: string,
): Promise<void> {
  const worker = new Worker(
    'video-processing',
    async () => {
      throw new Error('boom');
    },
    {
      connection: { host: queueCfg.redisHost, port: queueCfg.redisPort },
      prefix: queueCfg.prefix,
    },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      worker.on('failed', (job) => {
        if (job?.id === jobId) {
          resolve();
        }
      });
      worker.on('error', reject);
    });
  } finally {
    await worker.close();
  }
}

describe('VideoProcessingProducer (integration)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queueCfg: ConfigType<typeof queueConfig>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    producer = moduleRef.get(VideoProcessingProducer);
    queueCfg = moduleRef.get(queueConfig.KEY);
  }, 30000);

  afterAll(async () => {
    const queue = getVideoProcessingQueue(moduleRef);
    await drainQueue(queue);
    await moduleRef.close();
  });

  beforeEach(async () => {
    const queue = getVideoProcessingQueue(moduleRef);
    await drainQueue(queue);
  });

  it('removes a pre-existing failed job and adds a new waiting job with the same jobId', async () => {
    const video = makeVideo();
    const queue = getVideoProcessingQueue(moduleRef);
    const jobId = videoJobId(video.id);

    await queue.add(
      PROCESS_VIDEO_JOB,
      {
        videoId: video.id,
        publicId: video.public_id,
        storageKey: video.storage_key,
      },
      { jobId, attempts: 1, removeOnFail: false },
    );

    await failJobOnce(queueCfg, jobId);

    const failedBefore = await queue.getJob(jobId);
    expect(failedBefore).toBeDefined();
    expect(await failedBefore!.isFailed()).toBe(true);

    await producer.enqueue(video);

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(await job!.isWaiting()).toBe(true);
    expect(job!.data).toEqual({
      videoId: video.id,
      publicId: video.public_id,
      storageKey: video.storage_key,
    });
  }, 30000);

  it('does not create a second job for the same video when called twice', async () => {
    const video = makeVideo({ id: 'producer-video-dedup' });

    await producer.enqueue(video);
    await producer.enqueue(video);

    const queue = getVideoProcessingQueue(moduleRef);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const matching = jobs.filter((job) => job.id === videoJobId(video.id));
    expect(matching).toHaveLength(1);
  }, 30000);
});
