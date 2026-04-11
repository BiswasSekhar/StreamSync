import { useEffect, useRef, useState, useCallback } from "react";
import { ReceiverWebRTC } from "./lib/webrtc";
import { startStreaming, cleanup } from "./lib/torrent";
import { SyncMessage } from "./lib/sync";

type Status =
  | "connecting"
  | "connected"
  | "streaming"
  | "playing"
  | "disconnected"
  | "error";

interface ChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

export default function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [progress, setProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const webrtcRef = useRef<ReceiverWebRTC | null>(null);
  const pendingSyncRef = useRef<SyncMessage | null>(null);

  const roomUrl = window.location.href;
  const roomId = new URL(roomUrl).searchParams.get("room");
  const [manualRoomUrl, setManualRoomUrl] = useState("");

  const handleSync = useCallback((sync: SyncMessage) => {
    const video = videoRef.current;
    if (video && webrtcRef.current) {
      webrtcRef.current.applySync(sync, video);
    } else {
      // Buffer sync until video is ready
      pendingSyncRef.current = sync;
    }
  }, []);

  const handleMagnet = useCallback(
    async (magnet: string, _fileName: string) => {
      setStatus("streaming");
      const video = videoRef.current;
      if (!video) return;

      try {
        await startStreaming(magnet, video, (prog, speed) => {
          setProgress(prog * 100);
          setDownloadSpeed(speed);
        });
        setStatus("playing");

        // Apply any buffered sync
        if (pendingSyncRef.current && webrtcRef.current) {
          webrtcRef.current.applySync(pendingSyncRef.current, video);
          pendingSyncRef.current = null;
        }
      } catch (e) {
        setError(`Failed to start streaming: ${e}`);
        setStatus("error");
      }
    },
    []
  );

  const handleChat = useCallback((msg: ChatMessage) => {
    setChatMessages((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    if (!roomId) {
      setStatus("error");
      return;
    }

    const rtc = new ReceiverWebRTC(
      handleMagnet,
      handleSync,
      handleChat,
      () => setStatus("connected"),
      () => setStatus("disconnected")
    );
    webrtcRef.current = rtc;

    rtc.connect(roomUrl).then((stream) => {
      if (stream) {
        setLocalStream(stream);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      }
    });

    return () => {
      rtc.close();
      cleanup();
    };
  }, [handleChat, handleMagnet, handleSync, roomId, roomUrl]);

  const formatSpeed = (bps: number) => {
    if (bps > 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
    if (bps > 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
    return `${bps.toFixed(0)} B/s`;
  };

  if (!roomId) {
    return (
      <div style={{ background: "#0f0f0f", minHeight: "100vh", color: "#f0f0f0", fontFamily: "system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 560, background: "#161616", border: "1px solid #2a2a2a", borderRadius: 14, padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Join a StreamSync Room</h1>
          <p style={{ color: "#9ca3af", fontSize: 14 }}>
            This page needs a room link with <code>?room=...</code>.
          </p>
          <input
            value={manualRoomUrl}
            onChange={(e) => setManualRoomUrl(e.target.value)}
            placeholder="Paste room URL: https://.../?room=abc123"
            style={{
              width: "100%",
              background: "#0f0f0f",
              border: "1px solid #333",
              color: "#f0f0f0",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 14,
            }}
          />
          <button
            onClick={() => {
              const value = manualRoomUrl.trim();
              if (!value) return;
              if (value.includes("?room=")) {
                window.location.href = value;
              } else {
                window.location.href = `${window.location.origin}/?room=${encodeURIComponent(value)}`;
              }
            }}
            style={{
              background: "#6366f1",
              border: "none",
              color: "white",
              borderRadius: 10,
              padding: "10px 14px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              alignSelf: "flex-start",
            }}
          >
            Join Room
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#0f0f0f", minHeight: "100vh", color: "#f0f0f0", fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "12px 20px", borderBottom: "1px solid #2a2a2a", display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ width: 28, height: 28, background: "#6366f1", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="14" height="14" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        </div>
        <span style={{ fontWeight: 600, fontSize: 15 }}>StreamSync</span>
        <StatusBadge status={status} />
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Video area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#000", position: "relative" }}>
          {status === "connecting" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <Spinner />
              <span style={{ color: "#9ca3af", fontSize: 14 }}>Connecting to watch party…</span>
            </div>
          )}

          {status === "connected" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <Spinner />
              <span style={{ color: "#9ca3af", fontSize: 14 }}>Waiting for host to share stream…</span>
            </div>
          )}

          {status === "streaming" && (
            <div style={{ position: "absolute", top: 16, right: 16, background: "rgba(0,0,0,0.7)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#9ca3af" }}>
              Buffering… {progress.toFixed(0)}% · {formatSpeed(downloadSpeed)}
            </div>
          )}

          {error && (
            <div style={{ color: "#ef4444", fontSize: 14, textAlign: "center", padding: 20 }}>
              Error: {error}
            </div>
          )}

          <video
            ref={videoRef}
            controls
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              display: (status === "streaming" || status === "playing") ? "block" : "none",
            }}
          />
        </div>

        {/* Sidebar */}
        <div style={{ width: 260, borderLeft: "1px solid #2a2a2a", display: "flex", flexDirection: "column", background: "#0f0f0f" }}>
          {/* Local camera */}
          <div style={{ padding: 12, borderBottom: "1px solid #2a2a2a" }}>
            <div style={{ background: "#1a1a1a", borderRadius: 8, overflow: "hidden", aspectRatio: "4/3", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {localStream ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
                />
              ) : (
                <span style={{ color: "#666", fontSize: 12 }}>Camera off</span>
              )}
            </div>
          </div>

          {/* Chat */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid #2a2a2a" }}>
              <span style={{ fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>Chat</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              {chatMessages.length === 0 && (
                <span style={{ color: "#666", fontSize: 12, textAlign: "center" }}>No messages yet</span>
              )}
              {chatMessages.map((msg) => (
                <div key={msg.id}>
                  <div style={{ fontSize: 11, color: "#6366f1", marginBottom: 2 }}>{msg.from}</div>
                  <div style={{ fontSize: 13, color: "#e0e0e0" }}>{msg.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const configs: Record<Status, { color: string; label: string }> = {
    connecting: { color: "#f59e0b", label: "Connecting…" },
    connected: { color: "#6366f1", label: "Connected" },
    streaming: { color: "#6366f1", label: "Buffering…" },
    playing: { color: "#10b981", label: "Live" },
    disconnected: { color: "#ef4444", label: "Disconnected" },
    error: { color: "#ef4444", label: "Error" },
  };
  const { color, label } = configs[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color, background: `${color}20`, border: `1px solid ${color}30`, borderRadius: 99, padding: "2px 10px" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, animation: status === "playing" ? "pulse 2s infinite" : "none" }} />
      {label}
    </span>
  );
}

function Spinner() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 1s linear infinite" }}>
      <circle cx="12" cy="12" r="10" stroke="#2a2a2a" strokeWidth="3" />
      <path d="M12 2a10 10 0 0110 10" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
