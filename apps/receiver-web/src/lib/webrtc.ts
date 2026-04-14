import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, type Filter } from "nostr-tools";
import { SyncController, SyncMessage } from "./sync";

// Relays known to accept ephemeral event kinds (20000-29999).
// SimplePool publishes to all simultaneously — more relays = more resilience.
// DO NOT add relay.primal.net or purplepag.es — they block kind 29999.
const SIGNAL_RELAYS = [
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://nostr.wine",
  "wss://nostr-pub.wellorder.net",
  "wss://relayable.org",
  "wss://nostr.oxtr.dev",
  "wss://relay.nostr.band",
];

interface ChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

export interface VideoReadyInfo {
  fileName: string;
  mimeCodec: string;
  fileSize: number;
  durationSeconds: number;
  /** Magnet link if host is sourcing from a public torrent swarm */
  magnetLink?: string;
}

export interface ChunkMeta {
  type: "WEBRTC_CHUNK_RESPONSE";
  reqId: string;
  size: number;
  contentRange: string;
}

// ── Ephemeral Nostr identity (persisted in sessionStorage for the tab lifetime) ──

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const v = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(v)) return null;
    bytes[i / 2] = v;
  }
  return bytes;
}

function getSessionNostrIdentity() {
  const KEY = "streamsync_nostr_secret:join";
  const stored = sessionStorage.getItem(KEY);
  const parsed = stored ? hexToBytes(stored) : null;
  const secretKey = parsed && parsed.length === 32 ? parsed : generateSecretKey();
  if (!parsed || parsed.length !== 32) {
    sessionStorage.setItem(KEY, bytesToHex(secretKey));
  }
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export class ReceiverWebRTC {
  private pc: RTCPeerConnection | null = null;
  private syncController = new SyncController();
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private chatDc: RTCDataChannel | null = null;
  private syncDcRef: RTCDataChannel | null = null;
  private mediaDcRef: RTCDataChannel | null = null;
  private currentMediaMeta: ChunkMeta | null = null;
  private initialOfferResolved = false;
  private hostPeerId: string | null = null;
  private receivedStreamIds = new Set<string>();

  private pool = new SimplePool();
  private identity = getSessionNostrIdentity();
  private mySecretKey = this.identity.secretKey;
  private myPubkey = this.identity.pubkey;
  private roomId: string | null = null;
  private sub: ReturnType<SimplePool["subscribeMany"]> | null = null;

  // ICE batching to reduce Nostr publish rate
  private iceBatchBuffer: RTCIceCandidateInit[] = [];
  private iceBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ICE_BATCH_DELAY = 300;

  // Join-request retry for race condition where receiver joins before host session is active
  private joinRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private joinApproved = false;

  constructor(
    private onVideoReady: (info: VideoReadyInfo) => void,
    private onSync: (sync: SyncMessage) => void,
    private onChat: (msg: ChatMessage) => void,
    private onPeerJoined: () => void,
    private onDisconnected: () => void,
    private onJoinDenied: (reason: string) => void,
    private onHostEnded: () => void,
    private onMediaChunk: (data: ArrayBuffer, meta: ChunkMeta) => void,
    private onRemoteStream: (stream: MediaStream) => void = () => {},
  ) {}

  connect(roomCode: string): void {
    this.roomId = roomCode.trim().toUpperCase();
    console.log(`[ReceiverWebRTC] Requesting to join room ${this.roomId}`);

    const filter: Filter = {
      kinds: [29999],
      since: Math.floor(Date.now() / 1000) - 5,
    };
    (filter as any)["#h"] = [this.roomId];

    this.sub = this.pool.subscribeMany(SIGNAL_RELAYS, [filter], {
      onevent: async (event) => {
        if (event.pubkey === this.myPubkey) return;
        try {
          const msg = JSON.parse(event.content);
          await this.handleSignal(msg, event.pubkey);
        } catch (err) {
          console.warn("[ReceiverWebRTC] Failed to parse signal:", err);
        }
      },
    });

    this.sendSignal({ type: "join-request", displayName: getDisplayName() });
    this.startJoinRetry();
  }

  requestChunk(start: number, end: number, reqId: string): void {
    if (this.mediaDcRef?.readyState === "open") {
      this.mediaDcRef.send(
        JSON.stringify({ type: "WEBRTC_CHUNK_REQUEST", reqId, range: `bytes=${start}-${end}` })
      );
    }
  }

  applySync(sync: SyncMessage, video: HTMLVideoElement): boolean {
    return this.syncController.applySync(sync, video);
  }

  sendChat(text: string): void {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: getDisplayName(),
      text,
      timestamp: Date.now(),
    };
    if (this.chatDc?.readyState === "open") {
      this.chatDc.send(JSON.stringify(msg));
    }
  }

  close(): void {
    if (this.joinRetryTimer) { clearTimeout(this.joinRetryTimer); this.joinRetryTimer = null; }
    if (this.iceBatchTimer) { clearTimeout(this.iceBatchTimer); this.iceBatchTimer = null; }
    if (this.hostPeerId || this.initialOfferResolved) {
      this.sendSignal({ type: "leave", target: this.hostPeerId });
    }
    if (this.sub) this.sub.close();
    this.pool.destroy();
    this.pc?.close();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private sendSignal(msg: object): void {
    if (!this.roomId) return;
    const eventTemplate = {
      kind: 29999,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", this.roomId]],
      content: JSON.stringify(msg),
    };
    const signed = finalizeEvent(eventTemplate, this.mySecretKey);
    this.pool.publish(SIGNAL_RELAYS, signed).forEach((p) =>
      void p.catch((e: unknown) => console.warn("[ReceiverWebRTC] Publish failed:", e))
    );
  }

  private queueIceCandidate(candidate: RTCIceCandidateInit, target: string): void {
    this.iceBatchBuffer.push(candidate);
    if (this.iceBatchTimer) clearTimeout(this.iceBatchTimer);
    this.iceBatchTimer = setTimeout(() => this.flushIceBatch(target), this.ICE_BATCH_DELAY);
  }

  private flushIceBatch(target?: string): void {
    if (this.iceBatchBuffer.length === 0) return;
    const candidates = [...this.iceBatchBuffer];
    this.iceBatchBuffer = [];
    if (this.iceBatchTimer) { clearTimeout(this.iceBatchTimer); this.iceBatchTimer = null; }
    this.sendSignal({ type: "ice-candidates", candidates, target: target ?? this.hostPeerId });
  }

  private startJoinRetry(): void {
    this.joinRetryTimer = setTimeout(() => {
      if (!this.joinApproved) {
        console.log("[ReceiverWebRTC] Retrying join-request...");
        this.sendSignal({ type: "join-request", displayName: getDisplayName() });
        this.startJoinRetry();
      }
    }, 15_000);
  }

  private async handleSignal(msg: any, senderPubkey: string): Promise<void> {
    if (msg.target && msg.target !== this.myPubkey) return;

    switch (msg.type) {
      case "join-approved":
        console.log("[ReceiverWebRTC] Admission approved");
        this.joinApproved = true;
        if (this.joinRetryTimer) { clearTimeout(this.joinRetryTimer); this.joinRetryTimer = null; }
        break;

      case "join-denied":
        console.warn("[ReceiverWebRTC] Admission denied:", msg.reason);
        this.onJoinDenied(msg.reason ?? "The host declined your request.");
        this.close();
        break;

      case "host-ended":
        console.log("[ReceiverWebRTC] Host ended the session");
        this.onHostEnded();
        this.close();
        break;

      case "offer":
        if (!this.initialOfferResolved) {
          try {
            await this.handleOffer(msg.sdp, senderPubkey);
            this.initialOfferResolved = true;
          } catch (err) {
            console.error("[ReceiverWebRTC] Failed to handle offer:", err);
          }
        } else {
          await this.handleReoffer(msg.sdp, senderPubkey);
        }
        break;

      case "ice-candidate":
        if (senderPubkey === this.hostPeerId) {
          if (this.remoteSet && this.pc) {
            try { await this.pc.addIceCandidate(msg.candidate); } catch {}
          } else {
            this.pendingCandidates.push(msg.candidate);
          }
        }
        break;

      case "ice-candidates":
        if (senderPubkey === this.hostPeerId && Array.isArray(msg.candidates)) {
          for (const c of msg.candidates) {
            if (this.remoteSet && this.pc) {
              try { await this.pc.addIceCandidate(c); } catch {}
            } else {
              this.pendingCandidates.push(c);
            }
          }
        }
        break;
    }
  }

  private async handleOffer(sdp: string, hostPeerId: string): Promise<void> {
    this.hostPeerId = hostPeerId;

    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    this.pc.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (!stream || this.receivedStreamIds.has(stream.id)) return;
      this.receivedStreamIds.add(stream.id);
      this.onRemoteStream(stream);
    };

    // Optional local camera — catch gracefully
    try {
      const localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStream.getTracks().forEach((track) => this.pc!.addTrack(track, localStream));
    } catch { /* camera unavailable or denied */ }

    this.pc.ondatachannel = (e) => {
      const dc = e.channel;

      if (dc.label === "control") {
        dc.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "video-ready") {
              this.onVideoReady({
                fileName: msg.fileName,
                mimeCodec: msg.mimeCodec,
                fileSize: msg.fileSize,
                durationSeconds: msg.durationSeconds,
                magnetLink: msg.magnetLink ?? undefined,
              });
            }
          } catch {}
        };
      }

      if (dc.label === "sync") {
        this.syncDcRef = dc;
        dc.onmessage = (ev) => {
          try { this.onSync(JSON.parse(ev.data)); } catch {}
        };
      }

      if (dc.label === "chat") {
        this.chatDc = dc;
        dc.onmessage = (ev) => {
          try { this.onChat(JSON.parse(ev.data)); } catch {}
        };
      }

      if (dc.label === "media") {
        this.mediaDcRef = dc;
        dc.binaryType = "arraybuffer";
        dc.onmessage = (ev) => {
          if (typeof ev.data === "string") {
            try {
              const meta = JSON.parse(ev.data);
              if (meta.type === "WEBRTC_CHUNK_RESPONSE") {
                this.currentMediaMeta = meta as ChunkMeta;
              }
            } catch {}
          } else if (ev.data instanceof ArrayBuffer) {
            if (this.currentMediaMeta) {
              this.onMediaChunk(ev.data, this.currentMediaMeta);
              this.currentMediaMeta = null;
            }
          }
        };
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log("[ReceiverWebRTC] Connection state:", this.pc?.connectionState);
      if (this.pc?.connectionState === "connected") this.onPeerJoined();
      if (this.pc?.connectionState === "failed") this.onDisconnected();
    };

    await this.pc.setRemoteDescription({ type: "offer", sdp });
    this.remoteSet = true;

    for (const c of this.pendingCandidates) {
      try { await this.pc.addIceCandidate(c); } catch {}
    }
    this.pendingCandidates = [];

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal({ type: "answer", sdp: answer.sdp, target: hostPeerId });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.queueIceCandidate(e.candidate.toJSON(), hostPeerId);
    };
  }

  private async handleReoffer(sdp: string, hostPeerId: string): Promise<void> {
    if (!this.pc || this.hostPeerId !== hostPeerId) return;
    try {
      await this.pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendSignal({ type: "answer", sdp: answer.sdp, target: hostPeerId });
    } catch (err) {
      console.error("[ReceiverWebRTC] Reoffer handling failed:", err);
    }
  }
}

export function getDisplayName(): string {
  const stored = sessionStorage.getItem("streamsync_name");
  if (stored) return stored;
  const name = `Viewer${Math.floor(Math.random() * 9000) + 1000}`;
  sessionStorage.setItem("streamsync_name", name);
  return name;
}
