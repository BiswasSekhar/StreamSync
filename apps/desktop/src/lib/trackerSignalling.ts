import {
  DEFAULT_WEBTORRENT_TRACKERS,
  type SignallingMessage,
} from "@streamsync/shared";

const STREAMSYNC_SIGNAL_VERSION = 1;
const PRESENCE_ANNOUNCE_MS = 15_000;
const RECONNECT_DELAY_MS = 4_000;
const MAX_SEEN_SIGNAL_IDS = 4096;

interface TrackerSignalEnvelope {
  streamsync: {
    version: number;
    id: string;
    signal: SignallingMessage & { target?: string };
  };
}

interface TrackerIncomingAnnounce {
  action?: string;
  peer_id?: string;
  offer?: unknown;
  answer?: unknown;
}

interface TrackerSignallingOptions {
  infoHash: string;
  peerId?: string;
  trackerUrls?: string[];
  onSignal: (signal: SignallingMessage, senderPeerId: string) => void | Promise<void>;
  onOpen?: (trackerUrl: string) => void;
  onWarning?: (warning: string) => void;
}

export function normalizeTrackerInfoHash(input: string): string | null {
  const cleaned = input
    .trim()
    .replace(/^tracker:\/\//i, "")
    .replace(/[^a-fA-F0-9]/g, "")
    .toLowerCase();

  return cleaned.length === 40 ? cleaned : null;
}

export function toTrackerRoomUri(infoHash: string): string {
  return `tracker://${infoHash.toLowerCase()}`;
}

function randomHex(bytes = 20): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeSignalId(peerId: string): string {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 11);
  return `${peerId}-${now}-${rand}`;
}

export class TrackerSignallingMesh {
  private readonly infoHash: string;
  private readonly peerId: string;
  private readonly trackerUrls: string[];
  private readonly onSignal: TrackerSignallingOptions["onSignal"];
  private readonly onOpen?: TrackerSignallingOptions["onOpen"];
  private readonly onWarning?: TrackerSignallingOptions["onWarning"];

  private sockets = new Map<string, WebSocket>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private seenSignalIds = new Set<string>();
  private seenSignalOrder: string[] = [];

  constructor(opts: TrackerSignallingOptions) {
    const normalized = normalizeTrackerInfoHash(opts.infoHash);
    if (!normalized) {
      throw new Error(`Invalid tracker info hash: ${opts.infoHash}`);
    }

    this.infoHash = normalized;
    this.peerId = normalizeTrackerInfoHash(opts.peerId ?? "") ?? randomHex(20);
    this.trackerUrls =
      opts.trackerUrls && opts.trackerUrls.length > 0
        ? Array.from(new Set(opts.trackerUrls))
        : Array.from(DEFAULT_WEBTORRENT_TRACKERS);
    this.onSignal = opts.onSignal;
    this.onOpen = opts.onOpen;
    this.onWarning = opts.onWarning;
  }

  getPeerId(): string {
    return this.peerId;
  }

  connect() {
    this.closed = false;
    for (const trackerUrl of this.trackerUrls) {
      this.ensureSocket(trackerUrl);
    }
    if (!this.announceTimer) {
      this.announceTimer = setInterval(() => {
        this.broadcastPresence();
      }, PRESENCE_ANNOUNCE_MS);
    }
  }

  close() {
    this.closed = true;

    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }

    for (const timeout of this.reconnectTimers.values()) {
      clearTimeout(timeout);
    }
    this.reconnectTimers.clear();

    for (const [trackerUrl, socket] of this.sockets) {
      this.sendPresence(socket, trackerUrl, "stopped");
      try {
        socket.close();
      } catch {}
    }
    this.sockets.clear();
  }

  send(signal: SignallingMessage & { target?: string }): boolean {
    let sent = false;
    const signalId = makeSignalId(this.peerId);

    const envelope: TrackerSignalEnvelope = {
      streamsync: {
        version: STREAMSYNC_SIGNAL_VERSION,
        id: signalId,
        signal,
      },
    };

    const announce: Record<string, unknown> = {
      action: "announce",
      info_hash: this.infoHash,
      peer_id: this.peerId,
      uploaded: 0,
      downloaded: 0,
      left: 0,
      numwant: signal.target ? 0 : 1,
      offers: [
        {
          offer_id: signalId,
          offer: envelope,
        },
      ],
    };

    if (signal.target) {
      announce.to_peer_id = normalizeTrackerInfoHash(signal.target) ?? signal.target;
    }

    const payload = JSON.stringify(announce);
    for (const socket of this.sockets.values()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      socket.send(payload);
      sent = true;
    }

    return sent;
  }

  private broadcastPresence() {
    for (const [trackerUrl, socket] of this.sockets) {
      this.sendPresence(socket, trackerUrl);
    }
  }

  private ensureSocket(trackerUrl: string) {
    if (this.closed) return;

    const existing = this.sockets.get(trackerUrl);
    if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) {
      return;
    }

    const pendingReconnect = this.reconnectTimers.get(trackerUrl);
    if (pendingReconnect) {
      clearTimeout(pendingReconnect);
      this.reconnectTimers.delete(trackerUrl);
    }

    const socket = new WebSocket(trackerUrl);
    this.sockets.set(trackerUrl, socket);

    socket.onopen = () => {
      this.sendPresence(socket, trackerUrl, "started");
      this.onOpen?.(trackerUrl);
    };

    socket.onmessage = (event) => {
      this.handleTrackerMessage(event.data);
    };

    socket.onerror = () => {
      this.onWarning?.(`Tracker connection error: ${trackerUrl}`);
    };

    socket.onclose = () => {
      this.sockets.delete(trackerUrl);
      if (!this.closed) {
        const timer = setTimeout(() => {
          this.reconnectTimers.delete(trackerUrl);
          this.ensureSocket(trackerUrl);
        }, RECONNECT_DELAY_MS);
        this.reconnectTimers.set(trackerUrl, timer);
      }
    };
  }

  private sendPresence(
    socket: WebSocket,
    trackerUrl: string,
    event?: "started" | "stopped",
  ) {
    if (socket.readyState !== WebSocket.OPEN) return;

    const payload: Record<string, unknown> = {
      action: "announce",
      info_hash: this.infoHash,
      peer_id: this.peerId,
      uploaded: 0,
      downloaded: 0,
      left: 0,
      numwant: 10,
    };

    if (event) payload.event = event;

    try {
      socket.send(JSON.stringify(payload));
    } catch {
      this.onWarning?.(`Failed to send tracker presence announce: ${trackerUrl}`);
    }
  }

  private handleTrackerMessage(raw: unknown) {
    if (typeof raw !== "string") return;

    let parsed: TrackerIncomingAnnounce;
    try {
      parsed = JSON.parse(raw) as TrackerIncomingAnnounce;
    } catch {
      return;
    }

    if (parsed.action !== "announce") return;

    const senderPeerId = normalizeTrackerInfoHash(parsed.peer_id ?? "");
    if (!senderPeerId || senderPeerId === this.peerId) return;

    this.consumePotentialSignal(parsed.offer, senderPeerId);
    this.consumePotentialSignal(parsed.answer, senderPeerId);
  }

  private consumePotentialSignal(payload: unknown, senderPeerId: string) {
    if (!payload || typeof payload !== "object") return;

    const streamsync = (payload as Partial<TrackerSignalEnvelope>).streamsync;
    if (!streamsync || typeof streamsync !== "object") return;
    if (streamsync.version !== STREAMSYNC_SIGNAL_VERSION) return;
    if (typeof streamsync.id !== "string") return;
    if (!streamsync.signal || typeof streamsync.signal !== "object") return;

    const target = (streamsync.signal as { target?: unknown }).target;
    if (typeof target === "string") {
      const normalizedTarget = normalizeTrackerInfoHash(target);
      if (normalizedTarget && normalizedTarget !== this.peerId) {
        return;
      }
    }

    if (this.isSignalSeen(streamsync.id)) return;
    this.markSignalSeen(streamsync.id);

    Promise.resolve(this.onSignal(streamsync.signal, senderPeerId)).catch((error) => {
      this.onWarning?.(`Tracker signal handler error: ${String(error)}`);
    });
  }

  private isSignalSeen(id: string): boolean {
    return this.seenSignalIds.has(id);
  }

  private markSignalSeen(id: string) {
    this.seenSignalIds.add(id);
    this.seenSignalOrder.push(id);

    if (this.seenSignalOrder.length > MAX_SEEN_SIGNAL_IDS) {
      const dropped = this.seenSignalOrder.shift();
      if (dropped) {
        this.seenSignalIds.delete(dropped);
      }
    }
  }
}
