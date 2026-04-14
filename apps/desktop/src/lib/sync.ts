export interface SyncMessage {
  type: "sync";
  position: number;
  playing: boolean;
  timestamp: number;
  sequence: number;
}

export class SyncController {
  private clockOffset = 0;
  private lastSyncSeq = -1;
  private playPromise: Promise<void> | null = null;

  updateClockOffset(t1: number, t2: number, t3: number) {
    const rtt = t3 - t1;
    const oneWayDelay = rtt / 2;
    this.clockOffset = t2 - (t1 + oneWayDelay);
  }

  /**
   * Apply a sync message to a video element.
   * Returns true if a programmatic change was made (seek / play / pause).
   * Callers should suppress forwarding their own control events for ~500 ms after a true return.
   */
  applySync(sync: SyncMessage, video: HTMLVideoElement): boolean {
    if (sync.sequence < this.lastSyncSeq) return false;
    this.lastSyncSeq = sync.sequence;

    const now = Date.now();
    const elapsed = (now - sync.timestamp) / 1000;
    // When paused, position isn't advancing — don't add elapsed
    const targetPosition = sync.playing
      ? sync.position + elapsed + this.clockOffset / 1000
      : sync.position;
    const currentPosition = video.currentTime;
    const drift = Math.abs(currentPosition - targetPosition);
    const playStateMismatch = video.paused === sync.playing;

    let changed = false;

    if (drift > 0.3 || playStateMismatch) {
      if (drift > 0.3) {
        video.currentTime = Math.max(0, targetPosition);
        changed = true;
      }
      if (sync.playing && video.paused) {
        // Wait for any pending play promise before trying to play again
        if (this.playPromise) {
          this.playPromise.then(() => {
            if (video.paused) video.play().catch(() => {});
          }).catch(() => {});
        } else {
          this.playPromise = video.play().then(() => {
            this.playPromise = null;
          }).catch((err) => {
            // AbortError is expected when play is interrupted by pause
            if (err?.name !== "AbortError") {
              console.error("[Sync] Play error:", err);
            }
            this.playPromise = null;
          });
        }
        changed = true;
      } else if (!sync.playing && !video.paused) {
        // Always safe to pause immediately
        video.pause();
        changed = true;
      }
    } else if (drift > 0.1) {
      video.playbackRate = currentPosition < targetPosition ? 1.08 : 0.92;
    } else {
      video.playbackRate = 1.0;
    }

    return changed;
  }
}
