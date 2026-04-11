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

  constructor(
    private onMagnet: (magnet: string, fileName: string) => void,
    private onSync: (sync: SyncMessage) => void,
    private onChat: (msg: ChatMessage) => void,
    private onConnected: () => void,
    private onDisconnected: () => void
  ) {}

  async connect(roomUrl: string): Promise<MediaStream | null> {
    // Support both full URL and short room code
    let fullUrl = roomUrl.trim();
    if (!fullUrl.startsWith("http")) {
      // Assume it's a Cloudflare subdomain short code
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
        this.ws!.send(
          JSON.stringify({
            type: "join",
            room: roomId,
            displayName: getDisplayName(),
          })
        );
      };

      this.ws!.onmessage = async (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === "room-full") {
          alert("Room is full (max 8 viewers)");
          return;
        }

        if (msg.type === "offer") {
          try {
            const stream = await this.handleOffer(msg.sdp, msg.peerId);
            resolve(stream);
          } catch (err) {
            console.error("Failed to handle offer:", err);
            resolve(null);
          }
        } else if (msg.type === "ice-candidate" && this.pc) {
          try {
            await this.pc.addIceCandidate(msg.candidate);
          } catch (e) {
            console.error("Failed to add ICE candidate:", e);
          }
        } else if (msg.type === "pong") {
          const t3 = Date.now();
          this.syncController.updateClockOffset(msg.timestamp, msg.serverTime, t3);
        }
      };

      this.ws!.onerror = () => resolve(null);
    });
  }

  private async handleOffer(sdp: string, hostPeerId: string): Promise<MediaStream | null> {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

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

    this.pc.ondatachannel = (e) => {
      const dc = e.channel;

      if (dc.label === "control") {
        dc.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "magnet") {
              this.onMagnet(msg.magnet, msg.fileName || "video");
            }
          } catch {}
        };
      }

      if (dc.label === "sync") {
        dc.onmessage = (ev) => {
          try {
            const sync: SyncMessage = JSON.parse(ev.data);
            this.onSync(sync);
          } catch {}
        };
      }

      if (dc.label === "chat") {
        dc.onmessage = (ev) => {
          try {
            const msg: ChatMessage = JSON.parse(ev.data);
            this.onChat(msg);
          } catch {}
        };
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc?.connectionState === "connected") {
        this.onConnected();
        setTimeout(() => this.ws?.close(), 5000);
        this.startPingLoop();
      }
      if (
        this.pc?.connectionState === "disconnected" ||
        this.pc?.connectionState === "failed"
      ) {
        this.onDisconnected();
      }
    };

    await this.pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.ws!.send(
      JSON.stringify({ type: "answer", sdp: answer.sdp, peerId: hostPeerId })
    );

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ type: "ice-candidate", candidate: e.candidate.toJSON(), peerId: hostPeerId })
        );
      }
    };

    return localStream;
  }

  private startPingLoop() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, 5000);
  }

  applySync(sync: SyncMessage, video: HTMLVideoElement) {
    this.syncController.applySync(sync, video);
  }

  sendChat(text: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "chat", text }));
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
