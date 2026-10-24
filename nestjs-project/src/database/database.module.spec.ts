import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import databaseConfig from '../config/database.config';
import { DatabaseModule } from './database.module';

describe('DatabaseModule', () => {
  let module: TestingModule;

  afterAll(async () => {
    await module.close();
  });

  it('compiles and exposes a connected DataSource', async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
        DatabaseModule,
      ],
    }).compile();

    const dataSource = module.get(DataSource);

    expect(dataSource).toBeDefined();
    expect(dataSource.isInitialized).toBe(true);
  });
});
