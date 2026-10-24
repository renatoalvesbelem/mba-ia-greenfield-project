import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import {
  TEST_ENTITIES,
  createTestDataSource,
} from '../test/create-test-data-source';
import { drainQueue, getVideoProcessingQueue } from '../test/queue';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('should compile with ChannelsModule, StorageModule, QueueModule and forFeature([Video])', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(TEST_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module.get(VideosService)).toBeDefined();
    expect(module.get(VideosController)).toBeDefined();

    const queue = getVideoProcessingQueue(module);
    await drainQueue(queue);

    await module.close();
  }, 30000);
});
