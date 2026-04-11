export interface SyncMessage {
  type: "sync";
  position: number;
  playing: boolean;
  timestamp: number;
  sequence: number;
}

export class SyncController {
  private clockOffset = 0; // ms, receiver relative to host
  private lastSyncSeq = -1;

  updateClockOffset(t1: number, t2: number, t3: number) {
    const rtt = t3 - t1;
    const oneWayDelay = rtt / 2;
    this.clockOffset = t2 - (t1 + oneWayDelay);
  }

  applySync(sync: SyncMessage, video: HTMLVideoElement): void {
    // Discard out-of-order messages
    if (sync.sequence <= this.lastSyncSeq) return;
    this.lastSyncSeq = sync.sequence;

    const now = Date.now();
    const elapsed = (now - sync.timestamp) / 1000;
    const targetPosition = sync.position + elapsed + this.clockOffset / 1000;

    const currentPosition = video.currentTime;
    const drift = Math.abs(currentPosition - targetPosition);

    const playStateMismatch = video.paused === sync.playing;

    if (drift > 0.5 || playStateMismatch) {
      if (drift > 0.5) {
        video.currentTime = Math.max(0, targetPosition);
      }
      if (sync.playing && video.paused) {
        video.play().catch(console.error);
      } else if (!sync.playing && !video.paused) {
        video.pause();
      }
    } else if (drift > 0.1) {
      // Soft correction via playback rate
      const behind = currentPosition < targetPosition;
      video.playbackRate = behind ? 1.05 : 0.95;
    } else {
      video.playbackRate = 1.0;
    }
  }
}
