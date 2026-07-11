// WebSocket signalling is handled by the local signaller on port 8787.
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_RTC_CONFIG,
  MAX_VIEWERS_PER_ROOM,
  encodeChunkEnvelope,
  type ChatMessage,
  type JoinRequestSignal,
  type SignallingMessage,
  type SyncChannelMessage,
  type SyncHeartbeatMessage,
  type SyncMessage,
  type VideoReadyControlMessage,
  type WebRtcChunkRequestMessage,
  type WebRtcChunkResponseMetaMessage,
} from "@streamsync/shared";
import { TrackerSignallingMesh, normalizeTrackerInfoHash } from "./trackerSignalling";

export type SyncState = SyncMessage;

export type ChatMsg = ChatMessage;

export type JoinRequest = Pick<JoinRequestSignal, "displayName"> & { peerId: string };

interface PeerChannels {
  pc: RTCPeerConnection;
  controlDc: RTCDataChannel | null;
  syncDc: RTCDataChannel | null;
  chatDc: RTCDataChannel | null;
  mediaDc: RTCDataChannel | null;
  videoTransceiver: RTCRtpTransceiver;
  audioTransceiver: RTCRtpTransceiver;
  remoteSet: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  displayName: string;
  // ICE batching per-peer
  iceBatchBuffer: RTCIceCandidateInit[];
  iceBatchTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_PEERS = MAX_VIEWERS_PER_ROOM;
const ICE_BATCH_DELAY = 300; // ms
const HEARTBEAT_INTERVAL_MS = 20_000;
const PEER_STALE_TIMEOUT_MS = 60_000;

export class HostWebRTC {
  private peers = new Map<string, PeerChannels>();
  private pendingApproval = new Map<string, { displayName: string }>();
  private videoInfo: { fileName: string; mimeCodec: string; fileSize: number; durationSeconds: number; magnetLink?: string; torrentFileId?: number } | null = null;
  private localStream: MediaStream | null = null;
  private peerStreams = new Map<string, MediaStream>();
  private syncSeq = 0;

  private ws: WebSocket | null = null;
  private trackerSignalling: TrackerSignallingMesh | null = null;
  private myPeerId: string | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private staleSweepInterval: ReturnType<typeof setInterval> | null = null;
  private trackerConnectivityTimer: ReturnType<typeof setTimeout> | null = null;
  private peerLastSeenAt = new Map<string, number>();
  private roomId: string | null = null;

  constructor(
    private onPeerJoined: (peerId: string, displayName: string) => void,
    private onPeerLeft: (peerId: string) => void,
    private onChat: (msg: ChatMsg) => void,
    private onError: (err: string) => void,
    private onJoinRequest: (req: JoinRequest) => void,
    private onRemoteStream: (peerId: string, stream: MediaStream) => void = () => {},
    private onPlaybackControl: (action: 'play' | 'pause' | 'seek', position: number, fromPeerId: string) => void = () => {},
  ) {}

  connect(roomId: string, options?: { trackerUrls?: string[] }) {
    const trackerInfoHash = normalizeTrackerInfoHash(roomId);
    if (trackerInfoHash) {
      this.connectViaTracker(trackerInfoHash, options?.trackerUrls);
      return;
    }

    this.roomId = roomId.trim().toUpperCase();
    this.ws = new WebSocket("ws://localhost:8787/ws");

    this.ws.onopen = () => {
      this.startPingLoop();
      this.startPeerHealthLoops();
      this.ws?.send(JSON.stringify({ type: "join", room: this.roomId, displayName: "Host" }));
    };

    this.ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data) as SignallingMessage & { peerId?: string; type: string };
        if (msg.type === "room-joined") {
          this.myPeerId = msg.peerId;
          return;
        }
        await this.handleSignal(msg, msg.peerId ?? "");
      } catch (err) {
        console.error("[HostWebRTC] Failed to parse signal", err);
      }
    };

    this.ws.onerror = () => {
      console.warn("[HostWebRTC] WebSocket signalling connection error");
    };
  }

  /** Host approves a pending join request */
  approvePeer(peerId: string) {
    const info = this.pendingApproval.get(peerId);
    if (!info) return;
    this.pendingApproval.delete(peerId);

    if (this.peers.size >= MAX_PEERS) {
      this.sendSignal({ type: 'join-denied', reason: `Room is full (max ${MAX_PEERS} viewers)`, target: peerId });
      return;
    }

    this.sendSignal({ type: 'join-approved', target: peerId });
    this.markPeerAlive(peerId);
    this.onPeerJoined(peerId, info.displayName);
    this.createOfferForPeer(peerId, info.displayName);
  }

  /** Host denies a pending join request */
  denyPeer(peerId: string) {
    const info = this.pendingApproval.get(peerId);
    if (!info) return;
    this.pendingApproval.delete(peerId);
    this.sendSignal({ type: 'join-denied', reason: 'The host declined your request', target: peerId });
  }

  setVideoReady(fileName: string, mimeCodec: string, fileSize: number, durationSeconds: number, magnetLink?: string, torrentFileId?: number) {
    this.videoInfo = { fileName, mimeCodec, fileSize, durationSeconds, magnetLink, torrentFileId };
    for (const [, peer] of this.peers) {
      this.sendVideoReadyToPeer(peer);
    }
  }

  setLocalStream(stream: MediaStream | null) {
    this.localStream = stream;
    for (const [, peer] of this.peers) {
      this.applyLocalStreamToPeer(peer, stream);
    }
  }

  broadcastSync(position: number, playing: boolean) {
    this.syncSeq++;
    const msg = JSON.stringify({
      type: 'sync',
      position,
      playing,
      timestamp: Date.now(),
      sequence: this.syncSeq,
    });
    for (const [, peer] of this.peers) {
      if (peer.syncDc?.readyState === 'open') peer.syncDc.send(msg);
    }
  }

  broadcastChat(chatMsg: ChatMsg) {
    const json = JSON.stringify(chatMsg);
    for (const [, peer] of this.peers) {
      if (peer.chatDc?.readyState === 'open') peer.chatDc.send(json);
    }
  }

  get peerCount(): number {
    return this.peers.size;
  }

  close() {
    this.sendSignal({ type: 'host-ended', reason: 'session_closed' });
    // Flush all pending ICE batches
    for (const [peerId, peer] of this.peers) {
      this.flushIceBatch(peerId, peer);
    }
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.staleSweepInterval) clearInterval(this.staleSweepInterval);
    if (this.trackerConnectivityTimer) {
      clearTimeout(this.trackerConnectivityTimer);
      this.trackerConnectivityTimer = null;
    }
    this.trackerSignalling?.close();
    this.trackerSignalling = null;
    this.ws?.close();
    this.ws = null;
    for (const [, peer] of this.peers) {
      peer.pc.close();
    }
    this.peers.clear();
    this.peerLastSeenAt.clear();
    this.peerStreams.clear();
    this.localStream?.getTracks().forEach(t => t.stop());
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

  private connectViaTracker(infoHash: string, trackerUrls?: string[]) {
    this.roomId = infoHash.toUpperCase();
    this.trackerSignalling = new TrackerSignallingMesh({
      infoHash,
      // The room's info hash doubles as the host's stable tracker address so
      // guests can send a directed join request immediately.
      peerId: infoHash,
      trackerUrls,
      onSignal: (signal, senderPeerId) => this.handleSignal(signal, senderPeerId),
      onOpen: () => {
        if (this.trackerConnectivityTimer) {
          clearTimeout(this.trackerConnectivityTimer);
          this.trackerConnectivityTimer = null;
        }
        this.startPeerHealthLoops();
      },
      onWarning: (warning) => {
        console.warn(`[HostWebRTC] ${warning}`);
      },
    });
    this.myPeerId = this.trackerSignalling.getPeerId();
    this.startPeerHealthLoops();
    this.trackerSignalling.connect();

    if (this.trackerConnectivityTimer) {
      clearTimeout(this.trackerConnectivityTimer);
    }
    this.trackerConnectivityTimer = setTimeout(() => {
      if (!this.trackerSignalling) return;
      if (this.trackerSignalling.getConnectedTrackerCount() > 0) return;
      this.onError("No tracker connection established. Switch to Tunnel mode from Home and share the fallback URL.");
    }, 12_000);
  }

  private startPeerHealthLoops() {
    if (!this.heartbeatInterval) {
      this.heartbeatInterval = setInterval(() => {
        const heartbeat: SyncHeartbeatMessage = { type: 'heartbeat', timestamp: Date.now() };
        const encoded = JSON.stringify(heartbeat);
        for (const [, peer] of this.peers) {
          if (peer.syncDc?.readyState === 'open') {
            peer.syncDc.send(encoded);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
    }

    if (!this.staleSweepInterval) {
      this.staleSweepInterval = setInterval(() => {
        const now = Date.now();
        for (const [peerId] of this.peers) {
          const seen = this.peerLastSeenAt.get(peerId) ?? 0;
          if (now - seen > PEER_STALE_TIMEOUT_MS) {
            this.cleanupPeer(peerId);
            this.onPeerLeft(peerId);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
    }
  }

  private markPeerAlive(peerId: string) {
    this.peerLastSeenAt.set(peerId, Date.now());
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

  /** Queue an ICE candidate for a peer, flush after a delay */
  private queueIceCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.iceBatchBuffer.push(candidate);
    if (peer.iceBatchTimer) clearTimeout(peer.iceBatchTimer);
    peer.iceBatchTimer = setTimeout(() => this.flushIceBatch(peerId, peer), ICE_BATCH_DELAY);
  }

  /** Send all buffered ICE candidates for a peer as a single message */
  private flushIceBatch(peerId: string, peer: PeerChannels) {
    if (peer.iceBatchBuffer.length === 0) return;
    const candidates = [...peer.iceBatchBuffer];
    peer.iceBatchBuffer = [];
    if (peer.iceBatchTimer) { clearTimeout(peer.iceBatchTimer); peer.iceBatchTimer = null; }
    this.sendSignal({ type: 'ice-candidates', candidates, target: peerId });
  }

  private async handleSignal(msg: SignallingMessage, senderPubkey: string) {
    if (!senderPubkey) return;

    if (this.peers.has(senderPubkey)) {
      this.markPeerAlive(senderPubkey);
    }

    switch (msg.type) {
      case 'join-request': {
        const displayName: string = msg.displayName || 'Viewer';
        console.log(`[HostWebRTC] Join request from ${senderPubkey} (${displayName})`);

        if (this.peers.has(senderPubkey)) {
          return;
        }

        // Auto-deny if room full
        if (this.peers.size >= MAX_PEERS) {
          this.sendSignal({ type: 'join-denied', reason: `Room is full (max ${MAX_PEERS} viewers)`, target: senderPubkey });
          return;
        }

        const alreadyPending = this.pendingApproval.has(senderPubkey);
        this.pendingApproval.set(senderPubkey, { displayName });
        if (!alreadyPending) {
          this.onJoinRequest({ peerId: senderPubkey, displayName });
        }
        break;
      }

      case 'leave':
        this.pendingApproval.delete(senderPubkey);
        this.cleanupPeer(senderPubkey);
        this.onPeerLeft(senderPubkey);
        break;

      case 'answer':
        await this.handleAnswer(senderPubkey, msg.sdp);
        break;

      case 'offer':
        await this.handleIncomingOffer(senderPubkey, msg.sdp);
        break;

      case 'ice-candidate':
        await this.handleIceCandidate(senderPubkey, msg.candidate);
        break;

      // Batched ICE candidates from joiner
      case 'ice-candidates':
        if (Array.isArray(msg.candidates)) {
          for (const candidate of msg.candidates) {
            await this.handleIceCandidate(senderPubkey, candidate);
          }
        }
        break;
    }
  }

  private async createOfferForPeer(peerId: string, displayName: string) {
    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);

    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });

    if (this.localStream) {
      this.applyLocalStreamToTransceivers(pc, videoTransceiver, audioTransceiver, this.localStream);
    }

    for (const [, stream] of this.peerStreams) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    const controlDc = pc.createDataChannel('control', { ordered: true });
    const syncDc = pc.createDataChannel('sync', { ordered: false, maxRetransmits: 0 });
    const chatDc = pc.createDataChannel('chat', { ordered: true });
    const mediaDc = pc.createDataChannel('media', { ordered: true });
    mediaDc.binaryType = 'arraybuffer';

    syncDc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as SyncChannelMessage;
        this.markPeerAlive(peerId);
        if (msg.type === 'control') {
          this.onPlaybackControl(msg.action, msg.position ?? 0, peerId);
        }
      } catch {}
    };

    const peerChannels: PeerChannels = {
      pc, controlDc, syncDc, chatDc, mediaDc,
      videoTransceiver, audioTransceiver,
      remoteSet: false, pendingCandidates: [],
      displayName,
      iceBatchBuffer: [],
      iceBatchTimer: null,
    };
    this.peers.set(peerId, peerChannels);
    this.markPeerAlive(peerId);

    controlDc.onopen = () => this.sendVideoReadyToPeer(peerChannels);
    chatDc.onmessage = (e) => {
      try {
        this.markPeerAlive(peerId);
        this.onChat(JSON.parse(e.data));
      } catch {}
    };

    mediaDc.onmessage = async (e) => {
      try {
        const req = JSON.parse(e.data as string) as WebRtcChunkRequestMessage;
        if (req.type !== 'WEBRTC_CHUNK_REQUEST') return;
        if (typeof req.reqId !== 'string') return;
        this.markPeerAlive(peerId);

        // Back-pressure check: don't queue too much data
        if (mediaDc.bufferedAmount > 16 * 1024 * 1024) {
          mediaDc.send(JSON.stringify({
            type: 'WEBRTC_CHUNK_ERROR',
            reqId: req.reqId,
            chunkId: req.chunkId,
            reason: 'backpressure',
          }));
          return;
        }

        const totalSize = this.videoInfo?.fileSize ?? 0;
        const parsed = parseRangeHeader(req.range ?? '', totalSize);
        if (!parsed) {
          mediaDc.send(JSON.stringify({
            type: 'WEBRTC_CHUNK_ERROR',
            reqId: req.reqId,
            chunkId: req.chunkId,
            reason: 'invalid-range',
          }));
          return;
        }
        const { start, end } = parsed;

        // Read bytes from the host's local video / torrent stream via
        // the Tauri IPC bridge — no HTTP, no localhost, works in pure
        // tracker mode.
        let arrayBuffer: ArrayBuffer;
        try {
          const result = await invoke<ArrayBuffer>('read_video_chunk', { start, end });
          arrayBuffer = result instanceof ArrayBuffer ? result : new Uint8Array(result as ArrayLike<number>).buffer;
        } catch (readErr) {
          console.error('[HostWebRTC] read_video_chunk failed', readErr);
          mediaDc.send(JSON.stringify({
            type: 'WEBRTC_CHUNK_ERROR',
            reqId: req.reqId,
            chunkId: req.chunkId,
            reason: String(readErr),
          }));
          return;
        }

        const hasChunkId = Number.isInteger(req.chunkId) && req.chunkId >= 0;
        const actualEnd = start + arrayBuffer.byteLength - 1;
        const meta: WebRtcChunkResponseMetaMessage = {
          type: 'WEBRTC_CHUNK_RESPONSE',
          reqId: req.reqId,
          chunkId: hasChunkId ? req.chunkId : 0,
          size: arrayBuffer.byteLength,
          contentRange: totalSize > 0
            ? `bytes ${start}-${actualEnd}/${totalSize}`
            : `bytes ${start}-${actualEnd}/*`,
        };

        // Send metadata first, then the binary payload.
        mediaDc.send(JSON.stringify(meta));

        const useEnvelope = req.encoding === 'chunk-id-prefix-v1' && hasChunkId;
        const binaryPayload = useEnvelope
          ? encodeChunkEnvelope(req.chunkId, arrayBuffer)
          : arrayBuffer;
        mediaDc.send(binaryPayload);
      } catch (err) {
        console.error('[HostWebRTC] Failed to handle mediaDc message', err);
      }
    };

    const seenStreams = new Set<string>();
    pc.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (!stream || seenStreams.has(stream.id)) return;
      seenStreams.add(stream.id);

      this.peerStreams.set(peerId, stream);
      this.onRemoteStream(peerId, stream);

      // Relay this peer's stream to all others
      for (const [otherId, otherPeer] of this.peers) {
        if (otherId === peerId) continue;
        stream.getTracks().forEach((track) => otherPeer.pc.addTrack(track, stream));
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.queueIceCandidate(peerId, e.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[HostWebRTC] Peer ${peerId} state: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected') {
        // Attempt ICE restart before giving up — handles brief network blips
        setTimeout(async () => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            try {
              const iceOffer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(iceOffer);
              this.sendSignal({ type: 'offer', sdp: iceOffer.sdp!, target: peerId });
            } catch {
              this.cleanupPeer(peerId);
              this.onPeerLeft(peerId);
            }
          }
        }, 5000);
      }
      if (pc.connectionState === 'failed') {
        this.cleanupPeer(peerId);
        this.onPeerLeft(peerId);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (offer.sdp) {
      this.sendSignal({ type: 'offer', sdp: offer.sdp, target: peerId });
    }

    let renegotiating = false;
    pc.onnegotiationneeded = async () => {
      if (renegotiating || pc.signalingState !== 'stable') return;
      renegotiating = true;
      try {
        const reOffer = await pc.createOffer();
        await pc.setLocalDescription(reOffer);
        if (reOffer.sdp) {
          this.sendSignal({ type: 'offer', sdp: reOffer.sdp, target: peerId });
        }
      } catch (err) {
        console.error('[HostWebRTC] Renegotiation failed:', err);
      } finally {
        renegotiating = false;
      }
    };
  }

  private applyLocalStreamToPeer(peer: PeerChannels, stream: MediaStream | null) {
    if (!stream) {
      peer.videoTransceiver.sender.replaceTrack(null).catch(() => {});
      peer.audioTransceiver.sender.replaceTrack(null).catch(() => {});
      return;
    }
    this.applyLocalStreamToTransceivers(peer.pc, peer.videoTransceiver, peer.audioTransceiver, stream);
  }

  private applyLocalStreamToTransceivers(
    pc: RTCPeerConnection,
    videoTransceiver: RTCRtpTransceiver,
    audioTransceiver: RTCRtpTransceiver,
    stream: MediaStream,
  ) {
    const videoTrack = stream.getVideoTracks()[0] ?? null;
    const audioTrack = stream.getAudioTracks()[0] ?? null;

    if (videoTrack) {
      if (videoTransceiver.sender.track) {
        videoTransceiver.sender.replaceTrack(videoTrack).catch(console.error);
      } else {
        pc.addTrack(videoTrack, stream);
      }
    }
    if (audioTrack) {
      if (audioTransceiver.sender.track) {
        audioTransceiver.sender.replaceTrack(audioTrack).catch(console.error);
      } else {
        pc.addTrack(audioTrack, stream);
      }
    }
  }

  private async handleAnswer(peerId: string, sdp: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp });
      peer.remoteSet = true;
      for (const c of peer.pendingCandidates) {
        try {
          await peer.pc.addIceCandidate(c);
        } catch {}
      }
      peer.pendingCandidates = [];
    } catch (err) {
      console.error(`[HostWebRTC] Failed to set answer for ${peerId}:`, err);
    }
  }

  private async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (peer.remoteSet) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {}
    } else {
      peer.pendingCandidates.push(candidate);
    }
  }

  private async handleIncomingOffer(peerId: string, sdp: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      if (answer.sdp) {
        this.sendSignal({ type: 'answer', sdp: answer.sdp, target: peerId });
      }
    } catch (err) {
      console.error(`[HostWebRTC] Failed to handle offer from ${peerId}:`, err);
    }
  }

  private sendVideoReadyToPeer(peer: PeerChannels) {
    if (!this.videoInfo) return;
    if (peer.controlDc?.readyState === 'open') {
      const ready: VideoReadyControlMessage = {
        type: 'video-ready',
        fileName: this.videoInfo.fileName,
        mimeCodec: this.videoInfo.mimeCodec,
        fileSize: this.videoInfo.fileSize,
        durationSeconds: this.videoInfo.durationSeconds,
        magnetLink: this.videoInfo.magnetLink ?? null,
        torrentFileId: this.videoInfo.torrentFileId ?? null,
      };
      peer.controlDc.send(
        JSON.stringify(ready),
      );
    }
  }

  private cleanupPeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      if (peer.iceBatchTimer) clearTimeout(peer.iceBatchTimer);
      peer.pc.close();
      this.peers.delete(peerId);
    }
    this.peerLastSeenAt.delete(peerId);
    this.peerStreams.delete(peerId);
  }
}

/**
 * Parse an HTTP-style `Range: bytes=N-M` header against a known total size.
 * Matches the semantics of the deleted Axum `parse_range` so receivers
 * built against the old `/host-video` endpoint keep working unchanged.
 * Returns inclusive `{start, end}` or `null` for malformed input.
 */
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
function parseRangeHeader(header: string, totalSize: number): { start: number; end: number } | null {
  if (totalSize > 0) {
    if (!header) {
      return { start: 0, end: Math.max(0, totalSize - 1) };
    }
  } else if (!header) {
    return null;
  }
  const spec = header.startsWith('bytes=') ? header.slice('bytes='.length) : header;
  const [rawStart, rawEnd] = spec.split('-', 2);
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0) return null;
  let end: number;
  if (rawEnd && rawEnd.trim().length > 0) {
    const parsed = Number(rawEnd);
    if (!Number.isFinite(parsed) || parsed < start) return null;
    end = parsed;
  } else {
    end = start + DEFAULT_CHUNK_BYTES - 1;
  }
  if (totalSize > 0) {
    end = Math.min(end, totalSize - 1);
  }
  return { start, end };
}
