export interface SyncMessage {
  type: "sync";
  position: number;
  playing: boolean;
  timestamp: number;
  sequence: number;
}

export class MobileSyncController {
  private clockOffset = 0;
  private lastSyncSeq = -1;

  updateClockOffset(t1: number, t2: number, t3: number) {
    const rtt = t3 - t1;
    this.clockOffset = t2 - (t1 + rtt / 2);
  }

  computeTargetPosition(sync: SyncMessage): { position: number; playing: boolean; valid: boolean } {
    if (sync.sequence <= this.lastSyncSeq) {
      return { position: 0, playing: false, valid: false };
    }
    this.lastSyncSeq = sync.sequence;

    const elapsed = (Date.now() - sync.timestamp) / 1000;
    const position = sync.position + elapsed + this.clockOffset / 1000;

    return { position: Math.max(0, position), playing: sync.playing, valid: true };
  }
}
