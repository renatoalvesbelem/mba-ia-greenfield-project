import { createReadStream, promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import {
  createInvalidMediaFile,
  createTestVideoFile,
  removeTestFile,
} from '../test/fixtures';
import { FfmpegService } from './ffmpeg.service';
import { MediaProcessingError } from './media.errors';
import { MediaModule } from './media.module';

jest.setTimeout(60000);

describe('FfmpegService (integration)', () => {
  let ffmpeg: FfmpegService;
  let videoPath: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();

    ffmpeg = module.get(FfmpegService);
    videoPath = await createTestVideoFile(2);
  });

  afterAll(async () => {
    await removeTestFile(videoPath);
  });

  describe('probe', () => {
    it('extracts metadata from a local MP4 file', async () => {
      const result = await ffmpeg.probe(videoPath);

      expect(result.duration_seconds).toBeGreaterThanOrEqual(1.9);
      expect(result.duration_seconds).toBeLessThanOrEqual(2.1);
      expect(result.width).toBe(320);
      expect(result.height).toBe(240);
      expect(result.codec).toBe('h264');
      expect(typeof result.frame_rate).toBe('number');
      expect(result.format).toEqual(expect.stringContaining('mp4'));
    });

    it('throws MediaProcessingError for a non-existent path', async () => {
      await expect(
        ffmpeg.probe('/tmp/st-media-does-not-exist.mp4'),
      ).rejects.toBeInstanceOf(MediaProcessingError);
    });

    it('throws MediaProcessingError for an invalid media file', async () => {
      const invalidPath = await createInvalidMediaFile();

      try {
        await expect(ffmpeg.probe(invalidPath)).rejects.toBeInstanceOf(
          MediaProcessingError,
        );
      } finally {
        await removeTestFile(invalidPath);
      }
    });
  });

  describe('captureFrame', () => {
    it('returns a JPEG buffer for a local MP4 file', async () => {
      const frame = await ffmpeg.captureFrame(videoPath, 0.5, 320);

      expect(frame.length).toBeGreaterThan(1000);
      expect(frame[0]).toBe(0xff);
      expect(frame[1]).toBe(0xd8);
      expect(frame[2]).toBe(0xff);
    });
  });

  describe('via HTTP URL', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const stats = await fs.stat(videoPath);

      server = createServer((req, res) => {
        const range = req.headers.range;

        if (range) {
          const match = /bytes=(\d+)-(\d*)/.exec(range);
          const start = match ? Number(match[1]) : 0;
          const end = match && match[2] ? Number(match[2]) : stats.size - 1;

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stats.size}`,
            'Content-Length': end - start + 1,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
          });
          createReadStream(videoPath, { start, end }).pipe(res);
          return;
        }

        res.writeHead(200, {
          'Content-Length': stats.size,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
        });
        createReadStream(videoPath).pipe(res);
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });

      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}/video.mp4`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    it('probes a video served over HTTP', async () => {
      const result = await ffmpeg.probe(baseUrl);

      expect(result.duration_seconds).toBeGreaterThanOrEqual(1.9);
      expect(result.width).toBe(320);
    });

    it('captures a frame from a video served over HTTP', async () => {
      const frame = await ffmpeg.captureFrame(baseUrl, 0.5, 320);

      expect(frame[0]).toBe(0xff);
      expect(frame[1]).toBe(0xd8);
      expect(frame[2]).toBe(0xff);
    });
  });
});
