import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { Job } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    @Inject(queueConfig.KEY)
    private readonly queue: ConfigType<typeof queueConfig>,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = this.queue.workerConcurrency;
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    await this.videoProcessingService.process(job.data.videoId);
  }

  @OnWorkerEvent('active')
  onActive(job: Job<ProcessVideoJobData>): void {
    this.logger.log(`Started processing video ${job.data.videoId}`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<ProcessVideoJobData>): void {
    this.logger.log(`Finished processing video ${job.data.videoId}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }

    const attempts = job.opts.attempts ?? 1;

    if (job.attemptsMade >= attempts) {
      await this.videoProcessingService.markFailed(
        job.data.videoId,
        error.message,
      );
    }
  }
}
