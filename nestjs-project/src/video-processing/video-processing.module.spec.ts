import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  TEST_ENTITIES,
  createTestDataSource,
} from '../test/create-test-data-source';
import { drainQueue, getVideoProcessingQueue } from '../test/queue';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video-processor';

describe('VideoProcessingModule', () => {
  it('should compile with QueueModule, StorageModule, MediaModule and forFeature([Video])', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(TEST_ENTITIES).options),
        VideoProcessingModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingService)).toBeDefined();
    expect(module.get(VideoProcessor)).toBeDefined();

    const queue = getVideoProcessingQueue(module);
    await drainQueue(queue);

    await module.close();
  }, 30000);
});
