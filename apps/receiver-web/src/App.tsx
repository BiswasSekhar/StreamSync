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
      <div style={{ background: "#0a0a0a", minHeight: "100vh", color: "#f0f0f0", fontFamily: "Inter, system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 560, background: "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 16, padding: 32, display: "flex", flexDirection: "column", gap: 16, boxShadow: "0 20px 40px rgba(0,0,0,0.5)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #818cf8, #6366f1)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>StreamSync</h1>
          </div>
          <p style={{ color: "#9ca3af", fontSize: 15, margin: 0, lineHeight: 1.5 }}>
            To join a watch party, please paste a valid room link below.
          </p>
          <input
            value={manualRoomUrl}
            onChange={(e) => setManualRoomUrl(e.target.value)}
            placeholder="Paste room URL: https://.../?room=abc123"
            style={{
              width: "100%",
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#f0f0f0",
              borderRadius: 12,
              padding: "14px 16px",
              fontSize: 15,
              outline: "none",
              transition: "border-color 0.2s"
            }}
            onFocus={(e) => e.target.style.borderColor = "#6366f1"}
            onBlur={(e) => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
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
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "white",
              borderRadius: 12,
              padding: "14px 20px",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.2s",
              alignSelf: "flex-start",
            }}
            onMouseOver={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
            onMouseOut={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
          >
            Join Room
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#0a0a0a", minHeight: "100vh", color: "#f0f0f0", fontFamily: "Inter, system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "16px 24px", background: "rgba(0,0,0,0.5)", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: "16px", backdropFilter: "blur(10px)" }}>
        <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #818cf8, #6366f1)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="16" height="16" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        </div>
        <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: "-0.01em" }}>StreamSync</span>
        <div style={{ marginLeft: "auto" }}>
          <StatusBadge status={status} />
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        {/* Video area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#000", position: "relative" }}>
          {status === "connecting" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
              <Spinner />
              <span style={{ color: "#9ca3af", fontSize: 15 }}>Connecting to host peer...</span>
            </div>
          )}

          {status === "connected" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
              <Spinner />
              <span style={{ color: "#9ca3af", fontSize: 15 }}>Waiting for host to share video...</span>
            </div>
          )}

          {status === "streaming" && (
            <div style={{ position: "absolute", top: 20, right: 20, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 16px", fontSize: 13, color: "#f3f4f6", fontWeight: 500, boxShadow: "0 10px 20px rgba(0,0,0,0.3)", zIndex: 50, display: "flex", alignItems: "center", gap: 10 }}>
              <Spinner size={16} />
              Buffering: {progress.toFixed(0)}% <span style={{ color: "#9ca3af", margin: "0 6px" }}>|</span> {formatSpeed(downloadSpeed)}
            </div>
          )}

          {error && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 12, color: "#ef4444", fontSize: 15, textAlign: "center", padding: "16px 24px", maxWidth: 400 }}>
              {error}
            </div>
          )}

          <video
            ref={videoRef}
            controls
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: (status === "streaming" || status === "playing") ? "block" : "none",
            }}
          />
        </div>

        {/* Sidebar */}
        <div style={{ width: 320, borderLeft: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", background: "rgba(20,20,20,0.95)", backdropFilter: "blur(20px)" }}>
          {/* Local camera */}
          <div style={{ padding: 20, borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ background: "#050505", borderRadius: 12, overflow: "hidden", aspectRatio: "4/3", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(255,255,255,0.05)", boxShadow: "inset 0 2px 10px rgba(0,0,0,0.5)" }}>
              {localStream ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
                />
              ) : (
                <svg width="24" height="24" fill="none" stroke="#444" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              )}
            </div>
            <div style={{ marginTop: 12, fontSize: 13, color: "#9ca3af", fontWeight: 500, textAlign: "center" }}>Your Camera</div>
          </div>

          {/* Chat */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <span style={{ fontSize: 13, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.02em" }}>Live Chat</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
              {chatMessages.length === 0 && (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ color: "#666", fontSize: 13, textAlign: "center" }}>No messages yet</span>
                </div>
              )}
              {chatMessages.map((msg) => (
                <div key={msg.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontSize: 12, color: "#818cf8", fontWeight: 600 }}>{msg.from}</div>
                  <div style={{ fontSize: 14, color: "#e5e7eb", lineHeight: 1.4, background: "rgba(255,255,255,0.05)", padding: "10px 14px", borderRadius: "0 12px 12px 12px" }}>{msg.text}</div>
                </div>
              ))}
            </div>
            <div style={{ padding: 20, borderTop: "1px solid rgba(255,255,255,0.05)", background: "rgba(0,0,0,0.2)" }}>
              <ChatInput onSend={(text) => webrtcRef.current?.sendChat(text)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const getBadgeStyle = () => {
    switch (status) {
      case "connecting": return { bg: "rgba(234,179,8,0.15)", color: "#fde047", text: "Connecting", dot: "#eab308" };
      case "connected": return { bg: "rgba(59,130,246,0.15)", color: "#93c5fd", text: "Connected", dot: "#3b82f6" };
      case "streaming": return { bg: "rgba(99,102,241,0.15)", color: "#c7d2fe", text: "Streaming", dot: "#6366f1" };
      case "playing": return { bg: "rgba(34,197,94,0.15)", color: "#86efac", text: "Ready", dot: "#22c55e" };
      case "error": return { bg: "rgba(239,68,68,0.15)", color: "#fca5a5", text: "Error", dot: "#ef4444" };
      case "disconnected": return { bg: "rgba(107,114,128,0.15)", color: "#d1d5db", text: "Disconnected", dot: "#6b7280" };
    }
  };
  const style = getBadgeStyle();
  return (
    <span style={{ background: style.bg, color: style.color, padding: "6px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, border: `1px solid ${style.bg}` }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: style.dot, boxShadow: `0 0 8px ${style.dot}` }} />
      {style.text}
    </span>
  );
}

function ChatInput({ onSend }: { onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) {
          onSend(text.trim());
          setText("");
        }
      }}
      style={{ display: "flex", gap: 10 }}
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message..."
        style={{ flex: 1, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: 12, padding: "12px 16px", fontSize: 14, outline: "none", transition: "border-color 0.2s" }}
        onFocus={(e) => e.target.style.borderColor = "#6366f1"}
        onBlur={(e) => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
      />
      <button
        type="submit"
        disabled={!text.trim()}
        style={{ background: text.trim() ? "linear-gradient(135deg, #818cf8, #6366f1)" : "rgba(255,255,255,0.1)", color: text.trim() ? "white" : "rgba(255,255,255,0.4)", border: "none", borderRadius: 12, padding: "0 16px", fontWeight: 600, cursor: text.trim() ? "pointer" : "default", transition: "all 0.2s", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
      </button>
    </form>
  );
}

function Spinner({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}>
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
      <path fill="#6366f1" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
