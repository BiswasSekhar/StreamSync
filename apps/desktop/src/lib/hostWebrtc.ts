// WebSocket signalling is handled by the local signaller on port 8787.

export interface SyncState {
  position: number;
  playing: boolean;
  timestamp: number;
  sequence: number;
}

export interface ChatMsg {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

export interface JoinRequest {
  peerId: string;
  displayName: string;
}

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

const MAX_PEERS = 5;
const ICE_BATCH_DELAY = 300; // ms

export class HostWebRTC {
  private peers = new Map<string, PeerChannels>();
  private pendingApproval = new Map<string, { displayName: string }>();
  private videoInfo: { fileName: string; mimeCodec: string; fileSize: number; durationSeconds: number; magnetLink?: string } | null = null;
  private localStream: MediaStream | null = null;
  private peerStreams = new Map<string, MediaStream>();
  private syncSeq = 0;

  private ws: WebSocket | null = null;
  private myPeerId: string | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
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

  connect(roomId: string) {
    this.roomId = roomId.trim().toUpperCase();
    this.ws = new WebSocket("ws://localhost:8787/ws");

    this.ws.onopen = () => {
      this.startPingLoop();
      this.ws?.send(JSON.stringify({ type: "join", room: this.roomId, displayName: "Host" }));
    };

    this.ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "room-joined") {
          this.myPeerId = msg.peerId;
          return;
        }
        await this.handleSignal(msg, msg.peerId);
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
      this.sendSignal({ type: 'join-denied', reason: 'Room is full (max 5 viewers)', target: peerId });
      return;
    }

    this.sendSignal({ type: 'join-approved', target: peerId });
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

  setVideoReady(fileName: string, mimeCodec: string, fileSize: number, durationSeconds: number, magnetLink?: string) {
    this.videoInfo = { fileName, mimeCodec, fileSize, durationSeconds, magnetLink };
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
    this.ws?.close();
    this.ws = null;
    for (const [, peer] of this.peers) {
      peer.pc.close();
    }
    this.peers.clear();
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

  private sendSignal(msg: Record<string, any>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, any> = { ...msg };
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

  private async handleSignal(msg: any, senderPubkey: string) {
    if (!senderPubkey) return;

    switch (msg.type) {
      case 'join-request': {
        const displayName: string = msg.displayName || 'Viewer';
        console.log(`[HostWebRTC] Join request from ${senderPubkey} (${displayName})`);

        if (this.peers.has(senderPubkey)) {
          return;
        }

        // Auto-deny if room full
        if (this.peers.size >= MAX_PEERS) {
          this.sendSignal({ type: 'join-denied', reason: 'Room is full (max 5 viewers)', target: senderPubkey });
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
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

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
        const msg = JSON.parse(e.data);
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

    controlDc.onopen = () => this.sendVideoReadyToPeer(peerChannels);
    chatDc.onmessage = (e) => {
      try {
        this.onChat(JSON.parse(e.data));
      } catch {}
    };

    mediaDc.onmessage = async (e) => {
      try {
        const req = JSON.parse(e.data as string);
        if (req.type !== 'WEBRTC_CHUNK_REQUEST') return;

        // Back-pressure check: don't queue too much data
        if (mediaDc.bufferedAmount > 16 * 1024 * 1024) {
          mediaDc.send(JSON.stringify({ type: 'WEBRTC_CHUNK_ERROR', reqId: req.reqId, reason: 'backpressure' }));
          return;
        }

        const headers: HeadersInit = req.range ? { 'Range': req.range } : {};
        const response = await fetch('http://localhost:8787/host-video', { headers });
        if (!response.ok && response.status !== 206) {
          mediaDc.send(JSON.stringify({ type: 'WEBRTC_CHUNK_ERROR', reqId: req.reqId }));
          return;
        }

        const arrayBuffer = await response.arrayBuffer();
        // Send metadata first, then binary — receiver correlates by order
        mediaDc.send(JSON.stringify({
          type: 'WEBRTC_CHUNK_RESPONSE',
          reqId: req.reqId,
          size: arrayBuffer.byteLength,
          contentRange: response.headers.get('Content-Range') ?? '',
        }));
        mediaDc.send(arrayBuffer);
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
    this.sendSignal({ type: 'offer', sdp: offer.sdp, target: peerId });

    let renegotiating = false;
    pc.onnegotiationneeded = async () => {
      if (renegotiating || pc.signalingState !== 'stable') return;
      renegotiating = true;
      try {
        const reOffer = await pc.createOffer();
        await pc.setLocalDescription(reOffer);
        this.sendSignal({ type: 'offer', sdp: reOffer.sdp, target: peerId });
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
      this.sendSignal({ type: 'answer', sdp: answer.sdp, target: peerId });
    } catch (err) {
      console.error(`[HostWebRTC] Failed to handle offer from ${peerId}:`, err);
    }
  }

  private sendVideoReadyToPeer(peer: PeerChannels) {
    if (!this.videoInfo) return;
    if (peer.controlDc?.readyState === 'open') {
      peer.controlDc.send(
        JSON.stringify({
          type: 'video-ready',
          fileName: this.videoInfo.fileName,
          mimeCodec: this.videoInfo.mimeCodec,
          fileSize: this.videoInfo.fileSize,
          durationSeconds: this.videoInfo.durationSeconds,
          magnetLink: this.videoInfo.magnetLink ?? null,
        }),
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
    this.peerStreams.delete(peerId);
  }
}
