export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const PROCESS_VIDEO_JOB = 'process-video';

export function videoJobId(videoId: string): string {
  return `video-${videoId}`;
}

export interface ProcessVideoJobData {
  videoId: string;
  publicId: string;
  storageKey: string;
}
