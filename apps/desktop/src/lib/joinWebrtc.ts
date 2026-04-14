import { SimplePool, finalizeEvent, type Filter } from "nostr-tools";
import { SIGNAL_RELAYS } from "./nostrConfig";
import { SyncController, SyncMessage } from "./sync";
import { getSessionNostrIdentity } from "./nostrIdentity";

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

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
  private currentMediaMeta: any = null;
  private swMessageListener: ((ev: MessageEvent) => void) | null = null;
  
  public localStream: MediaStream | null = null;
  private initialOfferResolved = false;
  private hostPeerId: string | null = null;
  private receivedStreamIds = new Set<string>();

  private pool = new SimplePool();
  private identity = getSessionNostrIdentity("join");
  private mySecretKey = this.identity.secretKey;
  private myPubkey = this.identity.pubkey;
  private roomId: string | null = null;
  private sub: ReturnType<SimplePool['subscribeMany']> | null = null;

  // ICE candidate batching to avoid Nostr rate limits
  private iceBatchBuffer: RTCIceCandidateInit[] = [];
  private iceBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ICE_BATCH_DELAY = 300; // ms

  constructor(
    private onMagnet: (magnet: string, fileName: string, videoUrl: string) => void,
    private onSync: (sync: SyncMessage) => void,
    private onChat: (msg: ChatMessage) => void,
    private onConnected: () => void,
    private onDisconnected: () => void,
    private onJoinDenied: (reason: string) => void,
    private onCameraStream: (stream: MediaStream | null, status: CameraPermissionStatus) => void = () => {},
    private onRemoteStream: (stream: MediaStream) => void = () => {},
  ) {
    this.swMessageListener = (ev: MessageEvent) => {
      if (ev.data && ev.data.type === 'WEBRTC_CHUNK_REQUEST') {
        if (this.mediaDcRef?.readyState === 'open') {
          this.mediaDcRef.send(JSON.stringify(ev.data));
        } else {
          navigator.serviceWorker.controller?.postMessage({ type: 'WEBRTC_CHUNK_ERROR', reqId: ev.data.reqId });
        }
      }
    };
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', this.swMessageListener);
    }
  }

  /**
   * Connect to a room. Sends a join-request to the host and waits for approval.
   * Immediately opens camera so it's ready when the host approves.
   */
  async connect(roomId: string): Promise<void> {
    this.roomId = roomId.trim().toUpperCase();
    console.log(`[JoinWebRTC] Requesting to join room ${this.roomId}`);

    const filter: Filter = {
      kinds: [29999],
      since: Math.floor(Date.now() / 1000) - 5,
    };
    filter['#h'] = [this.roomId!];

    this.sub = this.pool.subscribeMany(
      SIGNAL_RELAYS,
      filter,
      {
        onevent: async (event) => {
          if (event.pubkey === this.myPubkey) return;
          try {
            const msg = JSON.parse(event.content);
            await this.handleSignal(msg, event.pubkey);
          } catch (err) {
            console.warn('[JoinWebRTC] Failed to parse signal:', err);
          }
        },
      },
    );

    // Ask host for admission
    this.sendSignal({ type: 'join-request', displayName: getDisplayName() });
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
          this.sendSignal({ type: 'offer', sdp: offer.sdp, target: this.hostPeerId });
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
      this.syncDcRef.send(JSON.stringify({ type: 'control', action, position }));
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
    // In React StrictMode, an eager cleanup can happen before the real session is
    // established. Avoid sending a stale leave that cancels the surviving join request.
    if (this.hostPeerId || this.initialOfferResolved) {
      this.sendSignal({ type: 'leave', target: this.hostPeerId });
    }
    // Flush any pending ICE candidates
    this.flushIceBatch();
    if (this.sub) this.sub.close();
    this.pool.destroy();
    this.pc?.close();
    this.localStream?.getTracks().forEach((t) => t.stop());
    if (this.swMessageListener && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', this.swMessageListener);
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private sendSignal(msg: object) {
    if (!this.roomId) return;
    const eventTemplate = {
      kind: 29999,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['h', this.roomId]],
      content: JSON.stringify(msg),
    };
    const signed = finalizeEvent(eventTemplate, this.mySecretKey);
    this.pool.publish(SIGNAL_RELAYS, signed).forEach((publishPromise) => {
      void publishPromise.catch((err: unknown) => {
        console.warn("[JoinWebRTC] Failed to publish signal:", err);
      });
    });
  }

  /** Queue an ICE candidate and flush after a short delay */
  private queueIceCandidate(candidate: RTCIceCandidateInit, target: string) {
    this.iceBatchBuffer.push(candidate);
    if (this.iceBatchTimer) clearTimeout(this.iceBatchTimer);
    this.iceBatchTimer = setTimeout(() => this.flushIceBatch(target), this.ICE_BATCH_DELAY);
  }

  /** Send all buffered ICE candidates as a single Nostr message */
  private flushIceBatch(target?: string) {
    if (this.iceBatchBuffer.length === 0) return;
    const candidates = [...this.iceBatchBuffer];
    this.iceBatchBuffer = [];
    if (this.iceBatchTimer) { clearTimeout(this.iceBatchTimer); this.iceBatchTimer = null; }
    this.sendSignal({ type: 'ice-candidates', candidates, target: target ?? this.hostPeerId });
  }

  private async handleSignal(msg: any, senderPubkey: string) {
    if (msg.target && msg.target !== this.myPubkey) return;

    switch (msg.type) {
      case 'join-approved':
        console.log('[JoinWebRTC] Admission approved by host');
        // Host will send an offer next — nothing to do yet
        break;

      case 'join-denied':
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

    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

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
            const msg = JSON.parse(ev.data);
            if (msg.type === 'magnet') {
              this.onMagnet(msg.magnet, msg.fileName || 'video', msg.videoUrl || '');
            }
          } catch {}
        };
      }
      if (dc.label === 'sync') {
        this.syncDcRef = dc;
        dc.onmessage = (ev) => {
          try {
            this.onSync(JSON.parse(ev.data));
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
        dc.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data);
              if (msg.type === 'WEBRTC_CHUNK_RESPONSE' || msg.type === 'WEBRTC_CHUNK_ERROR') {
                this.currentMediaMeta = msg;
                if (msg.type === 'WEBRTC_CHUNK_ERROR') {
                  navigator.serviceWorker.controller?.postMessage(msg);
                }
              }
            } catch {}
          } else if (ev.data instanceof ArrayBuffer) {
             if (this.currentMediaMeta) {
               navigator.serviceWorker.controller?.postMessage({
                 ...this.currentMediaMeta,
                 chunk: ev.data
               }, [ev.data]);
               this.currentMediaMeta = null;
             }
          }
        };
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[JoinWebRTC] Connection state:', this.pc?.connectionState);
      if (this.pc?.connectionState === 'connected') this.onConnected();
      if (
        this.pc?.connectionState === 'disconnected' ||
        this.pc?.connectionState === 'failed'
      ) {
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
    this.sendSignal({ type: 'answer', sdp: answer.sdp, target: hostPeerId });

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
      this.sendSignal({ type: 'answer', sdp: answer.sdp, target: hostPeerId });
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
