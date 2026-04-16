import { SyncController, SyncMessage } from "./sync";

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

  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private myPeerId: string | null = null;
  private roomId: string | null = null;

  // ICE batching for websocket signalling
  private iceBatchBuffer: RTCIceCandidateInit[] = [];
  private iceBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ICE_BATCH_DELAY = 300;

  // Join-request retry for race condition where receiver joins before host session is active
  private joinRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private joinApproved = false;
  // Set by close() so a pending connect() does not send a stale join-request after
  // React StrictMode cleanup has already destroyed this instance.
  private closed = false;

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
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${window.location.host}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.startPingLoop();
      this.ws?.send(JSON.stringify({
        type: "join",
        room: this.roomId,
        displayName: getDisplayName(),
      }));
    };

    this.ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "room-joined") {
          this.myPeerId = msg.peerId;
          const host = (msg.existingPeers ?? [])[0]?.peerId;
          if (host) {
            this.hostPeerId = host;
            if (!this.closed) {
              this.sendSignal({ type: "join-request", displayName: getDisplayName(), target: this.hostPeerId });
              this.startJoinRetry();
            }
          }
          return;
        }
        await this.handleSignal(msg, msg.peerId);
      } catch (err) {
        console.warn("[ReceiverWebRTC] Failed to parse signal:", err);
      }
    };

    this.ws.onerror = () => {
      console.warn("[ReceiverWebRTC] WebSocket signalling connection error");
    };

    // Join-request is sent once room-joined arrives and host peer is known.
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
    this.closed = true;
    if (this.joinRetryTimer) { clearTimeout(this.joinRetryTimer); this.joinRetryTimer = null; }
    if (this.iceBatchTimer) { clearTimeout(this.iceBatchTimer); this.iceBatchTimer = null; }
    if (this.hostPeerId || this.initialOfferResolved) {
      this.sendSignal({ type: "leave", target: this.hostPeerId });
    }
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.ws?.close();
    this.ws = null;
    this.pc?.close();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private startPingLoop(): void {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, 5000);
  }

  private sendSignal(msg: Record<string, any>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, any> = { ...msg };
    if (payload.target) {
      payload.peerId = payload.target;
      delete payload.target;
    }
    this.ws.send(JSON.stringify(payload));
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
        this.sendSignal({ type: "join-request", displayName: getDisplayName(), target: this.hostPeerId });
        this.startJoinRetry();
      }
    }, 15_000);
  }

  private async handleSignal(msg: any, senderPubkey: string): Promise<void> {
    if (!senderPubkey) return;

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
