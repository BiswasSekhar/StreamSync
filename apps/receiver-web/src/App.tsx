import React, { useEffect, useRef, useState, useCallback } from "react";
import { ReceiverWebRTC } from "./lib/webrtc";
import { SyncMessage } from "./lib/sync";
import { VideoOverlay } from "./VideoOverlay";

type Status = "connecting" | "connected" | "streaming" | "playing" | "disconnected" | "error";
interface ChatMessage { id: string; from: string; text: string; timestamp: number; }
interface Toast { id: string; from: string; text: string; }
type CamShape = "circle" | "rounded" | "square";

export default function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [progress, setProgress] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMounted, setChatMounted] = useState(false);
  const [chatToasts, setChatToasts] = useState<Toast[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<MediaStream[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [manualRoomUrl, setManualRoomUrl] = useState("");

  // Video
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  // Camera
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [micMuted, setMicMuted] = useState(false);
  const [availCams, setAvailCams] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamId, setSelectedCamId] = useState("");
  const [showCamPicker, setShowCamPicker] = useState(false);
  const [camShape, setCamShape] = useState<CamShape>("rounded");
  const [pinnedCam, setPinnedCam] = useState<string | null>(null);
  const [showShapeMenu, setShowShapeMenu] = useState(false);

  const webrtcRef = useRef<ReceiverWebRTC | null>(null);
  const pendingSyncRef = useRef<SyncMessage | null>(null);
  const suppressControlRef = useRef(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const roomUrl = window.location.href;
  const roomId = new URL(roomUrl).searchParams.get("room");

  const openChat = useCallback(() => { setChatMounted(true); requestAnimationFrame(() => setChatOpen(true)); }, []);
  const closeChat = useCallback(() => { setChatOpen(false); setTimeout(() => setChatMounted(false), 300); }, []);

  const addToast = useCallback((from: string, text: string, id: string) => {
    setChatToasts(prev => [...prev, { id, from, text }]);
    setTimeout(() => setChatToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  // Capture video element after mount
  useEffect(() => {
    if (videoRef.current) setVideoEl(videoRef.current);
  }, []);

  const handleSync = useCallback((sync: SyncMessage) => {
    const v = videoRef.current;
    if (v && webrtcRef.current) {
      const changed = webrtcRef.current.applySync(sync, v);
      if (changed) suppressControlRef.current = Date.now() + 500;
    } else {
      pendingSyncRef.current = sync;
    }
  }, []);

  const handleMagnet = useCallback(async (_: string, __: string, videoUrl: string) => {
    setStatus("streaming");
    const v = videoRef.current;
    if (!v) return;
    if (videoUrl) {
      v.src = videoUrl;
      v.onprogress = () => {
        if (v.buffered.length > 0 && v.duration > 0)
          setProgress((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
      };
      v.oncanplay = () => {
        setStatus("playing");
        if (pendingSyncRef.current && webrtcRef.current) { webrtcRef.current.applySync(pendingSyncRef.current, v); pendingSyncRef.current = null; }
      };
      v.onerror = () => { setError("Video failed to load."); setStatus("error"); };
      return;
    }
    setError("No video URL received."); setStatus("error");
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
        navigator.mediaDevices.enumerateDevices().then(devs => setAvailCams(devs.filter(d => d.kind === "videoinput")));
      }
    });
    return () => { rtc.close(); };
  }, [handleChat, handleMagnet, handleSync, handleRemoteStream, roomId, roomUrl]);

  useEffect(() => {
    if (localStream && localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    remoteStreams.forEach(s => {
      const el = remoteVideoRefs.current.get(s.id);
      if (el && el.srcObject !== s) el.srcObject = s;
    });
  }, [remoteStreams]);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  const sendControl = useCallback((action: "play" | "pause" | "seek") => {
    if (Date.now() < suppressControlRef.current) return;
    webrtcRef.current?.sendPlaybackControl(action, videoRef.current?.currentTime ?? 0);
  }, []);

  const toggleMic = () => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(t => { t.enabled = micMuted; });
    setMicMuted(m => !m);
  };

  const switchCamera = async (deviceId: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: 640, height: 480, frameRate: 30 },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStream?.getTracks().forEach(t => t.stop());
      setLocalStream(stream); setSelectedCamId(deviceId);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setShowCamPicker(false);
    } catch { console.error("Camera switch failed"); }
  };

  const shapeRadius = camShape === "circle" ? "50%" : camShape === "rounded" ? 10 : 0;
  const tileW = camShape === "circle" ? 84 : 136;
  const tileH = 84;

  const camTiles = [
    ...(localStream ? [{ id: "local", label: "You", isLocal: true, stream: localStream as MediaStream | null }] : []),
    ...remoteStreams.map((s, i) => ({ id: s.id, label: i === 0 ? "Host" : `Viewer ${i}`, isLocal: false, stream: s as MediaStream | null })),
  ];

  // No-room landing page
  if (!roomId) {
    return (
      <div style={{ background: "#080808", minHeight: "100vh", color: "#f0f0f0", fontFamily: "Inter, system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 520, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 20, padding: 36, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, background: "linear-gradient(135deg,#818cf8,#6366f1)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="18" height="18" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>StreamSync</h1>
          </div>
          <p style={{ color: "#9ca3af", fontSize: 14, margin: 0 }}>Paste a room link to join a watch party.</p>
          <input value={manualRoomUrl} onChange={e => setManualRoomUrl(e.target.value)} placeholder="https://.../?room=abc123"
            style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.1)", color: "#f0f0f0", borderRadius: 12, padding: "14px 16px", fontSize: 14, outline: "none" }}
            onFocus={e => e.target.style.borderColor = "#6366f1"} onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"} />
          <button onClick={() => { const v = manualRoomUrl.trim(); if (!v) return; window.location.href = v.includes("?room=") ? v : `${window.location.origin}/?room=${encodeURIComponent(v)}`; }}
            style={{ background: "linear-gradient(135deg,#818cf8,#6366f1)", border: "none", color: "white", borderRadius: 12, padding: "14px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer", alignSelf: "flex-start" }}>
            Join Room
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* Loading / error states */}
      {(status === "connecting" || status === "connected") && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <Spinner size={36} /><span style={{ color: "#94a3b8", fontSize: 15 }}>{status === "connecting" ? "Connecting to host..." : "Waiting for host..."}</span>
        </div>
      )}
      {error && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 14, padding: "24px 32px", textAlign: "center" }}>
            <p style={{ color: "#f87171", margin: 0, fontSize: 14 }}>{error}</p>
          </div>
        </div>
      )}
      {status === "streaming" && (
        <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", zIndex: 30, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 18px", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#e2e8f0" }}>
          <Spinner size={16} /> Buffering {progress.toFixed(0)}%
        </div>
      )}

      {/* Video + overlay */}
      <div style={{ position: "absolute", inset: 0, display: (status === "streaming" || status === "playing") ? "block" : "none" }}>
        <video ref={videoRef}
          onPlay={() => sendControl("play")}
          onPause={() => sendControl("pause")}
          onSeeked={() => sendControl("seek")}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
        {videoEl && <VideoOverlay videoEl={videoEl} />}
      </div>

      {/* ── Top bar ── */}
      <div style={{ position: "absolute", top: 0, left: 0, right: chatOpen ? 340 : 0, zIndex: 20, background: "linear-gradient(to bottom, rgba(0,0,0,0.88), transparent)", padding: "12px 20px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 26, height: 26, background: "linear-gradient(135deg,#818cf8,#6366f1)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="12" height="12" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        </div>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>StreamSync</span>
        <div style={{ flex: 1 }} />
        <StatusBadge status={status} progress={progress} />
      </div>

      {/* ── Bottom strip ── */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: chatOpen ? 340 : 0, zIndex: 20, background: "linear-gradient(to top, rgba(0,0,0,0.92), transparent)", padding: "28px 16px 14px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, overflowX: "auto", scrollbarWidth: "none" }}>
          {camTiles.map(tile => {
            const pinned = pinnedCam === tile.id;
            const tw = pinned ? tileW * 1.5 : tileW;
            const th = pinned ? tileH * 1.5 : tileH;
            return (
              <div key={tile.id}
                onClick={() => setPinnedCam(p => p === tile.id ? null : tile.id)}
                style={{ position: "relative", flexShrink: 0, width: tw, height: th, borderRadius: shapeRadius, overflow: "hidden", border: `2px solid ${pinned ? "#6366f1" : "rgba(255,255,255,0.12)"}`, background: "#111", cursor: "pointer", transition: "width 0.2s, height 0.2s" }}>
                {tile.isLocal ? (
                  <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
                ) : (
                  <video ref={el => { if (el && tile.stream) { remoteVideoRefs.current.set(tile.id, el); if (el.srcObject !== tile.stream) el.srcObject = tile.stream; } }} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                )}
                <div style={{ position: "absolute", bottom: 4, left: 6, fontSize: 10, color: "white", background: "rgba(0,0,0,0.65)", padding: "1px 5px", borderRadius: 4 }}>{tile.label}</div>
                {tile.isLocal && (
                  <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 3 }}>
                    <MiniBtn onClick={e => { e.stopPropagation(); toggleMic(); }}>{micMuted ? "🔇" : "🎤"}</MiniBtn>
                    <MiniBtn onClick={e => { e.stopPropagation(); setShowCamPicker(p => !p); }}>⚙</MiniBtn>
                  </div>
                )}
                {showCamPicker && tile.isLocal && (
                  <div onClick={e => e.stopPropagation()} style={{ position: "absolute", bottom: "100%", left: 0, background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: 8, minWidth: 180, zIndex: 30, marginBottom: 4 }}>
                    {availCams.map(cam => (
                      <button key={cam.deviceId} onClick={() => switchCamera(cam.deviceId)}
                        style={{ display: "block", width: "100%", background: selectedCamId === cam.deviceId ? "rgba(99,102,241,0.2)" : "transparent", border: "none", color: "#e2e8f0", padding: "6px 8px", fontSize: 12, cursor: "pointer", borderRadius: 6, textAlign: "left" }}>
                        {cam.label || `Camera ${availCams.indexOf(cam) + 1}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {camTiles.length === 0 && <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>Watching together</span>}
          <div style={{ flex: 1 }} />

          {/* Shape toggle */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <StripBtn onClick={() => setShowShapeMenu(s => !s)}>⬜</StripBtn>
            {showShapeMenu && (
              <div style={{ position: "absolute", bottom: 48, right: 0, background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 10, display: "flex", gap: 8, zIndex: 30 }}>
                {(["circle", "rounded", "square"] as CamShape[]).map(s => (
                  <button key={s} onClick={() => { setCamShape(s); setShowShapeMenu(false); }}
                    style={{ width: 40, height: 40, background: camShape === s ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.07)", border: `1px solid ${camShape === s ? "#6366f1" : "rgba(255,255,255,0.1)"}`, borderRadius: s === "circle" ? "50%" : s === "rounded" ? 8 : 2, cursor: "pointer", color: "#e2e8f0", fontSize: 11 }}>
                    {s[0].toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          <StripBtn onClick={chatOpen ? closeChat : openChat} active={chatOpen}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
          </StripBtn>
        </div>
      </div>

      {/* ── Chat overlay (conditionally mounted) ── */}
      {chatMounted && (
        <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 340, background: "rgba(10,10,10,0.97)", backdropFilter: "blur(20px)", borderLeft: "1px solid rgba(255,255,255,0.07)", transform: chatOpen ? "translateX(0)" : "translateX(340px)", transition: "transform 0.28s ease", zIndex: 50, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>Live Chat</span>
            <button onClick={closeChat} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 16, padding: 4 }}>✕</button>
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
            <ChatInput onSend={text => { webrtcRef.current?.sendChat(text); setChatMessages(prev => [...prev, { id: crypto.randomUUID(), from: "You", text, timestamp: Date.now() }]); }} />
          </div>
        </div>
      )}

      {/* ── Chat toasts ── */}
      {!chatOpen && (
        <div style={{ position: "absolute", bottom: 128, right: 16, zIndex: 60, display: "flex", flexDirection: "column-reverse", gap: 8, alignItems: "flex-end", maxWidth: 270, pointerEvents: "none" }}>
          {chatToasts.map(t => <ChatToast key={t.id} from={t.from} text={t.text} />)}
        </div>
      )}
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────

function ChatToast({ from, text }: { from: string; text: string }) {
  const [vis, setVis] = useState(true);
  useEffect(() => { const t = setTimeout(() => setVis(false), 2800); return () => clearTimeout(t); }, []);
  return (
    <div style={{ background: "rgba(15,15,15,0.96)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#e2e8f0", opacity: vis ? 1 : 0, transition: "opacity 0.3s", maxWidth: 270 }}>
      <div style={{ fontSize: 11, color: "#818cf8", fontWeight: 600, marginBottom: 3 }}>{from}</div>
      <div style={{ lineHeight: 1.4 }}>{text}</div>
    </div>
  );
}

function StatusBadge({ status, progress }: { status: Status; progress: number }) {
  const cfg: Record<Status, { color: string; text: string }> = {
    connecting: { color: "#eab308", text: "Connecting" }, connected: { color: "#3b82f6", text: "Connected" },
    streaming: { color: "#818cf8", text: `Buffering ${progress.toFixed(0)}%` }, playing: { color: "#22c55e", text: "Watching" },
    error: { color: "#ef4444", text: "Error" }, disconnected: { color: "#6b7280", text: "Disconnected" },
  };
  const { color, text } = cfg[status];
  return <span style={{ background: `${color}18`, border: `1px solid ${color}40`, color, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />{text}</span>;
}

function ChatInput({ onSend }: { onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form onSubmit={e => { e.preventDefault(); if (text.trim()) { onSend(text.trim()); setText(""); } }} style={{ display: "flex", gap: 8 }}>
      <input type="text" value={text} onChange={e => setText(e.target.value)} placeholder="Type a message..."
        style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: 10, padding: "10px 12px", fontSize: 13, outline: "none" }}
        onFocus={e => e.target.style.borderColor = "#6366f1"} onBlur={e => e.target.style.borderColor = "rgba(255,255,255,0.1)"} />
      <button type="submit" disabled={!text.trim()} style={{ background: text.trim() ? "linear-gradient(135deg,#818cf8,#6366f1)" : "rgba(255,255,255,0.1)", color: text.trim() ? "white" : "rgba(255,255,255,0.4)", border: "none", borderRadius: 10, padding: "0 14px", cursor: text.trim() ? "pointer" : "default", display: "flex", alignItems: "center" }}>
        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
      </button>
    </form>
  );
}

function MiniBtn({ children, onClick }: { children: React.ReactNode; onClick?: React.MouseEventHandler }) {
  return <button onClick={onClick} style={{ background: "rgba(0,0,0,0.6)", border: "none", borderRadius: 4, padding: "2px 4px", fontSize: 11, cursor: "pointer", color: "white", lineHeight: 1 }}>{children}</button>;
}
function StripBtn({ children, onClick, active }: { children: React.ReactNode; onClick?: () => void; active?: boolean }) {
  return <button onClick={onClick} style={{ background: active ? "rgba(99,102,241,0.9)" : "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.12)", color: "white", borderRadius: 10, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, transition: "background 0.2s" }}>{children}</button>;
}
function Spinner({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}><circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.15)" strokeWidth="3" /><path fill="#6366f1" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>;
}
