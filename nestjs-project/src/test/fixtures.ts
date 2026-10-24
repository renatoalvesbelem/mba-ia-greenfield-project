import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  FFMPEG_BIN,
  MEDIA_COMMAND_TIMEOUT_MS,
  MEDIA_MAX_BUFFER_BYTES,
} from '../media/media.constants';

const execFile = promisify(execFileCallback);

export async function createTestVideoFile(
  durationSeconds = 2,
): Promise<string> {
  const filePath = path.join(
    os.tmpdir(),
    `st-media-fixture-${randomUUID()}.mp4`,
  );

  await execFile(
    FFMPEG_BIN,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=320x240:rate=15`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      filePath,
    ],
    {
      timeout: MEDIA_COMMAND_TIMEOUT_MS,
      maxBuffer: MEDIA_MAX_BUFFER_BYTES,
    },
  );

  return filePath;
}

export async function createInvalidMediaFile(): Promise<string> {
  const filePath = path.join(
    os.tmpdir(),
    `st-media-invalid-${randomUUID()}.mp4`,
  );

  await fs.writeFile(filePath, 'this is not a valid media file');

  return filePath;
}

export async function removeTestFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
