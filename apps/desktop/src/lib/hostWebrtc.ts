/**
 * HostWebRTC — browser-side WebRTC for the host.
 *
 * The host connects to ws://localhost:8787/ws (the local signaller),
 * joins its own room, and when joiners appear, creates RTCPeerConnection
 * offers, exchanges ICE candidates, and opens data channels for:
 *   - control: sends magnet link + video URL to joiner
 *   - sync: sends play/pause/seek state
 *   - chat: bidirectional chat
 *
 * Also forwards remote tracks between all peers (meet/discord style).
 */

export interface SyncState {
  position: number;
  playing: boolean;
  timestamp: number;
  sequence: number;
}

interface ChatMsg {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

interface PeerChannels {
  pc: RTCPeerConnection;
  controlDc: RTCDataChannel | null;
  syncDc: RTCDataChannel | null;
  chatDc: RTCDataChannel | null;
  videoTransceiver: RTCRtpTransceiver;
  audioTransceiver: RTCRtpTransceiver;
  remoteSet: boolean;
  pendingCandidates: any[];
}

export class HostWebRTC {
  private ws: WebSocket | null = null;
  private myPeerId: string | null = null;
  private peers = new Map<string, PeerChannels>();
  private magnetLink: string | null = null;
  private fileName: string = "";
  private videoUrl: string = "";
  private localStream: MediaStream | null = null;
  // Streams received from each peer — forwarded to other peers
  private peerStreams = new Map<string, MediaStream>();
  private syncSeq = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private onPeerJoined: (peerId: string, displayName: string) => void,
    private onPeerLeft: (peerId: string) => void,
    private onChat: (msg: ChatMsg) => void,
    private onError: (err: string) => void,
    private onRemoteStream: (peerId: string, stream: MediaStream) => void = () => {}
  ) {}

  connect(roomId: string, displayName: string = "Host") {
    const wsUrl = "ws://localhost:8787/ws";
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[HostWebRTC] Connected to signaller");
      this.startPingLoop();
      this.ws!.send(JSON.stringify({ type: "join", room: roomId, displayName }));
    };

    this.ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        await this.handleSignal(msg);
      } catch (err) {
        console.error("[HostWebRTC] Failed to handle message:", err);
      }
    };

    this.ws.onerror = () => this.onError("WebSocket connection failed");
    this.ws.onclose = () => console.log("[HostWebRTC] WebSocket closed");
  }

  /**
   * Set magnet link + direct HTTP video URL. Sent to all current and future peers.
   */
  setMagnet(magnet: string, fileName: string, videoUrl: string = "") {
    this.magnetLink = magnet;
    this.fileName = fileName;
    this.videoUrl = videoUrl;
    for (const [, peer] of this.peers) {
      this.sendMagnetToPeer(peer);
    }
  }

  /**
   * Set/update the local camera stream.
   * Adds or replaces tracks on all existing peer connections.
   */
  setLocalStream(stream: MediaStream | null) {
    this.localStream = stream;
    for (const [, peer] of this.peers) {
      this.applyLocalStreamToPeer(peer, stream);
    }
  }

  broadcastSync(position: number, playing: boolean) {
    this.syncSeq++;
    const msg = JSON.stringify({
      type: "sync", position, playing,
      timestamp: Date.now(), sequence: this.syncSeq,
    });
    for (const [, peer] of this.peers) {
      if (peer.syncDc?.readyState === "open") peer.syncDc.send(msg);
    }
  }

  broadcastChat(chatMsg: ChatMsg) {
    const json = JSON.stringify(chatMsg);
    for (const [, peer] of this.peers) {
      if (peer.chatDc?.readyState === "open") peer.chatDc.send(json);
    }
  }

  get peerCount(): number { return this.peers.size; }

  close() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const [, peer] of this.peers) peer.pc.close();
    this.peers.clear();
    this.ws?.close();
    this.ws = null;
  }

  // ---- Private ----

  private startPingLoop() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, 5000);
  }

  private async handleSignal(msg: any) {
    switch (msg.type) {
      case "room-joined":
        this.myPeerId = msg.peerId;
        console.log("[HostWebRTC] Joined room as", this.myPeerId);
        break;

      case "peer-joined":
        console.log("[HostWebRTC] Peer joined:", msg.peerId, msg.displayName);
        this.onPeerJoined(msg.peerId, msg.displayName || "Viewer");
        await this.createOfferForPeer(msg.peerId);
        break;

      case "peer-left":
        this.cleanupPeer(msg.peerId);
        this.onPeerLeft(msg.peerId);
        break;

      case "answer":
        await this.handleAnswer(msg.peerId, msg.sdp);
        break;

      case "ice-candidate":
        await this.handleIceCandidate(msg.peerId, msg.candidate);
        break;
    }
  }

  private async createOfferForPeer(peerId: string) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    // Add sendrecv transceivers for host's own camera (BEFORE creating the offer
    // so media sections appear in the SDP and the peer can send/recv video).
    const videoTransceiver = pc.addTransceiver("video", { direction: "sendrecv" });
    const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });

    // Add host's local camera tracks (if already streaming)
    if (this.localStream) {
      this.applyLocalStreamToTransceivers(pc, videoTransceiver, audioTransceiver, this.localStream);
    }

    // Forward all existing peer streams to this new peer.
    // Each forwarded stream gets its own sendrecv transceiver pair.
    for (const [, stream] of this.peerStreams) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    // Data channels
    const controlDc = pc.createDataChannel("control", { ordered: true });
    const syncDc = pc.createDataChannel("sync", { ordered: false, maxRetransmits: 0 });
    const chatDc = pc.createDataChannel("chat", { ordered: true });

    const peerChannels: PeerChannels = {
      pc, controlDc, syncDc, chatDc,
      videoTransceiver, audioTransceiver,
      remoteSet: false, pendingCandidates: [],
    };
    this.peers.set(peerId, peerChannels);

    controlDc.onopen = () => this.sendMagnetToPeer(peerChannels);
    chatDc.onmessage = (e) => {
      try { this.onChat(JSON.parse(e.data)); } catch {}
    };

    // ---- ontrack: receive remote camera, forward to other peers ----
    const seenStreams = new Set<string>();
    pc.ontrack = (e) => {
      console.log(`[HostWebRTC] Track from ${peerId}:`, e.track.kind);
      const stream = e.streams?.[0];
      if (!stream || seenStreams.has(stream.id)) return;
      seenStreams.add(stream.id);

      this.peerStreams.set(peerId, stream);
      this.onRemoteStream(peerId, stream);

      // Forward this stream to all OTHER connected peers
      for (const [otherId, otherPeer] of this.peers) {
        if (otherId === peerId) continue;
        stream.getTracks().forEach((track) => otherPeer.pc.addTrack(track, stream));
      }
    };

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "ice-candidate", candidate: e.candidate.toJSON(), peerId,
        }));
      }
    };

    // Connection state
    pc.onconnectionstatechange = () => {
      console.log(`[HostWebRTC] Peer ${peerId} state: ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.cleanupPeer(peerId);
        this.onPeerLeft(peerId);
      }
    };

    // Create initial offer BEFORE enabling the renegotiation handler
    // (prevents negotiationneeded from firing during initial setup)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp, peerId }));
    }

    // NOW enable renegotiation for future track additions (e.g. other peers joining)
    let renegotiating = false;
    pc.onnegotiationneeded = async () => {
      if (renegotiating || pc.signalingState !== "stable") return;
      renegotiating = true;
      try {
        const reOffer = await pc.createOffer();
        await pc.setLocalDescription(reOffer);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "offer", sdp: reOffer.sdp, peerId }));
        }
      } catch (err) {
        console.error("[HostWebRTC] Renegotiation failed:", err);
      } finally {
        renegotiating = false;
      }
    };
  }

  /**
   * Apply local stream to an existing peer using stored transceiver refs.
   * Avoids the null-track sender matching problem.
   */
  private applyLocalStreamToPeer(peer: PeerChannels, stream: MediaStream | null) {
    if (!stream) {
      // Null out the track on both transceivers
      peer.videoTransceiver.sender.replaceTrack(null).catch(() => {});
      peer.audioTransceiver.sender.replaceTrack(null).catch(() => {});
      return;
    }
    this.applyLocalStreamToTransceivers(
      peer.pc, peer.videoTransceiver, peer.audioTransceiver, stream
    );
  }

  /**
   * Add or replace local stream tracks on the video/audio transceivers.
   */
  private applyLocalStreamToTransceivers(
    pc: RTCPeerConnection,
    videoTransceiver: RTCRtpTransceiver,
    audioTransceiver: RTCRtpTransceiver,
    stream: MediaStream
  ) {
    const videoTrack = stream.getVideoTracks()[0] ?? null;
    const audioTrack = stream.getAudioTracks()[0] ?? null;

    if (videoTrack) {
      if (videoTransceiver.sender.track) {
        videoTransceiver.sender.replaceTrack(videoTrack).catch(console.error);
      } else {
        // sender.track is null — addTrack reuses this transceiver
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
      await peer.pc.setRemoteDescription({ type: "answer", sdp });
      peer.remoteSet = true;
      for (const c of peer.pendingCandidates) {
        try { await peer.pc.addIceCandidate(c); } catch {}
      }
      peer.pendingCandidates = [];
    } catch (err) {
      console.error(`[HostWebRTC] Failed to set answer for ${peerId}:`, err);
    }
  }

  private async handleIceCandidate(peerId: string, candidate: any) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (peer.remoteSet) {
      try { await peer.pc.addIceCandidate(candidate); } catch {}
    } else {
      peer.pendingCandidates.push(candidate);
    }
  }

  private sendMagnetToPeer(peer: PeerChannels) {
    if (!this.magnetLink) return;
    if (peer.controlDc?.readyState === "open") {
      peer.controlDc.send(JSON.stringify({
        type: "magnet",
        magnet: this.magnetLink,
        fileName: this.fileName,
        videoUrl: this.videoUrl,
      }));
    }
  }

  private cleanupPeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) { peer.pc.close(); this.peers.delete(peerId); }
    this.peerStreams.delete(peerId);
  }
}
