import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';

export async function createStorageTestModule(): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  }).compile();

  await module.init();

  return module;
}

export async function uploadTestObject(
  storage: StorageService,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await storage.putObject(key, body, contentType);
}

export async function clearTestPrefix(
  storage: StorageService,
  prefix: string,
): Promise<void> {
  await storage.deleteByPrefix(prefix);
}
