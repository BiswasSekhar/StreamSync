import { SyncController, SyncMessage } from "./sync";

interface ChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

export class ReceiverWebRTC {
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private syncController = new SyncController();
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private onMagnet: (magnet: string, fileName: string) => void,
    private onSync: (sync: SyncMessage) => void,
    private onChat: (msg: ChatMessage) => void,
    private onPeerJoined: () => void,
    private onDisconnected: () => void
  ) {}

  async connect(roomUrl: string): Promise<MediaStream | null> {
    const url = new URL(roomUrl);
    const wsBase = roomUrl.split("?")[0];
    const wsUrl = wsBase.replace(/^https?/, "wss").replace(/^http/, "ws");
    const wsUrlFixed = wsUrl.endsWith("/") ? wsUrl + "ws" : wsUrl + "/ws";
    const roomId = url.searchParams.get("room");

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
          const t1 = msg.timestamp;
          const t2 = msg.serverTime;
          this.syncController.updateClockOffset(t1, t2, t3);
        }
      };

      this.ws!.onerror = (e) => {
        console.error("WebSocket error:", e);
        resolve(null);
      };
    });
  }

  private async handleOffer(sdp: string, hostPeerId: string): Promise<MediaStream | null> {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    // Get local camera + mic (optional — catch errors gracefully)
    let localStream: MediaStream | null = null;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStream.getTracks().forEach((track) =>
        this.pc!.addTrack(track, localStream!)
      );
    } catch (e) {
      console.warn("Could not get camera/mic:", e);
    }

    // Handle data channels from host
    this.pc.ondatachannel = (e) => {
      const dc = e.channel;

      if (dc.label === "control") {
        dc.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "magnet") {
              this.onMagnet(msg.magnet, msg.fileName || "video.mp4");
            }
          } catch (e) {
            console.error("Control message parse error:", e);
          }
        };
      }

      if (dc.label === "sync") {
        dc.onmessage = (ev) => {
          try {
            const sync: SyncMessage = JSON.parse(ev.data);
            this.onSync(sync);
          } catch (e) {
            console.error("Sync message parse error:", e);
          }
        };
      }

      if (dc.label === "chat") {
        dc.onmessage = (ev) => {
          try {
            const msg: ChatMessage = JSON.parse(ev.data);
            this.onChat(msg);
          } catch (e) {
            console.error("Chat message parse error:", e);
          }
        };
      }
    };

    // When P2P is connected, drop the WS
    this.pc.onconnectionstatechange = () => {
      if (this.pc?.connectionState === "connected") {
        this.onPeerJoined();
        // Keep WS alive for a bit in case ICE restarts needed
        setTimeout(() => this.ws?.close(), 5000);

        // Start clock sync pings
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
      JSON.stringify({
        type: "answer",
        sdp: answer.sdp,
        peerId: hostPeerId,
      })
    );

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: "ice-candidate",
            candidate: e.candidate.toJSON(),
            peerId: hostPeerId,
          })
        );
      }
    };

    return localStream;
  }

  private startPingLoop() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ type: "ping", timestamp: Date.now() })
        );
      }
    }, 5000);
  }

  applySync(sync: SyncMessage, video: HTMLVideoElement) {
    this.syncController.applySync(sync, video);
  }

  sendChat(text: string) {
    // Basic implementation: send to WS or over a stored DataChannel if we had one.
    // For now, if the signaller WS is still open, we can send it via WS as peer-message
    // Since we don't have chatDC explicitly stored, we'll relay via signaller.
    // StreamSync's desktop host listens to peer WS messages too.
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
