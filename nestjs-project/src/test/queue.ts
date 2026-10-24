import { getQueueToken } from '@nestjs/bullmq';
import { TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';

export function getVideoProcessingQueue(module: TestingModule): Queue {
  return module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
}

export async function drainQueue(queue: Queue): Promise<void> {
  await queue.obliterate({ force: true });
}
