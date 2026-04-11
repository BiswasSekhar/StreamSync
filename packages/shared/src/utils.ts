import { SyncMessage } from "./types";

export class SyncController {
  private clockOffset = 0; // ms
  private lastSyncSeq = -1;

  updateClockOffset(t1: number, t2: number, t3: number) {
    const rtt = t3 - t1;
    const oneWayDelay = rtt / 2;
    this.clockOffset = t2 - (t1 + oneWayDelay);
  }

  applySync(sync: SyncMessage, video: HTMLVideoElement): void {
    if (sync.sequence <= this.lastSyncSeq) return;
    this.lastSyncSeq = sync.sequence;

    const now = Date.now();
    const elapsed = (now - sync.timestamp) / 1000;
    const targetPosition = sync.position + elapsed + this.clockOffset / 1000;
    const drift = Math.abs(video.currentTime - targetPosition);

    if (drift > 0.5 || video.paused === sync.playing) {
      if (drift > 0.5) video.currentTime = Math.max(0, targetPosition);
      if (sync.playing && video.paused) video.play().catch(console.error);
      else if (!sync.playing && !video.paused) video.pause();
    } else if (drift > 0.1) {
      video.playbackRate = video.currentTime < targetPosition ? 1.05 : 0.95;
    } else {
      video.playbackRate = 1.0;
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
