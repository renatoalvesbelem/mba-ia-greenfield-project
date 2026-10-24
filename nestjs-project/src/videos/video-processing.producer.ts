import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
  videoJobId,
} from '../queue/queue.constants';
import { Video } from './entities/video.entity';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueue(video: Video): Promise<void> {
    const jobId = videoJobId(video.id);
    const existingJob = await this.queue.getJob(jobId);
    if (existingJob) {
      await existingJob.remove();
    }

    await this.queue.add(
      PROCESS_VIDEO_JOB,
      {
        videoId: video.id,
        publicId: video.public_id,
        storageKey: video.storage_key,
      },
      { jobId },
    );
  }
}
