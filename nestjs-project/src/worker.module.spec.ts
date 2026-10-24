import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { VideoProcessor } from './video-processing/video-processor';
import { VideosController } from './videos/videos.controller';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  let module: TestingModule;

  afterAll(async () => {
    await module.close();
  });

  it('compiles with DatabaseModule and VideoProcessingModule, resolving VideoProcessor', async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(DataSource).isInitialized).toBe(true);
    expect(module.get(VideoProcessor)).toBeDefined();
  }, 30000);

  it('does not register VideosController', () => {
    expect(() => module.get(VideosController, { strict: false })).toThrow();
  });
});
