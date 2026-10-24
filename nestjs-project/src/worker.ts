import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ConfigType } from '@nestjs/config';
import queueConfig from './config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue/queue.constants';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  const logger = new Logger('VideoWorker');
  const queue = app.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);

  logger.log(
    `Video worker started: queue="${VIDEO_PROCESSING_QUEUE}" concurrency=${queue.workerConcurrency}`,
  );
}

void bootstrap();
