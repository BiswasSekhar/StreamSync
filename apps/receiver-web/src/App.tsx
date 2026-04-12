import { useEffect, useRef, useState, useCallback } from "react";
import { ReceiverWebRTC } from "./lib/webrtc";
import { SyncMessage } from "./lib/sync";

type Status = "connecting" | "connected" | "streaming" | "playing" | "disconnected" | "error";
interface ChatMessage { id: string; from: string; text: string; timestamp: number; }
interface Toast { id: string; from: string; text: string; }

export default function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [progress, setProgress] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatToasts, setChatToasts] = useState<Toast[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<MediaStream[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [manualRoomUrl, setManualRoomUrl] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const webrtcRef = useRef<ReceiverWebRTC | null>(null);
  const pendingSyncRef = useRef<SyncMessage | null>(null);
  const suppressControlRef = useRef(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const roomUrl = window.location.href;
  const roomId = new URL(roomUrl).searchParams.get("room");

  const addToast = useCallback((from: string, text: string, id: string) => {
    setChatToasts(prev => [...prev, { id, from, text }]);
    setTimeout(() => setChatToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  const handleSync = useCallback((sync: SyncMessage) => {
    const video = videoRef.current;
    if (video && webrtcRef.current) {
      const changed = webrtcRef.current.applySync(sync, video);
      if (changed) suppressControlRef.current = Date.now() + 500;
    } else {
      pendingSyncRef.current = sync;
    }
  }, []);

  const handleMagnet = useCallback(async (_magnet: string, _fileName: string, videoUrl: string) => {
    setStatus("streaming");
    const video = videoRef.current;
    if (!video) return;

    if (videoUrl) {
      video.src = videoUrl;
      video.onprogress = () => {
        if (video.buffered.length > 0 && video.duration > 0) {
          setProgress((video.buffered.end(video.buffered.length - 1) / video.duration) * 100);
        }
      };
      video.oncanplay = () => {
        setStatus("playing");
        if (pendingSyncRef.current && webrtcRef.current) {
          webrtcRef.current.applySync(pendingSyncRef.current, video);
          pendingSyncRef.current = null;
        }
      };
      video.onerror = () => { setError("Video failed to load. Host may still be encoding."); setStatus("error"); };
      return;
    }
    setError("No video URL received from host."); setStatus("error");
  }, []);

  const handleChat = useCallback((msg: ChatMessage) => {
    setChatMessages(prev => [...prev, msg]);
    addToast(msg.from, msg.text, msg.id);
  }, [addToast]);

  const handleRemoteStream = useCallback((stream: MediaStream) => {
    setRemoteStreams(prev => prev.some(s => s.id === stream.id) ? prev : [...prev, stream]);
  }, []);

  useEffect(() => {
    if (!roomId) { setStatus("error"); return; }

    const rtc = new ReceiverWebRTC(
      handleMagnet, handleSync, handleChat,
      () => setStatus("connected"),
      () => setStatus("disconnected"),
      handleRemoteStream,
    );
    webrtcRef.current = rtc;

    rtc.connect(roomUrl).then(stream => {
      if (stream) {
        setLocalStream(stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      }
    });

    return () => { rtc.close(); };
  }, [handleChat, handleMagnet, handleSync, handleRemoteStream, roomId, roomUrl]);

  useEffect(() => {
    if (localStream && localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    remoteStreams.forEach(stream => {
      const el = remoteVideoRefs.current.get(stream.id);
      if (el && el.srcObject !== stream) el.srcObject = stream;
    });
  }, [remoteStreams]);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  const sendControl = useCallback((action: "play" | "pause" | "seek") => {
    if (Date.now() < suppressControlRef.current) return;
    const pos = videoRef.current?.currentTime ?? 0;
    webrtcRef.current?.sendPlaybackControl(action, pos);
  }, []);

  const sendChat = useCallback((text: string) => {
    webrtcRef.current?.sendChat(text);
  }, []);

  const camTiles = [
    ...(localStream ? [{ id: "local", label: "You", isLocal: true, stream: null as MediaStream | null }] : []),
    ...remoteStreams.map((s, i) => ({ id: s.id, label: i === 0 ? "Host" : `Viewer ${i}`, isLocal: false, stream: s })),
  ];

  // No-room landing page
  if (!roomId) {
    return (
      <div style={{ background: "#080808", minHeight: "100vh", color: "#f0f0f0", fontFamily: "Inter, system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 520, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 20, padding: 36, display: "flex", flexDirection: "column", gap: 18, boxShadow: "0 24px 48px rgba(0,0,0,0.6)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, background: "linear-gradient(135deg,#818cf8,#6366f1)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="18" height="18" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>StreamSync</h1>
          </div>
          <p style={{ color: "#9ca3af", fontSize: 14, margin: 0, lineHeight: 1.6 }}>Paste a room link to join a watch party.</p>
          <input value={manualRoomUrl} onChange={e => setManualRoomUrl(e.target.value)}
            placeholder="https://.../?room=abc123"
            style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.1)", color: "#f0f0f0", borderRadius: 12, padding: "14px 16px", fontSize: 14, outline: "none" }}
            onFocus={e => e.target.style.borderColor = "#6366f1"}
            onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
          />
          <button
            onClick={() => {
              const v = manualRoomUrl.trim();
              if (!v) return;
              window.location.href = v.includes("?room=") ? v : `${window.location.origin}/?room=${encodeURIComponent(v)}`;
            }}
            style={{ background: "linear-gradient(135deg,#818cf8,#6366f1)", border: "none", color: "white", borderRadius: 12, padding: "14px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer", alignSelf: "flex-start" }}
          >Join Room</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* ── Fullscreen video ── */}
      {(status === "connecting" || status === "connected") && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <Spinner size={36} />
          <span style={{ color: "#94a3b8", fontSize: 15 }}>{status === "connecting" ? "Connecting to host..." : "Waiting for host to share video..."}</span>
        </div>
      )}

      {error && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 14, padding: "24px 32px", maxWidth: 360, textAlign: "center" }}>
            <p style={{ color: "#f87171", fontSize: 14, margin: 0 }}>{error}</p>
          </div>
        </div>
      )}

      {status === "streaming" && (
        <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", zIndex: 30, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 18px", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#e2e8f0" }}>
          <Spinner size={16} />
          Buffering {progress.toFixed(0)}%
        </div>
      )}

      <video
        ref={videoRef}
        controls
        onPlay={() => sendControl("play")}
        onPause={() => sendControl("pause")}
        onSeeked={() => sendControl("seek")}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: (status === "streaming" || status === "playing") ? "block" : "none" }}
      />

      {/* ── Top bar ── */}
      <div style={{ position: "absolute", top: 0, left: 0, right: chatOpen ? 340 : 0, zIndex: 20, background: "linear-gradient(to bottom, rgba(0,0,0,0.85), transparent)", padding: "12px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 26, height: 26, background: "linear-gradient(135deg,#818cf8,#6366f1)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="12" height="12" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        </div>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>StreamSync</span>
        <div style={{ flex: 1 }} />
        <StatusBadge status={status} progress={progress} />
      </div>

      {/* ── Bottom camera strip ── */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: chatOpen ? 340 : 0, zIndex: 20, background: "linear-gradient(to top, rgba(0,0,0,0.9), transparent)", padding: "20px 16px 16px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, overflowX: "auto", scrollbarWidth: "none" }}>
          {camTiles.map(tile => (
            <div key={tile.id} style={{ position: "relative", flexShrink: 0, width: 136, height: 84, borderRadius: 10, overflow: "hidden", border: "2px solid rgba(255,255,255,0.12)", background: "#111" }}>
              {tile.isLocal ? (
                <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
              ) : (
                <video
                  ref={el => { if (el && tile.stream) { remoteVideoRefs.current.set(tile.id, el); if (el.srcObject !== tile.stream) el.srcObject = tile.stream; } }}
                  autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              )}
              <div style={{ position: "absolute", bottom: 4, left: 6, fontSize: 10, color: "white", background: "rgba(0,0,0,0.65)", padding: "1px 6px", borderRadius: 4 }}>{tile.label}</div>
            </div>
          ))}
          {camTiles.length === 0 && <span style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 8 }}>No cameras on</span>}
          <div style={{ flex: 1 }} />
          {/* Chat toggle */}
          <button onClick={() => setChatOpen(o => !o)} style={{ ...iconBtn, background: chatOpen ? "rgba(99,102,241,0.9)" : "rgba(255,255,255,0.1)", flexShrink: 0 }}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Chat overlay ── */}
      <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 340, background: "rgba(10,10,10,0.97)", backdropFilter: "blur(20px)", borderLeft: "1px solid rgba(255,255,255,0.07)", transform: chatOpen ? "translateX(0)" : "translateX(340px)", transition: "transform 0.28s ease", zIndex: 50, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>Live Chat</span>
          <button onClick={() => setChatOpen(false)} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4 }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          {chatMessages.length === 0 && <p style={{ color: "#555", fontSize: 13, textAlign: "center", marginTop: 24 }}>No messages yet</p>}
          {chatMessages.map(msg => (
            <div key={msg.id}>
              <div style={{ display: "flex", gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: "#818cf8", fontWeight: 600 }}>{msg.from}</span>
                <span style={{ fontSize: 11, color: "#555" }}>{new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.45, background: "rgba(255,255,255,0.05)", padding: "8px 12px", borderRadius: "0 10px 10px 10px" }}>{msg.text}</p>
            </div>
          ))}
          <div ref={chatBottomRef} />
        </div>
        <div style={{ padding: "12px 14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
          <ChatInput onSend={sendChat} />
        </div>
      </div>

      {/* ── Chat toasts ── */}
      <div style={{ position: "absolute", bottom: 128, right: chatOpen ? 356 : 16, zIndex: 60, display: "flex", flexDirection: "column-reverse", gap: 8, alignItems: "flex-end", maxWidth: 270, pointerEvents: "none" }}>
        {chatToasts.map(t => <ChatToast key={t.id} from={t.from} text={t.text} />)}
      </div>
    </div>
  );
}

function ChatToast({ from, text }: { from: string; text: string }) {
  const [vis, setVis] = useState(true);
  useEffect(() => { const t = setTimeout(() => setVis(false), 2800); return () => clearTimeout(t); }, []);
  return (
    <div style={{ background: "rgba(15,15,15,0.96)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#e2e8f0", opacity: vis ? 1 : 0, transition: "opacity 0.3s ease", boxShadow: "0 4px 20px rgba(0,0,0,0.5)", maxWidth: 270 }}>
      <div style={{ fontSize: 11, color: "#818cf8", fontWeight: 600, marginBottom: 3 }}>{from}</div>
      <div style={{ lineHeight: 1.4 }}>{text}</div>
    </div>
  );
}

function StatusBadge({ status, progress }: { status: Status; progress: number }) {
  const cfg: Record<Status, { color: string; text: string }> = {
    connecting:   { color: "#eab308", text: "Connecting" },
    connected:    { color: "#3b82f6", text: "Connected" },
    streaming:    { color: "#818cf8", text: `Buffering ${progress.toFixed(0)}%` },
    playing:      { color: "#22c55e", text: "Watching" },
    error:        { color: "#ef4444", text: "Error" },
    disconnected: { color: "#6b7280", text: "Disconnected" },
  };
  const { color, text } = cfg[status];
  return (
    <span style={{ background: `${color}18`, border: `1px solid ${color}40`, color, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />
      {text}
    </span>
  );
}

function ChatInput({ onSend }: { onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form onSubmit={e => { e.preventDefault(); if (text.trim()) { onSend(text.trim()); setText(""); } }} style={{ display: "flex", gap: 8 }}>
      <input type="text" value={text} onChange={e => setText(e.target.value)} placeholder="Type a message..."
        style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: 10, padding: "10px 12px", fontSize: 13, outline: "none" }}
        onFocus={e => e.target.style.borderColor = "#6366f1"}
        onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
      />
      <button type="submit" disabled={!text.trim()} style={{ background: text.trim() ? "linear-gradient(135deg,#818cf8,#6366f1)" : "rgba(255,255,255,0.1)", color: text.trim() ? "white" : "rgba(255,255,255,0.4)", border: "none", borderRadius: 10, padding: "0 14px", cursor: text.trim() ? "pointer" : "default", display: "flex", alignItems: "center" }}>
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
      </button>
    </form>
  );
}

function Spinner({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}>
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
      <path fill="#6366f1" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

const iconBtn: React.CSSProperties = { border: "1px solid rgba(255,255,255,0.12)", color: "white", borderRadius: 10, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "background 0.2s" };
