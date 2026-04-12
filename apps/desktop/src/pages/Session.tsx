import React, { useEffect, useRef, useCallback, useState } from "react";
import { useSessionStore } from "../store/session";
import { VideoPlayer } from "../components/VideoPlayer";
import { RoomLink } from "../components/RoomLink";
import { HostWebRTC } from "../lib/hostWebrtc";

interface ChatMsg { id: string; from: string; text: string; timestamp: number; }
interface Toast { id: string; from: string; text: string; }

export function Session() {
  const { peers, roomUrl, closeRoom, leaveSession, sessionId, showToast, messages, displayName } = useSessionStore();
  const hostRtcRef = useRef<HostWebRTC | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);

  // Camera state
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  // Remote peer camera streams
  const [peerStreams, setPeerStreams] = useState<Map<string, MediaStream>>(new Map());
  const peerVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  // Chat UI
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatToasts, setChatToasts] = useState<Toast[]>([]);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const addToast = useCallback((from: string, text: string, id: string) => {
    setChatToasts(prev => [...prev, { id, from, text }]);
    setTimeout(() => setChatToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  const handleRemoteStream = useCallback((peerId: string, stream: MediaStream) => {
    setPeerStreams(prev => { const n = new Map(prev); n.set(peerId, stream); return n; });
  }, []);

  const handlePlaybackControl = useCallback((
    action: "play" | "pause" | "seek",
    position: number,
    _fromPeerId: string
  ) => {
    const video = videoElementRef.current;
    if (!video) return;
    if (action === "seek") video.currentTime = position;
    if (action === "play" && video.paused) video.play().catch(console.error);
    if (action === "pause" && !video.paused) video.pause();
    // Video events fire → Zustand updates → subscriber broadcasts sync to everyone
  }, []);

  // Init HostWebRTC
  useEffect(() => {
    if (!sessionId || !roomUrl) return;

    const rtc = new HostWebRTC(
      (peerId, name) => {
        useSessionStore.setState(s => ({ peers: [...s.peers, { id: peerId, displayName: name, videoPosition: 0, connected: true }] }));
        showToast(`${name} joined`, "info");
      },
      (peerId) => {
        useSessionStore.setState(s => ({ peers: s.peers.filter(p => p.id !== peerId) }));
        setPeerStreams(prev => { const n = new Map(prev); n.delete(peerId); return n; });
      },
      (msg) => {
        useSessionStore.setState(s => ({ messages: [...s.messages, msg] }));
        addToast(msg.from, msg.text, msg.id);
      },
      (err) => { console.error("[Session]", err); showToast(`WebRTC error: ${err}`, "error"); },
      handleRemoteStream,
      handlePlaybackControl,
    );

    hostRtcRef.current = rtc;
    rtc.connect(sessionId, displayName || "Host");
    return () => { rtc.close(); hostRtcRef.current = null; };
  }, [sessionId, roomUrl, handleRemoteStream, handlePlaybackControl, displayName, addToast, showToast]);

  // Bind magnet/videoUrl
  const magnetLink = useSessionStore(s => s.magnetLink);
  const filePath = useSessionStore(s => s.filePath);
  useEffect(() => {
    if (magnetLink && hostRtcRef.current && roomUrl) {
      const fileName = filePath?.split(/[\\/]/).pop() ?? "video";
      const base = roomUrl.split("?")[0];
      const videoUrl = base.endsWith("/") ? base + "host-video" : base + "/host-video";
      hostRtcRef.current.setMagnet(magnetLink, fileName, videoUrl);
    }
  }, [magnetLink, filePath, roomUrl]);

  // Broadcast play/pause/seek from VideoPlayer to all peers
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (!hostRtcRef.current) return;
      if (state.position !== prev.position || state.isPlaying !== prev.isPlaying) {
        hostRtcRef.current.broadcastSync(state.position, state.isPlaying);
      }
    });
    return unsub;
  }, []);

  // Forward host's own chat to peers
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (state.messages.length > prev.messages.length) {
        const msg = state.messages[state.messages.length - 1];
        if (msg.from === (displayName || "Host") && hostRtcRef.current) {
          hostRtcRef.current.broadcastChat(msg);
        }
      }
    });
    return unsub;
  }, [displayName]);

  // Heartbeat — 1 s interval, even when paused
  const handleHeartbeat = useCallback((position: number, playing: boolean) => {
    hostRtcRef.current?.broadcastSync(position, playing);
  }, []);

  const handleVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoElementRef.current = el;
  }, []);

  // Camera toggle
  const toggleCamera = useCallback(async () => {
    if (cameraOn && localStream) {
      localStream.getTracks().forEach(t => t.stop());
      setLocalStream(null);
      setCameraOn(false);
      hostRtcRef.current?.setLocalStream(null);
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, frameRate: 30 },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        setLocalStream(stream);
        setCameraOn(true);
        hostRtcRef.current?.setLocalStream(stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      } catch (e) {
        showToast("Camera access denied", "error");
      }
    }
  }, [cameraOn, localStream, showToast]);

  useEffect(() => {
    if (localStream && localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Attach peer streams to video elements
  useEffect(() => {
    peerStreams.forEach((stream, peerId) => {
      const el = peerVideoRefs.current.get(peerId);
      if (el && el.srcObject !== stream) el.srcObject = stream;
    });
  }, [peerStreams]);

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    const msg: ChatMsg = { id: crypto.randomUUID(), from: displayName || "Host", text, timestamp: Date.now() };
    useSessionStore.setState(s => ({ messages: [...s.messages, msg] }));
    setChatInput("");
  };

  const camTiles = [
    ...(localStream ? [{ id: "local", label: "You (Host)", isLocal: true }] : []),
    ...[...peerStreams.entries()].map(([id], i) => ({ id, label: peers.find(p => p.id === id)?.displayName ?? `Viewer ${i + 1}`, isLocal: false })),
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* ── Fullscreen video ── */}
      <div style={{ position: "absolute", inset: 0 }}>
        <VideoPlayer onVideoRef={handleVideoRef} onHeartbeat={handleHeartbeat} />
      </div>

      {/* ── Top gradient bar ── */}
      <div style={{ position: "absolute", top: 0, left: 0, right: chatOpen ? 340 : 0, zIndex: 20, background: "linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, transparent 100%)", padding: "12px 20px", display: "flex", alignItems: "center", gap: 12, pointerEvents: "none" }}>
        <div style={{ pointerEvents: "all", display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <div style={{ width: 28, height: 28, background: "linear-gradient(135deg,#818cf8,#6366f1)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg width="14" height="14" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </div>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#f1f5f9", letterSpacing: "-0.01em" }}>StreamSync</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "3px 10px", fontSize: 12, color: "#94a3b8" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 6px #22c55e" }} />
            {peers.length} viewer{peers.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ pointerEvents: "all", display: "flex", alignItems: "center", gap: 8 }}>
          {roomUrl && <RoomLink compact />}
          <button onClick={leaveSession} style={btnGhost}>← Back</button>
          <button onClick={closeRoom} style={btnDanger}>End</button>
        </div>
      </div>

      {/* ── Bottom gradient + camera strip ── */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: chatOpen ? 340 : 0, zIndex: 20, background: "linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%)", padding: "20px 16px 16px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, overflowX: "auto", scrollbarWidth: "none" }}>
          {/* Camera tiles */}
          {camTiles.map(tile => (
            <div key={tile.id} style={{ position: "relative", flexShrink: 0, width: 136, height: 84, borderRadius: 10, overflow: "hidden", border: "2px solid rgba(255,255,255,0.12)", background: "#111" }}>
              {tile.isLocal ? (
                <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
              ) : (
                <video
                  ref={el => { if (el) { peerVideoRefs.current.set(tile.id, el); if (el.srcObject !== peerStreams.get(tile.id)) el.srcObject = peerStreams.get(tile.id) ?? null; } }}
                  autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              )}
              <div style={{ position: "absolute", bottom: 4, left: 6, fontSize: 10, color: "white", background: "rgba(0,0,0,0.65)", padding: "1px 6px", borderRadius: 4, backdropFilter: "blur(4px)" }}>{tile.label}</div>
            </div>
          ))}

          {camTiles.length === 0 && (
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 8 }}>No cameras on</span>
          )}

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Camera toggle */}
          <button onClick={toggleCamera} title={cameraOn ? "Turn off camera" : "Turn on camera"} style={{ ...iconBtn, background: cameraOn ? "rgba(99,102,241,0.9)" : "rgba(255,255,255,0.1)", flexShrink: 0 }}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              {cameraOn
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                : <><path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" /><line x1="2" y1="2" x2="22" y2="22" strokeLinecap="round" /></>
              }
            </svg>
          </button>

          {/* Chat toggle */}
          <button onClick={() => setChatOpen(o => !o)} title="Chat" style={{ ...iconBtn, background: chatOpen ? "rgba(99,102,241,0.9)" : "rgba(255,255,255,0.1)", position: "relative", flexShrink: 0 }}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Chat overlay panel ── */}
      <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 340, background: "rgba(10,10,10,0.97)", backdropFilter: "blur(20px)", borderLeft: "1px solid rgba(255,255,255,0.07)", transform: chatOpen ? "translateX(0)" : "translateX(340px)", transition: "transform 0.28s ease", zIndex: 50, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>Live Chat</span>
          <button onClick={() => setChatOpen(false)} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4, borderRadius: 6, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && <p style={{ color: "#555", fontSize: 13, textAlign: "center", marginTop: 24 }}>No messages yet</p>}
          {messages.map(msg => (
            <div key={msg.id}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: "#818cf8", fontWeight: 600 }}>{msg.from}</span>
                <span style={{ fontSize: 11, color: "#555" }}>{new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.45, background: "rgba(255,255,255,0.05)", padding: "8px 12px", borderRadius: "0 10px 10px 10px" }}>{msg.text}</p>
            </div>
          ))}
          <div ref={chatBottomRef} />
        </div>
        <div style={{ padding: "12px 14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendChat()}
              placeholder="Message..."
              style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#f1f5f9", borderRadius: 10, padding: "10px 12px", fontSize: 13, outline: "none" }}
            />
            <button onClick={sendChat} style={{ background: "linear-gradient(135deg,#818cf8,#6366f1)", border: "none", color: "white", borderRadius: 10, padding: "0 14px", cursor: "pointer", display: "flex", alignItems: "center" }}>
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
            </button>
          </div>
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

// Shared button styles
const btnGhost: React.CSSProperties = { background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", color: "#e2e8f0", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 500 };
const btnDanger: React.CSSProperties = { background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 500 };
const iconBtn: React.CSSProperties = { border: "1px solid rgba(255,255,255,0.12)", color: "white", borderRadius: 10, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "background 0.2s" };
