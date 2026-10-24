import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Repository } from 'typeorm';
import { FfmpegService } from '../media/ffmpeg.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { THUMBNAIL_MAX_OFFSET_SECONDS } from '../videos/videos.constants';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storage: jest.Mocked<StorageService>;
  let ffmpeg: jest.Mocked<FfmpegService>;

  function buildVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      public_id: 'abcdefghijk',
      title: 'My Video',
      status: VideoStatus.PROCESSING,
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 123,
      storage_key: 'videos/video-1/original.mp4',
      thumbnail_key: null,
      upload_id: null,
      duration_seconds: null,
      metadata: null,
      processing_error: null,
      processed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      channel: undefined as never,
      ...overrides,
    };
  }

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            findOneBy: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            presignInternalGetObject: jest.fn(),
            putObject: jest.fn(),
          },
        },
        {
          provide: FfmpegService,
          useValue: {
            probe: jest.fn(),
            captureFrame: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(VideoProcessingService);
    videoRepository = module.get(getRepositoryToken(Video));
    storage = module.get(StorageService);
    ffmpeg = module.get(FfmpegService);
  });

  describe('process', () => {
    it('does nothing when the video does not exist', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await service.process('missing-id');

      expect(storage.presignInternalGetObject).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('does nothing when the video is already ready', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({ status: VideoStatus.READY }),
      );

      await service.process('video-1');

      expect(storage.presignInternalGetObject).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('caps the thumbnail offset at THUMBNAIL_MAX_OFFSET_SECONDS for long videos', async () => {
      videoRepository.findOneBy.mockResolvedValue(buildVideo());
      storage.presignInternalGetObject.mockResolvedValue(
        'https://minio/internal/video.mp4',
      );
      ffmpeg.probe.mockResolvedValue({
        duration_seconds: 3600,
        width: 1920,
        height: 1080,
        codec: 'h264',
        bitrate: 5000,
        frame_rate: 30,
        format: 'mp4',
        size_bytes: 1000,
      });
      ffmpeg.captureFrame.mockResolvedValue(Buffer.from('jpeg'));

      await service.process('video-1');

      expect(ffmpeg.captureFrame).toHaveBeenCalledWith(
        'https://minio/internal/video.mp4',
        THUMBNAIL_MAX_OFFSET_SECONDS,
        expect.any(Number),
      );
    });

    it('uses a proportional offset for short videos', async () => {
      videoRepository.findOneBy.mockResolvedValue(buildVideo());
      storage.presignInternalGetObject.mockResolvedValue(
        'https://minio/internal/video.mp4',
      );
      ffmpeg.probe.mockResolvedValue({
        duration_seconds: 20,
        width: 1920,
        height: 1080,
        codec: 'h264',
        bitrate: 5000,
        frame_rate: 30,
        format: 'mp4',
        size_bytes: 1000,
      });
      ffmpeg.captureFrame.mockResolvedValue(Buffer.from('jpeg'));

      await service.process('video-1');

      expect(ffmpeg.captureFrame).toHaveBeenCalledWith(
        'https://minio/internal/video.mp4',
        2,
        expect.any(Number),
      );
    });

    it('updates the video to ready with metadata and thumbnail key', async () => {
      videoRepository.findOneBy.mockResolvedValue(buildVideo());
      storage.presignInternalGetObject.mockResolvedValue(
        'https://minio/internal/video.mp4',
      );
      ffmpeg.probe.mockResolvedValue({
        duration_seconds: 12.5,
        width: 320,
        height: 240,
        codec: 'h264',
        bitrate: 800,
        frame_rate: 15,
        format: 'mp4',
        size_bytes: 1000,
      });
      ffmpeg.captureFrame.mockResolvedValue(Buffer.from('jpeg'));

      await service.process('video-1');

      expect(storage.putObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        Buffer.from('jpeg'),
        'image/jpeg',
      );
      expect(videoRepository.update).toHaveBeenCalledWith('video-1', {
        duration_seconds: 12.5,
        metadata: {
          width: 320,
          height: 240,
          codec: 'h264',
          bitrate: 800,
          frame_rate: 15,
          format: 'mp4',
        },
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
        status: VideoStatus.READY,
        processed_at: expect.any(Date),
        processing_error: null,
      });
    });

    it('propagates the probe error without changing the video status', async () => {
      videoRepository.findOneBy.mockResolvedValue(buildVideo());
      storage.presignInternalGetObject.mockResolvedValue(
        'https://minio/internal/video.mp4',
      );
      ffmpeg.probe.mockRejectedValue(new Error('ffprobe failed'));

      await expect(service.process('video-1')).rejects.toThrow(
        'ffprobe failed',
      );

      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('markFailed', () => {
    it('sets the status to failed with the processing error', async () => {
      await service.markFailed('video-1', 'boom');

      expect(videoRepository.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.FAILED,
        processing_error: 'boom',
      });
    });
  });
});
