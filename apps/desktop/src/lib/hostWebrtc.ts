/**
 * HostWebRTC — browser-side WebRTC for the host.
 *
 * The host connects to ws://localhost:8787/ws (the local signaller),
 * joins its own room, and when joiners appear, creates RTCPeerConnection
 * offers, exchanges ICE candidates, and opens data channels for:
 *   - control: sends magnet link to joiner
 *   - sync: sends play/pause/seek state
 *   - chat: bidirectional chat
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
}

export class HostWebRTC {
  private ws: WebSocket | null = null;
  private myPeerId: string | null = null;
  private peers = new Map<string, PeerChannels>();
  private magnetLink: string | null = null;
  private fileName: string = "";
  private syncSeq = 0;

  constructor(
    private onPeerJoined: (peerId: string, displayName: string) => void,
    private onPeerLeft: (peerId: string) => void,
    private onChat: (msg: ChatMsg) => void,
    private onError: (err: string) => void
  ) {}

  /**
   * Connect to the local signaller and join the room.
   * @param roomId The room UUID (from the room URL)
   * @param displayName The host's display name
   */
  connect(roomId: string, displayName: string = "Host") {
    const wsUrl = "ws://localhost:8787/ws";
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[HostWebRTC] Connected to signaller");
      this.ws!.send(
        JSON.stringify({
          type: "join",
          room: roomId,
          displayName,
        })
      );
    };

    this.ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        await this.handleSignal(msg);
      } catch (err) {
        console.error("[HostWebRTC] Failed to handle message:", err);
      }
    };

    this.ws.onerror = (e) => {
      console.error("[HostWebRTC] WebSocket error:", e);
      this.onError("WebSocket connection failed");
    };

    this.ws.onclose = () => {
      console.log("[HostWebRTC] WebSocket closed");
    };
  }

  /**
   * Set the magnet link. Will be sent to all existing and future peers.
   */
  setMagnet(magnet: string, fileName: string) {
    this.magnetLink = magnet;
    this.fileName = fileName;

    // Send to all currently connected peers
    for (const [, peer] of this.peers) {
      this.sendMagnetToPeer(peer);
    }
  }

  /**
   * Broadcast sync state to all peers.
   */
  broadcastSync(position: number, playing: boolean) {
    this.syncSeq++;
    const msg = JSON.stringify({
      type: "sync",
      position,
      playing,
      timestamp: Date.now(),
      sequence: this.syncSeq,
    });

    for (const [, peer] of this.peers) {
      if (peer.syncDc?.readyState === "open") {
        peer.syncDc.send(msg);
      }
    }
  }

  /**
   * Broadcast chat to all peers via data channels.
   */
  broadcastChat(chatMsg: ChatMsg) {
    const json = JSON.stringify(chatMsg);
    for (const [, peer] of this.peers) {
      if (peer.chatDc?.readyState === "open") {
        peer.chatDc.send(json);
      }
    }
  }

  /**
   * Get the number of connected peers.
   */
  get peerCount(): number {
    return this.peers.size;
  }

  /**
   * Close all connections.
   */
  close() {
    for (const [id, peer] of this.peers) {
      peer.pc.close();
    }
    this.peers.clear();
    this.ws?.close();
    this.ws = null;
  }

  // ---- Private ----

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
        console.log("[HostWebRTC] Peer left:", msg.peerId);
        this.cleanupPeer(msg.peerId);
        this.onPeerLeft(msg.peerId);
        break;

      case "answer":
        await this.handleAnswer(msg.peerId, msg.sdp);
        break;

      case "ice-candidate":
        await this.handleIceCandidate(msg.peerId, msg.candidate);
        break;

      case "pong":
        // Clock sync — could be used for latency estimation
        break;

      default:
        console.log("[HostWebRTC] Unknown signal:", msg.type);
    }
  }

  private async createOfferForPeer(peerId: string) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    // Create data channels (host initiates)
    const controlDc = pc.createDataChannel("control", { ordered: true });
    const syncDc = pc.createDataChannel("sync", {
      ordered: false,
      maxRetransmits: 0,
    });
    const chatDc = pc.createDataChannel("chat", { ordered: true });

    const peerChannels: PeerChannels = { pc, controlDc, syncDc, chatDc };
    this.peers.set(peerId, peerChannels);

    // When control channel opens, send magnet
    controlDc.onopen = () => {
      console.log(`[HostWebRTC] Control channel open with ${peerId}`);
      this.sendMagnetToPeer(peerChannels);
    };

    // Handle incoming chat from peer
    chatDc.onmessage = (e) => {
      try {
        const msg: ChatMsg = JSON.parse(e.data);
        this.onChat(msg);
      } catch {}
    };

    // ICE candidates → relay to peer via signaller
    pc.onicecandidate = (e) => {
      if (e.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: e.candidate.toJSON(),
            peerId,
          })
        );
      }
    };

    // Connection state tracking
    pc.onconnectionstatechange = () => {
      console.log(`[HostWebRTC] Peer ${peerId} state: ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.cleanupPeer(peerId);
        this.onPeerLeft(peerId);
      }
    };

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "offer",
          sdp: offer.sdp,
          peerId,
        })
      );
    }
  }

  private async handleAnswer(peerId: string, sdp: string) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`[HostWebRTC] Answer from unknown peer: ${peerId}`);
      return;
    }
    try {
      await peer.pc.setRemoteDescription({ type: "answer", sdp });
      console.log(`[HostWebRTC] Set remote description for ${peerId}`);
    } catch (err) {
      console.error(`[HostWebRTC] Failed to set answer for ${peerId}:`, err);
    }
  }

  private async handleIceCandidate(peerId: string, candidate: any) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      console.error(`[HostWebRTC] Failed to add ICE candidate:`, err);
    }
  }

  private sendMagnetToPeer(peer: PeerChannels) {
    if (!this.magnetLink) return;
    if (peer.controlDc?.readyState === "open") {
      peer.controlDc.send(
        JSON.stringify({
          type: "magnet",
          magnet: this.magnetLink,
          fileName: this.fileName,
        })
      );
    }
  }

  private cleanupPeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.pc.close();
      this.peers.delete(peerId);
    }
  }
}
