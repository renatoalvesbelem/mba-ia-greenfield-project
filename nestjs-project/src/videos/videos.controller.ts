import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalUser } from '../auth/decorators/optional-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CreateVideoDto } from './dto/create-video.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import {
  CompleteUploadResult,
  CreateVideoResult,
  PartUrlEntry,
  ReprocessResult,
  UploadedPartEntry,
  VideosService,
  VideoViewerResult,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and start a multipart upload',
    description:
      'Creates the video as a draft linked to the caller channel and opens a multipart upload in storage, returning the parameters the client uses to upload parts directly.',
  })
  @ApiResponse({
    status: 201,
    description: 'Video draft created and multipart upload started',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        original_filename: { type: 'string' },
        content_type: { type: 'string' },
        size_bytes: { type: 'number' },
        created_at: { type: 'string', format: 'date-time' },
        upload: {
          type: 'object',
          properties: {
            upload_id: { type: 'string' },
            part_size_bytes: { type: 'number' },
            part_count: { type: 'number' },
            part_url_ttl_seconds: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'size_bytes exceeds the maximum allowed size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'content_type is not supported',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResult> {
    return this.videosService.create(user.sub, dto);
  }

  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Request presigned upload URLs for multipart parts',
    description:
      'Returns a batch of presigned PUT URLs for the given part numbers of an in-progress multipart upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'number' },
              url: { type: 'string' },
              expires_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createPartUrls(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RequestPartUrlsDto,
  ): Promise<{ parts: PartUrlEntry[] }> {
    return this.videosService.createPartUrls(
      publicId,
      user.sub,
      dto.part_numbers,
    );
  }

  @Get(':publicId/upload/parts')
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'List uploaded multipart parts',
    description:
      'Lists the parts already stored for an in-progress multipart upload, so the client can resume an interrupted upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'number' },
              etag: { type: 'string' },
              size_bytes: { type: 'number' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ parts: UploadedPartEntry[] }> {
    return this.videosService.listUploadedParts(publicId, user.sub);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Complete a multipart upload',
    description:
      'Closes the multipart upload in storage, validates the real object size and enqueues the video for processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video moved to processing',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
        size_bytes: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or storage rejected the parts',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Assembled object exceeds the maximum allowed size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(publicId, user.sub, dto.parts);
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Abort a multipart upload',
    description:
      'Aborts the multipart upload in storage and discards the video draft.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    return this.videosService.abortUpload(publicId, user.sub);
  }

  @Public()
  @Get(':publicId')
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Get video details',
    description:
      'Returns video details. Public for ready videos; the owner can also see videos in any other status, including the processing error.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        original_filename: { type: 'string' },
        content_type: { type: 'string' },
        size_bytes: { type: 'number' },
        duration_seconds: { type: 'number', nullable: true },
        metadata: { type: 'object', nullable: true },
        thumbnail_url: { type: 'string', nullable: true },
        processing_error: { type: 'string', nullable: true },
        created_at: { type: 'string', format: 'date-time' },
        processed_at: { type: 'string', format: 'date-time', nullable: true },
        channel: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            nickname: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or not ready and the caller is not owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param('publicId') publicId: string,
    @OptionalUser() viewer: JwtPayload | null,
  ): Promise<VideoViewerResult> {
    return this.videosService.findForViewer(publicId, viewer);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Redirect to a presigned streaming URL',
    description:
      'Redirects to a presigned GetObject URL for the original video, supporting Range requests for partial content.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned streaming URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.createPlaybackUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Redirect to a presigned download URL',
    description:
      'Redirects to a presigned GetObject URL for the original video with a Content-Disposition attachment header.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.createDownloadUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':publicId/thumbnail')
  @Redirect()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Redirect to a presigned thumbnail URL',
    description:
      'Redirects to a presigned GetObject URL for the video thumbnail image.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned thumbnail URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, not ready, or without a thumbnail',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.createThumbnailUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Post(':publicId/processing')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Reprocess a failed video',
    description:
      'Lets the owner re-enqueue processing for a video stuck in the failed status.',
  })
  @ApiResponse({
    status: 202,
    description: 'Video re-enqueued for processing',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in failed status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async reprocess(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReprocessResult> {
    return this.videosService.reprocess(publicId, user.sub);
  }
}
