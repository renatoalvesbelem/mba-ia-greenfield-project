export const PUBLIC_ID_MAX_RETRIES = 5;

export const THUMBNAIL_FILE_NAME = 'thumbnail.jpg';

export const ORIGINAL_FILE_BASENAME = 'original';

export const THUMBNAIL_WIDTH = 640;

export const THUMBNAIL_MAX_OFFSET_SECONDS = 10;

export const THUMBNAIL_OFFSET_RATIO = 0.1;

export const VIDEO_STORAGE_PREFIX = 'videos';

export function videoStoragePrefix(videoId: string): string {
  return `${VIDEO_STORAGE_PREFIX}/${videoId}/`;
}

export function videoStorageKey(videoId: string, extension: string): string {
  const suffix = extension ? `.${extension}` : '';
  return `${videoStoragePrefix(videoId)}${ORIGINAL_FILE_BASENAME}${suffix}`;
}

export function thumbnailStorageKey(videoId: string): string {
  return `${videoStoragePrefix(videoId)}${THUMBNAIL_FILE_NAME}`;
}

export function fileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');

  if (lastDot === -1 || lastDot === filename.length - 1) {
    return '';
  }

  return filename.slice(lastDot + 1).toLowerCase();
}
