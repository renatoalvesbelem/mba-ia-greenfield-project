import { registerAs } from '@nestjs/config';

export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export type AllowedVideoContentType =
  (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number];

export default registerAs('videos', () => ({
  maxSizeBytes: parseInt(
    process.env.UPLOAD_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '67108864', 10),
  partUrlTtlSeconds: parseInt(
    process.env.UPLOAD_PART_URL_TTL_SECONDS || '3600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.PLAYBACK_URL_TTL_SECONDS || '3600',
    10,
  ),
  allowedContentTypes: ALLOWED_VIDEO_CONTENT_TYPES,
}));
