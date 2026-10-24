import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { drainQueue, getVideoProcessingQueue } from '../test/queue';
import { QueueModule } from './queue.module';
import { videoJobId } from './queue.constants';

describe('QueueModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
  }, 15000);

  beforeEach(async () => {
    const queue = getVideoProcessingQueue(module);
    await drainQueue(queue);
  });

  afterAll(async () => {
    const queue = getVideoProcessingQueue(module);
    await drainQueue(queue);
    await module.close();
  });

  it('should compile successfully', () => {
    expect(module).toBeDefined();
  });

  it('resolves the video-processing queue with the configured default job options', () => {
    const queue = getVideoProcessingQueue(module);
    const config = queueConfig();

    expect(queue.defaultJobOptions?.attempts).toBe(
      config.videoProcessingAttempts,
    );
    expect(queue.defaultJobOptions?.backoff).toEqual({
      type: 'exponential',
      delay: config.videoProcessingBackoffMs,
    });
  });

  it('uses the test queue prefix', () => {
    const queue = getVideoProcessingQueue(module);

    expect(queue.opts.prefix).toBe(process.env.QUEUE_PREFIX);
  });

  it('deduplicates jobs added twice with the same jobId', async () => {
    const queue = getVideoProcessingQueue(module);
    const jobId = videoJobId('x');
    const data = {
      videoId: 'x',
      publicId: 'public-x',
      storageKey: 'videos/x/original.mp4',
    };

    await queue.add('process-video', data, { jobId });
    await queue.add('process-video', data, { jobId });

    const jobs = await queue.getJobs(['waiting', 'delayed']);
    expect(jobs).toHaveLength(1);
  });
});
