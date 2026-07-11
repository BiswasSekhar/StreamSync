import { SyncController } from "./sync";
import {
  DEFAULT_RTC_CONFIG,
  decodeChunkEnvelope,
  type ChatMessage as SharedChatMessage,
  type PlaybackControlMessage,
  type SignallingMessage,
  type SyncChannelMessage,
  type SyncHeartbeatMessage,
  type SyncMessage,
  type VideoReadyControlMessage,
  type WebRtcChunkErrorMessage,
  type WebRtcChunkRequestMessage,
  type WebRtcChunkResponseMetaMessage,
} from "@streamsync/shared";
import { TrackerSignallingMesh, normalizeTrackerInfoHash } from "./trackerSignalling";

const DEBUG_MEDIA = typeof window !== "undefined" && window.location.protocol.startsWith("http");

export type ChatMessage = SharedChatMessage;

export type VideoReadyInfo = Omit<VideoReadyControlMessage, "type">;

export type ChunkMeta = WebRtcChunkResponseMetaMessage;

/** Result of requesting camera access */
export type CameraPermissionStatus = 'granted' | 'denied' | 'unavailable';


export class JoinWebRTC {
  private pc: RTCPeerConnection | null = null;
  private syncController = new SyncController();
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private chatDc: RTCDataChannel | null = null;
  private syncDcRef: RTCDataChannel | null = null;
  private mediaDcRef: RTCDataChannel | null = null;
  private currentMediaMeta: ChunkMeta | null = null;
  private mediaMetaByChunkId = new Map<number, ChunkMeta>();
  private pendingBinaryByChunkId = new Map<number, ArrayBuffer>();
  private nextChunkId = 0;
  private onMediaDrain: (() => void) | null = null;

  public localStream: MediaStream | null = null;
  private initialOfferResolved = false;
  private hostPeerId: string | null = null;
  private receivedStreamIds = new Set<string>();

  private ws: WebSocket | null = null;
  private trackerSignalling: TrackerSignallingMesh | null = null;
  private wsEndpoint: string | null = null;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private myPeerId: string | null = null;
  private roomId: string | null = null;

  // ICE candidate batching to avoid signalling bursts
  private iceBatchBuffer: RTCIceCandidateInit[] = [];
  private iceBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ICE_BATCH_DELAY = 300; // ms

  // Join-request retry with exponential backoff
  private joinRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private trackerConnectivityTimer: ReturnType<typeof setTimeout> | null = null;
  private joinApproved = false;
  private joinRetryCount = 0;
  private syncHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MIN_RETRY_DELAY = 2_000; // 2s
  private readonly MAX_RETRY_DELAY = 30_000; // 30s
  // Set by close() so a pending async connect() does not send a stale join-request
  // after React StrictMode cleanup has already destroyed this instance.
  private closed = false;

  constructor(
    private onVideoReady: (info: VideoReadyInfo) => void,
    private onSync: (sync: SyncMessage) => void,
    private onChat: (msg: ChatMessage) => void,
    private onConnected: () => void,
    private onDisconnected: () => void,
    private onJoinDenied: (reason: string) => void,
    private onHostEnded: () => void = () => {},
    private onMediaChunk: (data: ArrayBuffer, meta: ChunkMeta) => void = () => {},
    private onCameraStream: (stream: MediaStream | null, status: CameraPermissionStatus) => void = () => {},
    private onRemoteStream: (stream: MediaStream) => void = () => {},
    private onJoinApproved: () => void = () => {},
    private onMediaChunkError: (reqId: string, reason?: string) => void = () => {},
  ) {}

  /**
   * Connect to a room. Sends a join-request to the host and waits for approval.
   * Immediately opens camera so it's ready when the host approves.
   */
  async connect(roomId: string, options?: { trackerUrls?: string[] }): Promise<void> {
    this.closed = false;
    this.joinApproved = false;
    this.joinRetryCount = 0;
    this.hostPeerId = null;
    this.wsEndpoint = null;
    this.wsReconnectAttempts = 0;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.joinRetryTimer) {
      clearTimeout(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }

    const fullUrl = roomId.trim();
    const trackerInfoHash = normalizeTrackerInfoHash(fullUrl);
    if (trackerInfoHash) {
      this.connectViaTracker(trackerInfoHash, options?.trackerUrls);
      return;
    }

    const url = new URL(fullUrl);
    const wsBase = fullUrl.split("?")[0];
    const wsUrl = wsBase
      .replace(/^https:\/\//i, "wss://")
      .replace(/^http:\/\//i, "ws://");
    const wsUrlFixed = wsUrl.endsWith("/") ? wsUrl + "ws" : wsUrl + "/ws";
    this.roomId = (url.searchParams.get("room") ?? "").trim().toUpperCase();

    if (!this.roomId) {
      this.onJoinDenied("Invalid room URL: missing room id.");
      return;
    }

    this.wsEndpoint = wsUrlFixed;
    this.openTunnelWebSocket();
  }

  private openTunnelWebSocket() {
    if (this.closed || !this.wsEndpoint || !this.roomId) return;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ws = new WebSocket(this.wsEndpoint);

    this.ws.onopen = () => {
      this.wsReconnectAttempts = 0;
      this.startPingLoop();
      this.ws?.send(JSON.stringify({
        type: "join",
        room: this.roomId,
        displayName: getDisplayName(),
      }));
    };

    this.ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data) as SignallingMessage & { type: string; peerId?: string; existingPeers?: Array<{ peerId: string }> };
        if (msg.type === "room-joined") {
          this.myPeerId = msg.peerId ?? null;
          const host = (msg.existingPeers ?? [])[0]?.peerId;
          if (host) {
            this.hostPeerId = host;
            if (!this.closed) {
              this.sendSignal({ type: "join-request", displayName: getDisplayName(), target: this.hostPeerId ?? undefined });
              this.startJoinRetry();
            }
          }
          return;
        }
        await this.handleSignal(msg, msg.peerId ?? "");
      } catch (err) {
        console.warn("[JoinWebRTC] Failed to parse signal:", err);
      }
    };

    this.ws.onerror = () => {
      console.warn("[JoinWebRTC] WebSocket signalling connection error");
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      if (this.closed) return;

      const shouldRetry = !this.joinApproved && !this.initialOfferResolved;
      if (!shouldRetry) {
        this.onDisconnected();
        return;
      }

      if (this.wsReconnectTimer) return;
      this.wsReconnectAttempts += 1;
      const delay = Math.min(2_000 * this.wsReconnectAttempts, 10_000);
      console.warn(`[JoinWebRTC] Signalling socket closed; reconnecting in ${delay}ms (attempt ${this.wsReconnectAttempts})`);

      this.wsReconnectTimer = setTimeout(() => {
        this.wsReconnectTimer = null;
        this.openTunnelWebSocket();
      }, delay);
    };
  }

  /**
   * Request camera / mic. Notifies the caller via onCameraStream.
   * Can be called again if the user previously denied and has since granted permission.
   */
  async openCamera(): Promise<MediaStream | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.onCameraStream(stream, 'granted');

      this.localStream = stream;

      // If a PeerConnection already exists, add the tracks now
      if (this.pc) {
        stream.getTracks().forEach((track) => this.pc!.addTrack(track, stream));
        if (this.remoteSet) {
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          if (offer.sdp && this.hostPeerId) {
            this.sendSignal({ type: 'offer', sdp: offer.sdp, target: this.hostPeerId });
          }
        }
      }

      return stream;
    } catch (err: any) {
      // NotAllowedError → denied, anything else → unavailable
      const status: CameraPermissionStatus =
        err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
          ? 'denied'
          : 'unavailable';
      this.onCameraStream(null, status);
      return null;
    }
  }

  // ─── Playback helpers ──────────────────────────────────────────────────────

  applySync(sync: SyncMessage, video: HTMLVideoElement): boolean {
    return this.syncController.applySync(sync, video);
  }

  sendPlaybackControl(action: 'play' | 'pause' | 'seek', position: number) {
    if (this.syncDcRef?.readyState === 'open') {
      const control: PlaybackControlMessage = { type: 'control', action, position };
      this.syncDcRef.send(JSON.stringify(control));
    }
  }

  sendChat(text: string) {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: getDisplayName(),
      text,
      timestamp: Date.now(),
    };
    if (this.chatDc?.readyState === 'open') {
      this.chatDc.send(JSON.stringify(msg));
    }
  }

  close() {
    this.closed = true;
    this.wsEndpoint = null;
    this.wsReconnectAttempts = 0;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.trackerConnectivityTimer) {
      clearTimeout(this.trackerConnectivityTimer);
      this.trackerConnectivityTimer = null;
    }
    // Cancel join retry timer
    if (this.joinRetryTimer) { clearTimeout(this.joinRetryTimer); this.joinRetryTimer = null; }
    // In React StrictMode, an eager cleanup can happen before the real session is
    // established. Avoid sending a stale leave that cancels the surviving join request.
    if (this.hostPeerId || this.initialOfferResolved) {
      this.sendSignal({ type: 'leave', target: this.hostPeerId ?? undefined });
    }
    // Flush any pending ICE candidates
    this.flushIceBatch();
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.trackerSignalling?.close();
    this.trackerSignalling = null;
    this.ws?.close();
    this.ws = null;
    this.pc?.close();
    this.stopSyncHeartbeatLoop();
    this.mediaMetaByChunkId.clear();
    this.pendingBinaryByChunkId.clear();
    this.localStream?.getTracks().forEach((t) => t.stop());
  }

  setOnMediaDrain(handler: (() => void) | null) {
    this.onMediaDrain = handler;
  }

  canRequestChunk(): boolean {
    const dc = this.mediaDcRef;
    if (!dc || dc.readyState !== 'open') return false;
    const lowThreshold = dc.bufferedAmountLowThreshold || 256 * 1024;
    return dc.bufferedAmount <= lowThreshold;
  }

  getMediaBufferedAmount(): number {
    return this.mediaDcRef?.bufferedAmount ?? 0;
  }

  /** Request a byte-range chunk from the host via the media DataChannel */
  requestChunk(start: number, end: number, reqId: string): boolean {
    const dc = this.mediaDcRef;
    if (!dc || dc.readyState !== 'open') return false;

    const lowThreshold = dc.bufferedAmountLowThreshold || 256 * 1024;
    if (dc.bufferedAmount > lowThreshold) {
      return false;
    }

    this.nextChunkId = (this.nextChunkId + 1) >>> 0;
    const msg: WebRtcChunkRequestMessage = {
      type: 'WEBRTC_CHUNK_REQUEST',
      reqId,
      chunkId: this.nextChunkId,
      range: `bytes=${start}-${end}`,
      encoding: 'chunk-id-prefix-v1',
    };

    dc.send(JSON.stringify(msg));
    return true;
  }

  private connectViaTracker(infoHash: string, trackerUrls?: string[]) {
    this.roomId = infoHash.toUpperCase();
    // Hosts advertise with the room hash as their deterministic tracker peer
    // ID. This avoids relying on a tracker to choose the correct random peer.
    this.hostPeerId = infoHash.toLowerCase();
    this.trackerSignalling = new TrackerSignallingMesh({
      infoHash,
      trackerUrls,
      onSignal: (signal, senderPeerId) => this.handleSignal(signal, senderPeerId),
      onOpen: () => {
        if (this.trackerConnectivityTimer) {
          clearTimeout(this.trackerConnectivityTimer);
          this.trackerConnectivityTimer = null;
        }
        if (this.closed || this.joinApproved) return;
        this.sendSignal({ type: "join-request", displayName: getDisplayName(), target: this.hostPeerId ?? undefined });
        if (!this.joinRetryTimer) {
          this.startJoinRetry();
        }
      },
      onWarning: (warning) => {
        console.warn(`[JoinWebRTC] ${warning}`);
      },
    });
    this.myPeerId = this.trackerSignalling.getPeerId();
    this.trackerSignalling.connect();

    if (this.trackerConnectivityTimer) {
      clearTimeout(this.trackerConnectivityTimer);
    }
    this.trackerConnectivityTimer = setTimeout(() => {
      if (!this.trackerSignalling) return;
      if (this.trackerSignalling.getConnectedTrackerCount() > 0) return;
      this.onJoinDenied("No tracker connection established. Ask the host for a Tunnel fallback URL.");
      this.close();
    }, 12_000);
  }

  private startJoinRetry() {
    this.joinRetryTimer = setTimeout(() => {
      if (!this.joinApproved && !this.closed) {
        this.joinRetryCount++;
        // Exponential backoff: 8s, 16s, 24s, 30s (capped)
        const delay = Math.min(
          this.MIN_RETRY_DELAY * this.joinRetryCount,
          this.MAX_RETRY_DELAY
        );
        console.log(`[JoinWebRTC] Retrying join-request (attempt ${this.joinRetryCount}, next retry in ${delay / 1000}s)...`);
        this.sendSignal({ type: 'join-request', displayName: getDisplayName(), target: this.hostPeerId ?? undefined });
        this.joinRetryTimer = setTimeout(() => this.startJoinRetry(), delay);
      }
    }, this.joinRetryCount === 0 ? this.MIN_RETRY_DELAY : 0);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private startPingLoop() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, 5000);
  }

  private sendSignal(msg: SignallingMessage & { target?: string }) {
    if (this.trackerSignalling) {
      this.trackerSignalling.send(msg);
      return;
    }

    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = { ...msg };
    if (payload.target) {
      payload.peerId = payload.target;
      delete payload.target;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private startSyncHeartbeatLoop() {
    if (this.syncHeartbeatInterval) return;
    this.syncHeartbeatInterval = setInterval(() => {
      if (this.syncDcRef?.readyState !== 'open') return;
      const hb: SyncHeartbeatMessage = { type: 'heartbeat', timestamp: Date.now() };
      this.syncDcRef.send(JSON.stringify(hb));
    }, 20_000);
  }

  private stopSyncHeartbeatLoop() {
    if (!this.syncHeartbeatInterval) return;
    clearInterval(this.syncHeartbeatInterval);
    this.syncHeartbeatInterval = null;
  }

  /** Queue an ICE candidate and flush after a short delay */
  private queueIceCandidate(candidate: RTCIceCandidateInit, target: string) {
    this.iceBatchBuffer.push(candidate);
    if (this.iceBatchTimer) clearTimeout(this.iceBatchTimer);
    this.iceBatchTimer = setTimeout(() => this.flushIceBatch(target), this.ICE_BATCH_DELAY);
  }

  /** Send all buffered ICE candidates as a single signalling message */
  private flushIceBatch(target?: string) {
    if (this.iceBatchBuffer.length === 0) return;
    const candidates = [...this.iceBatchBuffer];
    this.iceBatchBuffer = [];
    if (this.iceBatchTimer) { clearTimeout(this.iceBatchTimer); this.iceBatchTimer = null; }
    this.sendSignal({ type: 'ice-candidates', candidates, target: target ?? this.hostPeerId ?? undefined });
  }

  private async handleSignal(msg: SignallingMessage, senderPubkey: string) {
    if (!senderPubkey) return;

    switch (msg.type) {
      case 'peer-joined': {
        if (!this.hostPeerId) {
          this.hostPeerId = msg.peerId || senderPubkey;
        }
        if (!this.hostPeerId || this.joinApproved || this.closed) {
          break;
        }
        this.sendSignal({ type: 'join-request', displayName: getDisplayName(), target: this.hostPeerId });
        if (!this.joinRetryTimer) {
          this.startJoinRetry();
        }
        break;
      }

      case 'join-approved':
        if (!this.hostPeerId) {
          this.hostPeerId = senderPubkey;
        }
        if (this.hostPeerId !== senderPubkey) {
          break;
        }
        console.log('[JoinWebRTC] Admission approved by host');
        this.joinApproved = true;
        this.joinRetryCount = 0; // Reset for future attempts
        if (this.joinRetryTimer) { clearTimeout(this.joinRetryTimer); this.joinRetryTimer = null; }
        this.onJoinApproved();
        break;

      case 'host-ended':
        if (this.hostPeerId && senderPubkey !== this.hostPeerId) {
          break;
        }
        console.log('[JoinWebRTC] Host ended the session');
        this.onHostEnded();
        this.close();
        break;

      case 'join-denied':
        if (this.hostPeerId && senderPubkey !== this.hostPeerId) {
          break;
        }
        console.warn('[JoinWebRTC] Admission denied:', msg.reason);
        this.onJoinDenied(msg.reason ?? 'The host declined your request.');
        this.close();
        break;

      case 'offer':
        if (!this.initialOfferResolved) {
          try {
            await this.handleOffer(msg.sdp, senderPubkey);
            this.initialOfferResolved = true;
          } catch (err) {
            console.error('[JoinWebRTC] Failed to handle offer:', err);
          }
        } else {
          await this.handleReoffer(msg.sdp, senderPubkey);
        }
        break;

      case 'ice-candidate':
        if (senderPubkey === this.hostPeerId) {
          if (this.remoteSet && this.pc) {
            try {
              await this.pc.addIceCandidate(msg.candidate);
            } catch {}
          } else {
            this.pendingCandidates.push(msg.candidate);
          }
        }
        break;

      // Batched ICE candidates from host
      case 'ice-candidates':
        if (senderPubkey === this.hostPeerId && Array.isArray(msg.candidates)) {
          for (const candidate of msg.candidates) {
            if (this.remoteSet && this.pc) {
              try { await this.pc.addIceCandidate(candidate); } catch {}
            } else {
              this.pendingCandidates.push(candidate);
            }
          }
        }
        break;
    }
  }

  private async handleOffer(sdp: string, hostPeerId: string): Promise<void> {
    this.hostPeerId = hostPeerId;

    this.pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);

    this.pc.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (!stream || this.receivedStreamIds.has(stream.id)) return;
      this.receivedStreamIds.add(stream.id);
      this.onRemoteStream(stream);
    };

    // Re-attach existing camera stream if we already have one
    // (camera was opened eagerly before the offer arrived)
    // This is done by onCameraStream callback caller — here we just set up the channel.

    this.pc.ondatachannel = (e) => {
      const dc = e.channel;
      if (dc.label === 'control') {
        dc.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data) as VideoReadyControlMessage;
            if (msg.type === 'video-ready') {
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
      if (dc.label === 'sync') {
        this.syncDcRef = dc;
        dc.onopen = () => this.startSyncHeartbeatLoop();
        dc.onclose = () => this.stopSyncHeartbeatLoop();
        if (dc.readyState === 'open') {
          this.startSyncHeartbeatLoop();
        }
        dc.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data) as SyncChannelMessage;
            if (msg.type === 'sync') {
              this.onSync(msg);
            }
          } catch {}
        };
      }
      if (dc.label === 'chat') {
        this.chatDc = dc;
        dc.onmessage = (ev) => {
          try {
            this.onChat(JSON.parse(ev.data));
          } catch {}
        };
      }
      if (dc.label === 'media') {
        this.mediaDcRef = dc;
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = 256 * 1024;
        dc.onbufferedamountlow = () => {
          if (DEBUG_MEDIA) {
            console.debug('[JoinWebRTC] media dc drained', {
              bufferedAmount: dc.bufferedAmount,
              lowThreshold: dc.bufferedAmountLowThreshold,
            });
          }
          this.onMediaDrain?.();
        };

        dc.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data) as ChunkMeta | WebRtcChunkErrorMessage;
              if (msg.type === 'WEBRTC_CHUNK_RESPONSE') {
                this.currentMediaMeta = msg;
                this.mediaMetaByChunkId.set(msg.chunkId, msg);

                const pendingBinary = this.pendingBinaryByChunkId.get(msg.chunkId);
                if (pendingBinary) {
                  this.pendingBinaryByChunkId.delete(msg.chunkId);
                  this.mediaMetaByChunkId.delete(msg.chunkId);
                  this.onMediaChunk(pendingBinary, msg);
                }
              } else if (msg.type === 'WEBRTC_CHUNK_ERROR') {
                this.onMediaChunkError(msg.reqId, msg.reason);
              }
            } catch {}
          } else if (ev.data instanceof ArrayBuffer) {
            const decoded = decodeChunkEnvelope(ev.data);
            if (decoded) {
              const meta = this.mediaMetaByChunkId.get(decoded.chunkId);
              if (meta) {
                this.mediaMetaByChunkId.delete(decoded.chunkId);
                this.onMediaChunk(decoded.payload, meta);
              } else {
                this.pendingBinaryByChunkId.set(decoded.chunkId, decoded.payload);
              }
              return;
            }

            // Backward compatibility with hosts that still send legacy raw payloads.
            if (this.currentMediaMeta) {
              this.onMediaChunk(ev.data, this.currentMediaMeta);
              this.mediaMetaByChunkId.delete(this.currentMediaMeta.chunkId);
              this.currentMediaMeta = null;
            }
          }
        };
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[JoinWebRTC] Connection state:', this.pc?.connectionState);
      if (this.pc?.connectionState === 'connected') this.onConnected();
      if (this.pc?.connectionState === 'failed') {
        this.onDisconnected();
      }
    };

    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.remoteSet = true;

    for (const c of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {}
    }
    this.pendingCandidates = [];

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (answer.sdp) {
      this.sendSignal({ type: 'answer', sdp: answer.sdp, target: hostPeerId });
    }

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.queueIceCandidate(e.candidate.toJSON(), hostPeerId);
      }
    };
  }

  private async handleReoffer(sdp: string, hostPeerId: string) {
    if (!this.pc || this.hostPeerId !== hostPeerId) return;
    try {
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      if (answer.sdp) {
        this.sendSignal({ type: 'answer', sdp: answer.sdp, target: hostPeerId });
      }
    } catch (err) {
      console.error('[JoinWebRTC] Reoffer handling failed:', err);
    }
  }
}

export function getDisplayName(): string {
  const stored = sessionStorage.getItem('streamsync_name');
  if (stored) return stored;
  const name = `Viewer${Math.floor(Math.random() * 9000) + 1000}`;
  sessionStorage.setItem('streamsync_name', name);
  return name;
}
