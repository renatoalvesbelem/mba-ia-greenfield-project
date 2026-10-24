import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import type { JwtPayload } from '../auth/auth.types';
import {
  ChannelNotFoundException,
  VideoForbiddenException,
  VideoInvalidPartNumberException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUnsupportedMediaTypeException,
  VideoUploadInvalidPartsException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { StorageInvalidPartsError } from '../storage/storage.errors';
import {
  fileExtension,
  PUBLIC_ID_MAX_RETRIES,
  videoStoragePrefix,
  videoStorageKey,
} from './videos.constants';
import { generatePublicId } from './public-id.util';
import { Video, VideoMetadata, VideoStatus } from './entities/video.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompletedPartDto } from './dto/complete-upload.dto';
import { VideoProcessingProducer } from './video-processing.producer';

const PUBLIC_ID_COLUMN = 'public_id';

function deriveTitleFromFilename(filename: string): string {
  const extension = fileExtension(filename);
  if (!extension) {
    return filename;
  }
  return filename.slice(0, -(extension.length + 1));
}

function escapeContentDispositionFilename(filename: string): string {
  return filename.replace(/"/g, '\\"');
}

export interface CreateVideoResult {
  id: string;
  public_id: string;
  title: string;
  status: VideoStatus;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  created_at: Date;
  upload: {
    upload_id: string;
    part_size_bytes: number;
    part_count: number;
    part_url_ttl_seconds: number;
  };
}

export interface PartUrlEntry {
  part_number: number;
  url: string;
  expires_at: string;
}

export interface UploadedPartEntry {
  part_number: number;
  etag: string;
  size_bytes: number;
}

export interface CompleteUploadResult {
  id: string;
  public_id: string;
  status: VideoStatus;
  size_bytes: number;
}

export interface ReprocessResult {
  id: string;
  public_id: string;
  status: VideoStatus;
}

export interface VideoViewerResult {
  id: string;
  public_id: string;
  title: string;
  status: VideoStatus;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  metadata: VideoMetadata | null;
  thumbnail_url: string | null;
  processing_error: string | null | undefined;
  created_at: Date;
  processed_at: Date | null;
  channel: { id: string; nickname: string; name: string };
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly processingProducer: VideoProcessingProducer,
    @Inject(videosConfig.KEY)
    private readonly videosCfg: ConfigType<typeof videosConfig>,
  ) {}

  async create(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const allowedContentTypes: readonly string[] =
      this.videosCfg.allowedContentTypes;
    if (!allowedContentTypes.includes(dto.content_type)) {
      throw new VideoUnsupportedMediaTypeException(allowedContentTypes);
    }

    if (dto.size_bytes > this.videosCfg.maxSizeBytes) {
      throw new VideoTooLargeException(this.videosCfg.maxSizeBytes);
    }

    const title = dto.title ?? deriveTitleFromFilename(dto.filename);
    const extension = fileExtension(dto.filename);
    const partCount = Math.ceil(dto.size_bytes / this.videosCfg.partSizeBytes);

    const videoId = randomUUID();
    const storageKey = videoStorageKey(videoId, extension);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    for (let attempt = 0; attempt <= PUBLIC_ID_MAX_RETRIES; attempt++) {
      const publicId = generatePublicId();
      const existing = await this.videoRepository.findOne({
        where: { public_id: publicId },
      });
      if (existing) {
        continue;
      }

      const video = this.videoRepository.create({
        id: videoId,
        channel_id: channel.id,
        public_id: publicId,
        title,
        status: VideoStatus.DRAFT,
        original_filename: dto.filename,
        content_type: dto.content_type,
        size_bytes: dto.size_bytes,
        storage_key: storageKey,
        upload_id: uploadId,
      });

      try {
        const saved = await this.videoRepository.save(video);
        return {
          id: saved.id,
          public_id: saved.public_id,
          title: saved.title,
          status: saved.status,
          original_filename: saved.original_filename,
          content_type: saved.content_type,
          size_bytes: saved.size_bytes,
          created_at: saved.created_at,
          upload: {
            upload_id: uploadId,
            part_size_bytes: this.videosCfg.partSizeBytes,
            part_count: partCount,
            part_url_ttl_seconds: this.videosCfg.partUrlTtlSeconds,
          },
        };
      } catch (err) {
        if (isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('Could not generate a unique public_id after max retries');
  }

  async findOwnedVideo(publicId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoForbiddenException();
    }
    return video;
  }

  assertStatus(video: Video, allowed: VideoStatus[]): void {
    if (!allowed.includes(video.status)) {
      throw new VideoInvalidStateException(video.status, allowed);
    }
  }

  private partCountFor(video: Video): number {
    return Math.ceil(video.size_bytes / this.videosCfg.partSizeBytes);
  }

  async createPartUrls(
    publicId: string,
    userId: string,
    partNumbers: number[],
  ): Promise<{ parts: PartUrlEntry[] }> {
    const video = await this.findOwnedVideo(publicId, userId);
    this.assertStatus(video, [VideoStatus.DRAFT]);

    const partCount = this.partCountFor(video);
    const invalidPartNumber = partNumbers.find(
      (partNumber) => partNumber < 1 || partNumber > partCount,
    );
    if (invalidPartNumber !== undefined) {
      throw new VideoInvalidPartNumberException(partCount);
    }

    const ttlSeconds = this.videosCfg.partUrlTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          video.upload_id as string,
          partNumber,
          ttlSeconds,
        ),
        expires_at: expiresAt,
      })),
    );

    return { parts };
  }

  async listUploadedParts(
    publicId: string,
    userId: string,
  ): Promise<{ parts: UploadedPartEntry[] }> {
    const video = await this.findOwnedVideo(publicId, userId);
    this.assertStatus(video, [VideoStatus.DRAFT]);

    const parts = await this.storageService.listParts(
      video.storage_key,
      video.upload_id as string,
    );

    return {
      parts: [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => ({
          part_number: part.partNumber,
          etag: part.etag,
          size_bytes: part.size,
        })),
    };
  }

  async completeUpload(
    publicId: string,
    userId: string,
    parts: CompletedPartDto[],
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedVideo(publicId, userId);
    this.assertStatus(video, [VideoStatus.DRAFT]);

    const sortedParts = [...parts].sort(
      (a, b) => a.part_number - b.part_number,
    );

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        sortedParts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (err) {
      if (err instanceof StorageInvalidPartsError) {
        throw new VideoUploadInvalidPartsException();
      }
      throw err;
    }

    const { contentLength } = await this.storageService.headObject(
      video.storage_key,
    );

    if (contentLength > this.videosCfg.maxSizeBytes) {
      await this.storageService.deleteByPrefix(videoStoragePrefix(video.id));
      await this.videoRepository.delete({ id: video.id });
      throw new VideoTooLargeException(this.videosCfg.maxSizeBytes);
    }

    video.size_bytes = contentLength;
    video.upload_id = null;
    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    try {
      await this.processingProducer.enqueue(video);
    } catch (err) {
      video.status = VideoStatus.FAILED;
      video.processing_error =
        err instanceof Error ? err.message : 'Failed to enqueue processing';
      await this.videoRepository.save(video);
      throw err;
    }

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
      size_bytes: video.size_bytes,
    };
  }

  async abortUpload(publicId: string, userId: string): Promise<void> {
    const video = await this.findOwnedVideo(publicId, userId);
    this.assertStatus(video, [VideoStatus.DRAFT]);

    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }

    await this.videoRepository.delete({ id: video.id });
  }

  async findForViewer(
    publicId: string,
    viewer: JwtPayload | null,
  ): Promise<VideoViewerResult> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner = viewer !== null && video.channel.user_id === viewer.sub;
    if (video.status !== VideoStatus.READY && !isOwner) {
      throw new VideoNotFoundException();
    }

    return {
      id: video.id,
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      original_filename: video.original_filename,
      content_type: video.content_type,
      size_bytes: video.size_bytes,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnail_url: video.thumbnail_key
        ? `/videos/${video.public_id}/thumbnail`
        : null,
      processing_error: isOwner ? video.processing_error : undefined,
      created_at: video.created_at,
      processed_at: video.processed_at,
      channel: {
        id: video.channel.id,
        nickname: video.channel.nickname,
        name: video.channel.name,
      },
    };
  }

  private async getReadyVideoOrNotFound(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async createPlaybackUrl(publicId: string): Promise<string> {
    const video = await this.getReadyVideoOrNotFound(publicId);
    return this.storageService.presignGetObject(
      video.storage_key,
      this.videosCfg.playbackUrlTtlSeconds,
      { responseContentType: video.content_type },
    );
  }

  async createDownloadUrl(publicId: string): Promise<string> {
    const video = await this.getReadyVideoOrNotFound(publicId);
    return this.storageService.presignGetObject(
      video.storage_key,
      this.videosCfg.playbackUrlTtlSeconds,
      {
        responseContentDisposition: `attachment; filename="${escapeContentDispositionFilename(video.original_filename)}"`,
      },
    );
  }

  async createThumbnailUrl(publicId: string): Promise<string> {
    const video = await this.getReadyVideoOrNotFound(publicId);
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }
    return this.storageService.presignGetObject(
      video.thumbnail_key,
      this.videosCfg.playbackUrlTtlSeconds,
    );
  }

  async reprocess(publicId: string, userId: string): Promise<ReprocessResult> {
    const video = await this.findOwnedVideo(publicId, userId);
    this.assertStatus(video, [VideoStatus.FAILED]);

    video.processing_error = null;
    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    try {
      await this.processingProducer.enqueue(video);
    } catch (err) {
      video.status = VideoStatus.FAILED;
      video.processing_error =
        err instanceof Error ? err.message : 'Failed to enqueue processing';
      await this.videoRepository.save(video);
      throw err;
    }

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
    };
  }
}
