import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import {
  FFMPEG_BIN,
  FFPROBE_BIN,
  MEDIA_COMMAND_TIMEOUT_MS,
  MEDIA_MAX_BUFFER_BYTES,
} from './media.constants';
import { MediaProcessingError } from './media.errors';
import type { VideoProbeResult } from './media.types';

const execFile = promisify(execFileCallback);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
  format_name?: string;
  size?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

@Injectable()
export class FfmpegService {
  async probe(inputUrl: string): Promise<VideoProbeResult> {
    const stdout = await this.runText(FFPROBE_BIN, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputUrl,
    ]);

    if (!stdout.trim()) {
      throw new MediaProcessingError('ffprobe returned empty output');
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      throw new MediaProcessingError(
        `ffprobe returned invalid JSON output: ${(error as Error).message}`,
      );
    }

    const format = parsed.format;
    const durationSeconds =
      format?.duration !== undefined ? Number(format.duration) : NaN;

    if (!format || Number.isNaN(durationSeconds)) {
      throw new MediaProcessingError('ffprobe output is missing duration');
    }

    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );

    return {
      duration_seconds: durationSeconds,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      codec: videoStream?.codec_name ?? null,
      bitrate: this.parseNumber(format.bit_rate),
      frame_rate: this.parseFrameRate(videoStream?.r_frame_rate),
      format: format.format_name ?? null,
      size_bytes: this.parseNumber(format.size),
    };
  }

  async captureFrame(
    inputUrl: string,
    atSeconds: number,
    width: number,
  ): Promise<Buffer> {
    const stdout = await this.runBuffer(FFMPEG_BIN, [
      '-v',
      'error',
      '-ss',
      String(atSeconds),
      '-i',
      inputUrl,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2`,
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);

    if (stdout.length === 0) {
      throw new MediaProcessingError('ffmpeg produced an empty frame');
    }

    return stdout;
  }

  private async runText(bin: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFile(bin, args, {
        timeout: MEDIA_COMMAND_TIMEOUT_MS,
        maxBuffer: MEDIA_MAX_BUFFER_BYTES,
      });
      return stdout;
    } catch (error) {
      throw this.toProcessingError(error, bin);
    }
  }

  private async runBuffer(bin: string, args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await execFile(bin, args, {
        timeout: MEDIA_COMMAND_TIMEOUT_MS,
        maxBuffer: MEDIA_MAX_BUFFER_BYTES,
        encoding: 'buffer',
      });
      return stdout;
    } catch (error) {
      throw this.toProcessingError(error, bin);
    }
  }

  private toProcessingError(error: unknown, bin: string): MediaProcessingError {
    if (error instanceof Error) {
      const stderr = this.extractStderr(error);
      const detail = stderr && stderr.trim() ? stderr : error.message;
      return new MediaProcessingError(`${bin} failed: ${detail}`, stderr);
    }
    return new MediaProcessingError(`${bin} failed: ${String(error)}`);
  }

  private extractStderr(error: Error): string | undefined {
    const withStderr = error as Error & { stderr?: string | Buffer };
    if (withStderr.stderr === undefined) {
      return undefined;
    }
    return Buffer.isBuffer(withStderr.stderr)
      ? withStderr.stderr.toString('utf8')
      : withStderr.stderr;
  }

  private parseNumber(value: string | undefined): number | null {
    if (value === undefined) {
      return null;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private parseFrameRate(value: string | undefined): number | null {
    if (!value) {
      return null;
    }
    const [numerator, denominator] = value.split('/').map(Number);
    if (!denominator || Number.isNaN(numerator)) {
      return null;
    }
    return Math.round((numerator / denominator) * 1000) / 1000;
  }
}
