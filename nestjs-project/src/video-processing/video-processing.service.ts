import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FfmpegService } from '../media/ffmpeg.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  THUMBNAIL_MAX_OFFSET_SECONDS,
  THUMBNAIL_OFFSET_RATIO,
  THUMBNAIL_WIDTH,
  thumbnailStorageKey,
} from '../videos/videos.constants';

const PRESIGNED_INPUT_URL_TTL_SECONDS = 3600;

@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });

    if (!video || video.status === VideoStatus.READY) {
      return;
    }

    const inputUrl = await this.storage.presignInternalGetObject(
      video.storage_key,
      PRESIGNED_INPUT_URL_TTL_SECONDS,
    );

    const probe = await this.ffmpeg.probe(inputUrl);

    const captureAtSeconds = Math.min(
      probe.duration_seconds * THUMBNAIL_OFFSET_RATIO,
      THUMBNAIL_MAX_OFFSET_SECONDS,
    );

    const thumbnail = await this.ffmpeg.captureFrame(
      inputUrl,
      captureAtSeconds,
      THUMBNAIL_WIDTH,
    );

    const thumbnailKey = thumbnailStorageKey(video.id);

    await this.storage.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    await this.videoRepository.update(video.id, {
      duration_seconds: probe.duration_seconds,
      metadata: {
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        bitrate: probe.bitrate,
        frame_rate: probe.frame_rate,
        format: probe.format,
      },
      thumbnail_key: thumbnailKey,
      status: VideoStatus.READY,
      processed_at: new Date(),
      processing_error: null,
    });
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(videoId, {
      status: VideoStatus.FAILED,
      processing_error: reason,
    });
  }
}
