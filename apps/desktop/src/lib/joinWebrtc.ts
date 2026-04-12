import { SyncController, SyncMessage } from "./sync";

interface ChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

export class JoinWebRTC {
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private syncController = new SyncController();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pendingCandidates: any[] = [];
  private remoteSet = false;
  private chatDc: RTCDataChannel | null = null;
  private syncDcRef: RTCDataChannel | null = null;
  private initialOfferResolved = false;
  private hostPeerId: string | null = null;
  private receivedStreamIds = new Set<string>();

  constructor(
    private onMagnet: (magnet: string, fileName: string, videoUrl: string) => void,
    private onSync: (sync: SyncMessage) => void,
    private onChat: (msg: ChatMessage) => void,
    private onConnected: () => void,
    private onDisconnected: () => void,
    private onRemoteStream: (stream: MediaStream) => void = () => {}
  ) {}

  async connect(roomUrl: string): Promise<MediaStream | null> {
    let fullUrl = roomUrl.trim();
    if (!fullUrl.startsWith("http")) {
      fullUrl = `https://${fullUrl}.trycloudflare.com`;
    }

    const url = new URL(fullUrl);
    const wsBase = fullUrl.split("?")[0];
    const wsUrl = wsBase.replace(/^https?/, "wss").replace(/^http/, "ws");
    const wsUrlFixed = wsUrl.endsWith("/") ? wsUrl + "ws" : wsUrl + "/ws";
    const roomId = url.searchParams.get("room") ?? "default";

    this.ws = new WebSocket(wsUrlFixed);

    return new Promise((resolve) => {
      this.ws!.onopen = () => {
        this.startPingLoop();
        this.ws!.send(JSON.stringify({
          type: "join", room: roomId, displayName: getDisplayName(),
        }));
      };

      this.ws!.onmessage = async (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === "room-full") {
          alert("Room is full (max 8 viewers)");
          return;
        }

        if (msg.type === "offer") {
          if (!this.initialOfferResolved) {
            // First offer: full handshake
            try {
              const stream = await this.handleOffer(msg.sdp, msg.peerId);
              this.initialOfferResolved = true;
              resolve(stream);
            } catch (err) {
              console.error("[JoinWebRTC] Failed to handle offer:", err);
              resolve(null);
            }
          } else {
            // Subsequent offer: renegotiation (host added new peer stream)
            await this.handleReoffer(msg.sdp);
          }
          return;
        }

        if (msg.type === "ice-candidate") {
          if (this.remoteSet && this.pc) {
            try { await this.pc.addIceCandidate(msg.candidate); } catch {}
          } else {
            this.pendingCandidates.push(msg.candidate);
          }
          return;
        }

        if (msg.type === "pong") {
          const t3 = Date.now();
          this.syncController.updateClockOffset(msg.timestamp, msg.serverTime, t3);
        }
      };

      this.ws!.onerror = () => resolve(null);
    });
  }

  private async handleOffer(sdp: string, hostPeerId: string): Promise<MediaStream | null> {
    this.hostPeerId = hostPeerId;

    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    // Receive remote streams (host camera + forwarded viewer cameras)
    this.pc.ontrack = (e) => {
      console.log("[JoinWebRTC] Received track:", e.track.kind);
      const stream = e.streams?.[0];
      if (!stream || this.receivedStreamIds.has(stream.id)) return;
      this.receivedStreamIds.add(stream.id);
      this.onRemoteStream(stream);
    };

    // Get local camera + mic (optional)
    let localStream: MediaStream | null = null;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStream.getTracks().forEach((track) =>
        this.pc!.addTrack(track, localStream!)
      );
    } catch {
      // Camera optional
    }

    // Data channels
    this.pc.ondatachannel = (e) => {
      const dc = e.channel;

      if (dc.label === "control") {
        dc.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "magnet") {
              this.onMagnet(
                msg.magnet,
                msg.fileName || "video",
                msg.videoUrl || ""
              );
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
    };

    this.pc.onconnectionstatechange = () => {
      console.log("[JoinWebRTC] Connection state:", this.pc?.connectionState);
      if (this.pc?.connectionState === "connected") this.onConnected();
      if (this.pc?.connectionState === "disconnected" || this.pc?.connectionState === "failed") {
        this.onDisconnected();
      }
    };

    await this.pc.setRemoteDescription({ type: "offer", sdp });
    this.remoteSet = true;

    for (const c of this.pendingCandidates) {
      try { await this.pc.addIceCandidate(c); } catch {}
    }
    this.pendingCandidates = [];

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.ws!.send(JSON.stringify({ type: "answer", sdp: answer.sdp, peerId: hostPeerId }));

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "ice-candidate", candidate: e.candidate.toJSON(), peerId: hostPeerId,
        }));
      }
    };

    return localStream;
  }

  /**
   * Handle a renegotiation offer from the host (new peer joined, host forwarded their tracks).
   */
  private async handleReoffer(sdp: string) {
    if (!this.pc || !this.hostPeerId) return;
    try {
      await this.pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.ws!.send(JSON.stringify({
        type: "answer", sdp: answer.sdp, peerId: this.hostPeerId,
      }));
    } catch (err) {
      console.error("[JoinWebRTC] Reoffer handling failed:", err);
    }
  }

  private startPingLoop() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, 5000);
  }

  applySync(sync: SyncMessage, video: HTMLVideoElement): boolean {
    return this.syncController.applySync(sync, video);
  }

  sendPlaybackControl(action: "play" | "pause" | "seek", position: number) {
    if (this.syncDcRef?.readyState === "open") {
      this.syncDcRef.send(JSON.stringify({ type: "control", action, position }));
    }
  }

  sendChat(text: string) {
    const msg = {
      id: crypto.randomUUID(), from: getDisplayName(), text, timestamp: Date.now(),
    };
    if (this.chatDc?.readyState === "open") {
      this.chatDc.send(JSON.stringify(msg));
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pc?.close();
    this.ws?.close();
  }
}

function getDisplayName(): string {
  const stored = sessionStorage.getItem("streamsync_name");
  if (stored) return stored;
  const name = `Viewer${Math.floor(Math.random() * 9000) + 1000}`;
  sessionStorage.setItem("streamsync_name", name);
  return name;
}
