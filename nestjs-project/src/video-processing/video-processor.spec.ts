import { Job } from 'bullmq';
import { ProcessVideoJobData } from '../queue/queue.constants';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video-processor';

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let videoProcessingService: jest.Mocked<VideoProcessingService>;

  function buildJob(
    overrides: Partial<Job<ProcessVideoJobData>> = {},
  ): Job<ProcessVideoJobData> {
    return {
      data: {
        videoId: 'video-1',
        publicId: 'abcdefghijk',
        storageKey: 'videos/video-1/original.mp4',
      },
      attemptsMade: 1,
      opts: { attempts: 3 },
      ...overrides,
    } as Job<ProcessVideoJobData>;
  }

  beforeEach(() => {
    videoProcessingService = {
      process: jest.fn(),
      markFailed: jest.fn(),
    } as unknown as jest.Mocked<VideoProcessingService>;

    processor = new VideoProcessor(videoProcessingService, {
      workerConcurrency: 2,
    } as never);
  });

  describe('process', () => {
    it('delegates to VideoProcessingService.process with the job videoId', async () => {
      const job = buildJob();

      await processor.process(job);

      expect(videoProcessingService.process).toHaveBeenCalledWith('video-1');
    });

    it('propagates errors thrown by the service', async () => {
      videoProcessingService.process.mockRejectedValue(
        new Error('processing failed'),
      );

      await expect(processor.process(buildJob())).rejects.toThrow(
        'processing failed',
      );
    });
  });

  describe('onFailed', () => {
    it('does nothing when there is no job', async () => {
      await processor.onFailed(undefined, new Error('boom'));

      expect(videoProcessingService.markFailed).not.toHaveBeenCalled();
    });

    it('does not mark as failed before the last attempt', async () => {
      const job = buildJob({ attemptsMade: 1, opts: { attempts: 3 } });

      await processor.onFailed(job, new Error('transient'));

      expect(videoProcessingService.markFailed).not.toHaveBeenCalled();
    });

    it('marks the video as failed on the last attempt', async () => {
      const job = buildJob({ attemptsMade: 3, opts: { attempts: 3 } });

      await processor.onFailed(job, new Error('terminal failure'));

      expect(videoProcessingService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'terminal failure',
      );
    });

    it('defaults to a single attempt when opts.attempts is missing', async () => {
      const job = buildJob({ attemptsMade: 1, opts: {} });

      await processor.onFailed(job, new Error('terminal failure'));

      expect(videoProcessingService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'terminal failure',
      );
    });
  });
});
