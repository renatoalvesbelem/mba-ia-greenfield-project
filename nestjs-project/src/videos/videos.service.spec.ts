import { QueryFailedError } from 'typeorm';
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
import { StorageInvalidPartsError } from '../storage/storage.errors';
import { videoStoragePrefix } from './videos.constants';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import { generatePublicId } from './public-id.util';

jest.mock('./public-id.util', () => ({
  generatePublicId: jest.fn(),
}));

const mockedGeneratePublicId = generatePublicId as jest.Mock;

const DEFAULT_CONFIG = {
  maxSizeBytes: 10_737_418_240,
  partSizeBytes: 67_108_864,
  partUrlTtlSeconds: 3600,
  playbackUrlTtlSeconds: 3600,
  allowedContentTypes: [
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-matroska',
  ],
};

function makeVideoRepository(overrides: Record<string, jest.Mock> = {}): any {
  return {
    findOne: jest.fn(),
    create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
    save: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  };
}

function makeChannelsService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    findByUserId: jest.fn(),
    ...overrides,
  };
}

function makeStorageService(overrides: Record<string, jest.Mock> = {}): any {
  return {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
    presignUploadPart: jest.fn().mockResolvedValue('https://signed-part-url'),
    listParts: jest.fn().mockResolvedValue([]),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    headObject: jest.fn(),
    deleteByPrefix: jest.fn().mockResolvedValue(undefined),
    presignGetObject: jest.fn().mockResolvedValue('https://signed-get-url'),
    ...overrides,
  };
}

function makeProducer(overrides: Record<string, jest.Mock> = {}): any {
  return {
    enqueue: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeChannel(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'channel-id',
    nickname: 'nick',
    name: 'Name',
    user_id: 'user-id',
    ...overrides,
  };
}

function makeVideo(overrides: Partial<Video> & Record<string, any> = {}): any {
  return {
    id: 'video-id',
    channel_id: 'channel-id',
    public_id: 'AAAAAAAAAAA',
    title: 'Title',
    status: VideoStatus.DRAFT,
    original_filename: 'aula.mp4',
    content_type: 'video/mp4',
    size_bytes: 150_000_000,
    storage_key: 'videos/video-id/original.mp4',
    thumbnail_key: null,
    upload_id: 'upload-id',
    duration_seconds: null,
    metadata: null,
    processing_error: null,
    processed_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    channel: makeChannel(),
    ...overrides,
  };
}

function makeUniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = `Key (${column})=(x) already exists.`;
  return err;
}

function buildService(
  deps: {
    videoRepository?: any;
    channelsService?: any;
    storageService?: any;
    processingProducer?: any;
    config?: any;
  } = {},
): {
  service: VideosService;
  videoRepository: any;
  channelsService: any;
  storageService: any;
  processingProducer: any;
} {
  const videoRepository = deps.videoRepository ?? makeVideoRepository();
  const channelsService = deps.channelsService ?? makeChannelsService();
  const storageService = deps.storageService ?? makeStorageService();
  const processingProducer = deps.processingProducer ?? makeProducer();
  const config = deps.config ?? DEFAULT_CONFIG;

  const service = new VideosService(
    videoRepository,
    channelsService,
    storageService,
    processingProducer,
    config,
  );

  return {
    service,
    videoRepository,
    channelsService,
    storageService,
    processingProducer,
  };
}

describe('VideosService', () => {
  beforeEach(() => {
    mockedGeneratePublicId.mockReset();
    mockedGeneratePublicId.mockReturnValue('AAAAAAAAAAA');
  });

  describe('create', () => {
    const dto = {
      filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 150_000_000,
    };

    it('throws ChannelNotFoundException when the user has no channel', async () => {
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(service.create('user-id', dto)).rejects.toThrow(
        ChannelNotFoundException,
      );
    });

    it('throws VideoUnsupportedMediaTypeException when content_type is not allowed', async () => {
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(makeChannel()),
        }),
      });

      await expect(
        service.create('user-id', { ...dto, content_type: 'application/pdf' }),
      ).rejects.toThrow(VideoUnsupportedMediaTypeException);
    });

    it('throws VideoTooLargeException when size_bytes exceeds the limit', async () => {
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(makeChannel()),
        }),
      });

      await expect(
        service.create('user-id', {
          ...dto,
          size_bytes: DEFAULT_CONFIG.maxSizeBytes + 1,
        }),
      ).rejects.toThrow(VideoTooLargeException);
    });

    it('derives the title from the filename when title is not provided', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(makeChannel()),
        }),
        videoRepository,
      });

      const result = await service.create('user-id', dto);

      expect(result.title).toBe('aula');
    });

    it('uses the provided title when given', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(makeChannel()),
        }),
        videoRepository,
      });

      const result = await service.create('user-id', {
        ...dto,
        title: 'Custom Title',
      });

      expect(result.title).toBe('Custom Title');
    });

    it('rounds part_count up', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(makeChannel()),
        }),
        videoRepository,
      });

      const result = await service.create('user-id', dto);

      expect(result.upload.part_count).toBe(3);
      expect(result.upload.part_size_bytes).toBe(DEFAULT_CONFIG.partSizeBytes);
      expect(result.upload.part_url_ttl_seconds).toBe(
        DEFAULT_CONFIG.partUrlTtlSeconds,
      );
    });

    it('retries public_id generation when the pre-check finds a collision', async () => {
      mockedGeneratePublicId
        .mockReturnValueOnce('AAAAAAAAAAA')
        .mockReturnValueOnce('BBBBBBBBBBB');
      const videoRepository = makeVideoRepository({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(makeVideo())
          .mockResolvedValueOnce(null),
        create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const storageService = makeStorageService();
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(makeChannel()),
        }),
        videoRepository,
        storageService,
      });

      const result = await service.create('user-id', dto);

      expect(result.public_id).toBe('BBBBBBBBBBB');
      expect(videoRepository.findOne).toHaveBeenCalledTimes(2);
      expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('retries public_id generation on a 23505 unique violation from a concurrent insert', async () => {
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueViolation('public_id'))
          .mockImplementationOnce((v: Video) => Promise.resolve(v)),
      });
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(makeChannel()),
        }),
        videoRepository,
      });

      const result = await service.create('user-id', dto);

      expect(result).toBeDefined();
      expect(videoRepository.save).toHaveBeenCalledTimes(2);
    });

    it('re-throws unexpected save errors', async () => {
      const unexpected = new Error('connection lost');
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
        save: jest.fn().mockRejectedValue(unexpected),
      });
      const { service } = buildService({
        channelsService: makeChannelsService({
          findByUserId: jest.fn().mockResolvedValue(makeChannel()),
        }),
        videoRepository,
      });

      await expect(service.create('user-id', dto)).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('findOwnedVideo', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(
        service.findOwnedVideo('publicId', 'user-id'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoForbiddenException when the caller is not the owner', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(
              makeVideo({ channel: makeChannel({ user_id: 'other-user' }) }),
            ),
        }),
      });

      await expect(
        service.findOwnedVideo('publicId', 'user-id'),
      ).rejects.toThrow(VideoForbiddenException);
    });

    it('returns the video when the caller is the owner', async () => {
      const video = makeVideo();
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
      });

      const result = await service.findOwnedVideo('publicId', 'user-id');

      expect(result).toBe(video);
    });
  });

  describe('assertStatus', () => {
    it('does not throw when status is allowed', () => {
      const { service } = buildService();
      expect(() =>
        service.assertStatus(makeVideo({ status: VideoStatus.DRAFT }), [
          VideoStatus.DRAFT,
        ]),
      ).not.toThrow();
    });

    it('throws VideoInvalidStateException when status is not allowed', () => {
      const { service } = buildService();
      expect(() =>
        service.assertStatus(makeVideo({ status: VideoStatus.PROCESSING }), [
          VideoStatus.DRAFT,
        ]),
      ).toThrow(VideoInvalidStateException);
    });
  });

  describe('createPartUrls', () => {
    it('throws VideoInvalidStateException when the video is not draft', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.PROCESSING })),
        }),
      });

      await expect(
        service.createPartUrls('publicId', 'user-id', [1]),
      ).rejects.toThrow(VideoInvalidStateException);
    });

    it('throws VideoInvalidPartNumberException when a part number is out of range', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ size_bytes: 150_000_000 })),
        }),
      });

      await expect(
        service.createPartUrls('publicId', 'user-id', [999]),
      ).rejects.toThrow(VideoInvalidPartNumberException);
    });

    it('returns presigned URLs applying the configured TTL', async () => {
      const storageService = makeStorageService();
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(makeVideo()),
        }),
        storageService,
      });

      const result = await service.createPartUrls(
        'publicId',
        'user-id',
        [1, 2],
      );

      expect(result.parts).toHaveLength(2);
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-id/original.mp4',
        'upload-id',
        1,
        DEFAULT_CONFIG.partUrlTtlSeconds,
      );
      expect(result.parts[0].url).toBe('https://signed-part-url');
      expect(result.parts[0].expires_at).toEqual(expect.any(String));
    });
  });

  describe('listUploadedParts', () => {
    it('throws VideoInvalidStateException when the video is not draft', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.READY })),
        }),
      });

      await expect(
        service.listUploadedParts('publicId', 'user-id'),
      ).rejects.toThrow(VideoInvalidStateException);
    });

    it('returns parts sorted by part_number', async () => {
      const storageService = makeStorageService({
        listParts: jest.fn().mockResolvedValue([
          { partNumber: 2, etag: 'etag-2', size: 20 },
          { partNumber: 1, etag: 'etag-1', size: 10 },
        ]),
      });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(makeVideo()),
        }),
        storageService,
      });

      const result = await service.listUploadedParts('publicId', 'user-id');

      expect(result.parts).toEqual([
        { part_number: 1, etag: 'etag-1', size_bytes: 10 },
        { part_number: 2, etag: 'etag-2', size_bytes: 20 },
      ]);
    });
  });

  describe('completeUpload', () => {
    const parts = [
      { part_number: 2, etag: 'etag-2' },
      { part_number: 1, etag: 'etag-1' },
    ];

    it('throws VideoInvalidStateException when the video is not draft', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.PROCESSING })),
        }),
      });

      await expect(
        service.completeUpload('publicId', 'user-id', parts),
      ).rejects.toThrow(VideoInvalidStateException);
    });

    it('sorts parts by part_number before calling storage', async () => {
      const storageService = makeStorageService({
        headObject: jest.fn().mockResolvedValue({ contentLength: 150_000_000 }),
      });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(makeVideo()),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const { service } = buildService({ videoRepository, storageService });

      await service.completeUpload('publicId', 'user-id', parts);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/original.mp4',
        'upload-id',
        [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ],
      );
    });

    it('maps StorageInvalidPartsError to VideoUploadInvalidPartsException', async () => {
      const storageService = makeStorageService({
        completeMultipartUpload: jest
          .fn()
          .mockRejectedValue(new StorageInvalidPartsError('bad parts')),
      });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(makeVideo()),
        }),
        storageService,
      });

      await expect(
        service.completeUpload('publicId', 'user-id', parts),
      ).rejects.toThrow(VideoUploadInvalidPartsException);
    });

    it('deletes the object and the draft, then throws VideoTooLargeException when the object is too large', async () => {
      const storageService = makeStorageService({
        headObject: jest.fn().mockResolvedValue({
          contentLength: DEFAULT_CONFIG.maxSizeBytes + 1,
        }),
      });
      const video = makeVideo();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service } = buildService({ videoRepository, storageService });

      await expect(
        service.completeUpload('publicId', 'user-id', parts),
      ).rejects.toThrow(VideoTooLargeException);

      expect(storageService.deleteByPrefix).toHaveBeenCalledWith(
        videoStoragePrefix(video.id),
      );
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: video.id });
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('persists the real size, clears upload_id and moves to processing on success', async () => {
      const storageService = makeStorageService({
        headObject: jest.fn().mockResolvedValue({ contentLength: 123 }),
      });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(makeVideo()),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const processingProducer = makeProducer();
      const { service } = buildService({
        videoRepository,
        storageService,
        processingProducer,
      });

      const result = await service.completeUpload('publicId', 'user-id', parts);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.size_bytes).toBe(123);
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          size_bytes: 123,
          upload_id: null,
          status: VideoStatus.PROCESSING,
        }),
      );
      expect(processingProducer.enqueue).toHaveBeenCalledTimes(1);
    });

    it('marks the video failed and re-throws when enqueueing fails', async () => {
      const storageService = makeStorageService({
        headObject: jest.fn().mockResolvedValue({ contentLength: 123 }),
      });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(makeVideo()),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const processingProducer = makeProducer({
        enqueue: jest.fn().mockRejectedValue(new Error('queue down')),
      });
      const { service } = buildService({
        videoRepository,
        storageService,
        processingProducer,
      });

      await expect(
        service.completeUpload('publicId', 'user-id', parts),
      ).rejects.toThrow('queue down');

      expect(videoRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: VideoStatus.FAILED,
          processing_error: 'queue down',
        }),
      );
    });
  });

  describe('abortUpload', () => {
    it('throws VideoInvalidStateException when the video is not draft', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.READY })),
        }),
      });

      await expect(service.abortUpload('publicId', 'user-id')).rejects.toThrow(
        VideoInvalidStateException,
      );
    });

    it('aborts the multipart upload and deletes the draft', async () => {
      const video = makeVideo();
      const storageService = makeStorageService();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service } = buildService({ videoRepository, storageService });

      await service.abortUpload('publicId', 'user-id');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        video.storage_key,
        video.upload_id,
      );
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: video.id });
    });

    it('skips aborting in storage when there is no upload_id', async () => {
      const video = makeVideo({ upload_id: null });
      const storageService = makeStorageService();
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const { service } = buildService({ videoRepository, storageService });

      await service.abortUpload('publicId', 'user-id');

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: video.id });
    });
  });

  describe('findForViewer', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(service.findForViewer('publicId', null)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('allows an anonymous viewer to see a ready video without processing_error', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        processing_error: 'some old error',
      });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
      });

      const result = await service.findForViewer('publicId', null);

      expect(result.status).toBe(VideoStatus.READY);
      expect(result.processing_error).toBeUndefined();
    });

    it('throws VideoNotFoundException for an anonymous viewer on a non-ready video', async () => {
      const video = makeVideo({ status: VideoStatus.PROCESSING });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
      });

      await expect(service.findForViewer('publicId', null)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotFoundException for a non-owner authenticated viewer on a non-ready video', async () => {
      const video = makeVideo({ status: VideoStatus.FAILED });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
      });

      await expect(
        service.findForViewer('publicId', {
          sub: 'other-user',
          email: 'other@example.com',
        }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('lets the owner see any status including processing_error', async () => {
      const video = makeVideo({
        status: VideoStatus.FAILED,
        processing_error: 'ffmpeg exploded',
      });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
      });

      const result = await service.findForViewer('publicId', {
        sub: 'user-id',
        email: 'owner@example.com',
      });

      expect(result.status).toBe(VideoStatus.FAILED);
      expect(result.processing_error).toBe('ffmpeg exploded');
    });

    it('returns thumbnail_url only when thumbnail_key is set', async () => {
      const withThumbnail = makeVideo({
        status: VideoStatus.READY,
        thumbnail_key: 'videos/video-id/thumbnail.jpg',
      });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(withThumbnail),
        }),
      });

      const result = await service.findForViewer('publicId', null);

      expect(result.thumbnail_url).toBe('/videos/AAAAAAAAAAA/thumbnail');
    });
  });

  describe('playback URLs', () => {
    it('throws VideoNotFoundException when the video is not ready', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.DRAFT })),
        }),
      });

      await expect(service.createPlaybackUrl('publicId')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('createPlaybackUrl presigns with responseContentType and no Content-Disposition', async () => {
      const storageService = makeStorageService();
      const video = makeVideo({ status: VideoStatus.READY });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
        storageService,
      });

      await service.createPlaybackUrl('publicId');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        video.storage_key,
        DEFAULT_CONFIG.playbackUrlTtlSeconds,
        { responseContentType: video.content_type },
      );
    });

    it('createDownloadUrl presigns with an escaped Content-Disposition filename', async () => {
      const storageService = makeStorageService();
      const video = makeVideo({
        status: VideoStatus.READY,
        original_filename: 'my "video".mp4',
      });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
        storageService,
      });

      await service.createDownloadUrl('publicId');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        video.storage_key,
        DEFAULT_CONFIG.playbackUrlTtlSeconds,
        {
          responseContentDisposition:
            'attachment; filename="my \\"video\\".mp4"',
        },
      );
    });

    it('createThumbnailUrl throws VideoNotFoundException when there is no thumbnail', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        thumbnail_key: null,
      });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
      });

      await expect(service.createThumbnailUrl('publicId')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('createThumbnailUrl presigns the thumbnail_key', async () => {
      const storageService = makeStorageService();
      const video = makeVideo({
        status: VideoStatus.READY,
        thumbnail_key: 'videos/video-id/thumbnail.jpg',
      });
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest.fn().mockResolvedValue(video),
        }),
        storageService,
      });

      await service.createThumbnailUrl('publicId');

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        video.thumbnail_key,
        DEFAULT_CONFIG.playbackUrlTtlSeconds,
      );
    });
  });

  describe('reprocess', () => {
    it('throws VideoInvalidStateException when the video is not failed', async () => {
      const { service } = buildService({
        videoRepository: makeVideoRepository({
          findOne: jest
            .fn()
            .mockResolvedValue(makeVideo({ status: VideoStatus.READY })),
        }),
      });

      await expect(service.reprocess('publicId', 'user-id')).rejects.toThrow(
        VideoInvalidStateException,
      );
    });

    it('clears the processing error and enqueues the job', async () => {
      const video = makeVideo({
        status: VideoStatus.FAILED,
        processing_error: 'boom',
      });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const processingProducer = makeProducer();
      const { service } = buildService({ videoRepository, processingProducer });

      const result = await service.reprocess('publicId', 'user-id');

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.PROCESSING,
          processing_error: null,
        }),
      );
      expect(processingProducer.enqueue).toHaveBeenCalledTimes(1);
    });

    it('restores the failed status and re-throws when enqueueing fails', async () => {
      const video = makeVideo({ status: VideoStatus.FAILED });
      const videoRepository = makeVideoRepository({
        findOne: jest.fn().mockResolvedValue(video),
        save: jest.fn((v: Video) => Promise.resolve(v)),
      });
      const processingProducer = makeProducer({
        enqueue: jest.fn().mockRejectedValue(new Error('queue down')),
      });
      const { service } = buildService({ videoRepository, processingProducer });

      await expect(service.reprocess('publicId', 'user-id')).rejects.toThrow(
        'queue down',
      );

      expect(videoRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: VideoStatus.FAILED,
          processing_error: 'queue down',
        }),
      );
    });
  });
});
