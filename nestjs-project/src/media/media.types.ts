export interface VideoProbeResult {
  duration_seconds: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  frame_rate: number | null;
  format: string | null;
  size_bytes: number | null;
}
