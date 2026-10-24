import { randomUUID } from 'crypto';
import { TestingModule } from '@nestjs/testing';
import { createStorageTestModule } from '../test/storage';
import { StorageInvalidPartsError } from './storage.errors';
import { StorageService } from './storage.service';

jest.setTimeout(60000);

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const runPrefix = `videos/test-${randomUUID()}`;

  function testKey(name: string): string {
    return `${runPrefix}/${name}`;
  }

  beforeAll(async () => {
    module = await createStorageTestModule();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await storage.deleteByPrefix(`${runPrefix}/`);
    await module.close();
  });

  it('completes a full multipart upload lifecycle', async () => {
    const key = testKey('original.mp4');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const partSizes = [5 * 1024 * 1024, 5 * 1024 * 1024, 1024];
    const parts: { partNumber: number; etag: string }[] = [];

    for (let index = 0; index < partSizes.length; index += 1) {
      const partNumber = index + 1;
      const body = Buffer.alloc(partSizes[index], `${partNumber}`);
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        partNumber,
        3600,
      );
      const response = await fetch(url, { method: 'PUT', body });
      expect(response.status).toBe(200);

      const etag = response.headers.get('etag');
      expect(etag).toBeTruthy();
      parts.push({ partNumber, etag: etag as string });
    }

    const listedParts = await storage.listParts(key, uploadId);
    expect(listedParts).toHaveLength(partSizes.length);
    expect(
      listedParts.map((part) => part.partNumber).sort((a, b) => a - b),
    ).toEqual([1, 2, 3]);
    for (const listedPart of listedParts) {
      const expected = parts.find(
        (p) => p.partNumber === listedPart.partNumber,
      );
      expect(listedPart.etag).toBe(expected?.etag);
    }

    await storage.completeMultipartUpload(key, uploadId, parts);

    const head = await storage.headObject(key);
    const totalSize = partSizes.reduce((sum, size) => sum + size, 0);
    expect(head.contentLength).toBe(totalSize);
  });

  it('completeMultipartUpload with an invalid ETag throws StorageInvalidPartsError', async () => {
    const key = testKey('invalid-parts.mp4');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, 3600);
    await fetch(url, { method: 'PUT', body: Buffer.alloc(1024, 'x') });

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"0000000000000000000000000000000"' },
      ]),
    ).rejects.toThrow(StorageInvalidPartsError);

    await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
  });

  it('abortMultipartUpload removes the uploaded parts', async () => {
    const key = testKey('aborted.mp4');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, 3600);
    await fetch(url, { method: 'PUT', body: Buffer.alloc(1024, 'y') });

    await storage.abortMultipartUpload(key, uploadId);

    let remainingParts: unknown[] | undefined;
    let caughtError: { name?: string } | undefined;
    try {
      remainingParts = await storage.listParts(key, uploadId);
    } catch (error) {
      caughtError = error as { name?: string };
    }

    if (remainingParts !== undefined) {
      expect(remainingParts).toHaveLength(0);
    } else {
      expect(caughtError?.name).toBe('NoSuchUpload');
    }
  });

  it('presignGetObject answers 206 Partial Content to a Range request', async () => {
    const key = testKey('range.bin');
    const body = Buffer.alloc(1000, 'z');
    await storage.putObject(key, body, 'application/octet-stream');

    const url = await storage.presignGetObject(key, 3600);
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99/1000');
  });

  it('presignGetObject honors responseContentDisposition', async () => {
    const key = testKey('download.bin');
    await storage.putObject(key, Buffer.from('hello world'), 'text/plain');

    const url = await storage.presignGetObject(key, 3600, {
      responseContentDisposition: 'attachment; filename="video.mp4"',
    });
    const response = await fetch(url);

    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="video.mp4"',
    );
  });

  it('deleteByPrefix removes every object under the prefix', async () => {
    const prefix = `${runPrefix}/to-delete/`;
    await storage.putObject(
      `${prefix}original.mp4`,
      Buffer.from('a'),
      'video/mp4',
    );
    await storage.putObject(
      `${prefix}thumbnail.jpg`,
      Buffer.from('b'),
      'image/jpeg',
    );

    await storage.deleteByPrefix(prefix);

    await expect(storage.headObject(`${prefix}original.mp4`)).rejects.toThrow();
    await expect(
      storage.headObject(`${prefix}thumbnail.jpg`),
    ).rejects.toThrow();
  });
});

describe('StorageService (integration) — public vs internal endpoint host', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;

  afterEach(() => {
    if (originalPublicEndpoint === undefined) {
      delete process.env.S3_PUBLIC_ENDPOINT;
    } else {
      process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
    }
  });

  it('signs public URLs with the S3_PUBLIC_ENDPOINT host and internal URLs with the S3_ENDPOINT host', async () => {
    process.env.S3_PUBLIC_ENDPOINT = 'http://public.example:9000';

    const module = await createStorageTestModule();
    const scopedStorage = module.get(StorageService);
    const key = `videos/test-${randomUUID()}/host-check.mp4`;

    const publicUrl = await scopedStorage.presignGetObject(key, 3600);
    const internalUrl = await scopedStorage.presignInternalGetObject(key, 3600);

    expect(new URL(publicUrl).host).toBe('public.example:9000');
    expect(new URL(internalUrl).host).toBe(
      new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000').host,
    );

    await module.close();
  });
});
