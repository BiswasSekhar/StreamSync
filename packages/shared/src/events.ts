export const TAURI_EVENTS = {
  ENCODE_PROGRESS: "encode-progress",
  ENCODE_COMPLETE: "encode-complete",
  ENCODER_FALLBACK: "encoder-fallback",
  ENCODE_ERROR: "encode-error",
  MAGNET_READY: "magnet-ready",
  TORRENT_VIDEO_READY: "torrent-video-ready",
  TORRENT_PROGRESS: "torrent-progress",
} as const;

export type TauriEventName = (typeof TAURI_EVENTS)[keyof typeof TAURI_EVENTS];
