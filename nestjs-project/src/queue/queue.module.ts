import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: { host: queue.redisHost, port: queue.redisPort },
        prefix: queue.prefix,
      }),
    }),
    BullModule.registerQueueAsync({
      name: VIDEO_PROCESSING_QUEUE,
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        defaultJobOptions: {
          attempts: queue.videoProcessingAttempts,
          backoff: {
            type: 'exponential',
            delay: queue.videoProcessingBackoffMs,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
