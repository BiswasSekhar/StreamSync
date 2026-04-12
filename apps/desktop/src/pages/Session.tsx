import React, { useEffect, useRef, useCallback, useState } from "react";
import { useSessionStore } from "../store/session";
import { VideoPlayer } from "../components/VideoPlayer";
import { VideoOverlay } from "../components/VideoOverlay";
import { RoomLink } from "../components/RoomLink";
import { HostWebRTC } from "../lib/hostWebrtc";

interface ChatMsg { id: string; from: string; text: string; timestamp: number; }
interface Toast { id: string; from: string; text: string; }

type CamShape = "circle" | "rounded" | "square";
interface CamTile { id: string; label: string; stream: MediaStream | null; isLocal: boolean; }
interface FloatPos { x: number; y: number; }

export function Session() {
  const { peers, roomUrl, closeRoom, leaveSession, sessionId, showToast, messages, displayName } = useSessionStore();
  const hostRtcRef = useRef<HostWebRTC | null>(null);

  // Video element (exposed by VideoPlayer via onVideoRef)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const handleVideoRef = useCallback((el: HTMLVideoElement | null) => setVideoEl(el), []);

  // Camera state
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [availCams, setAvailCams] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamId, setSelectedCamId] = useState<string>("");
  const [showCamPicker, setShowCamPicker] = useState(false);
  const [peerStreams, setPeerStreams] = useState<Map<string, MediaStream>>(new Map());
  const peerVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  // Camera presentation
  const [camShape, setCamShape] = useState<CamShape>("rounded");
  const [pinnedCam, setPinnedCam] = useState<string | null>(null);
  const [showShapeMenu, setShowShapeMenu] = useState(false);
  const [floatPos, setFloatPos] = useState<Map<string, FloatPos>>(new Map());
  const dragging = useRef<{ id: string; ox: number; oy: number } | null>(null);

  // Chat
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMounted, setChatMounted] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatToasts, setChatToasts] = useState<Toast[]>([]);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  const openChat = useCallback(() => { setChatMounted(true); requestAnimationFrame(() => setChatOpen(true)); }, []);
  const closeChat = useCallback(() => { setChatOpen(false); setTimeout(() => setChatMounted(false), 300); }, []);

  const addToast = useCallback((from: string, text: string, id: string) => {
    setChatToasts(prev => [...prev, { id, from, text }]);
    setTimeout(() => setChatToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  const handleRemoteStream = useCallback((peerId: string, stream: MediaStream) => {
    setPeerStreams(prev => { const n = new Map(prev); n.set(peerId, stream); return n; });
  }, []);

  const handlePlaybackControl = useCallback((action: "play" | "pause" | "seek", position: number) => {
    const v = videoEl;
    if (!v) return;
    if (action === "seek") v.currentTime = position;
    if (action === "play" && v.paused) v.play().catch(console.error);
    if (action === "pause" && !v.paused) v.pause();
  }, [videoEl]);

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

  // Magnet / video URL
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

  // Broadcast play/pause/seek from VideoPlayer to peers
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (!hostRtcRef.current) return;
      if (state.position !== prev.position || state.isPlaying !== prev.isPlaying) {
        hostRtcRef.current.broadcastSync(state.position, state.isPlaying);
      }
    });
    return unsub;
  }, []);

  // Forward host chat to peers
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

  // Heartbeat
  const handleHeartbeat = useCallback((pos: number, play: boolean) => {
    hostRtcRef.current?.broadcastSync(pos, play);
  }, []);

  // Camera toggle
  const toggleCamera = useCallback(async (deviceId?: string) => {
    if (cameraOn && localStream && !deviceId) {
      localStream.getTracks().forEach(t => t.stop());
      setLocalStream(null); setCameraOn(false);
      hostRtcRef.current?.setLocalStream(null);
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 640, height: 480, frameRate: 30 },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        localStream?.getTracks().forEach(t => t.stop());
        setLocalStream(stream); setCameraOn(true);
        hostRtcRef.current?.setLocalStream(stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        // Enumerate cameras after permission granted
        const devs = await navigator.mediaDevices.enumerateDevices();
        setAvailCams(devs.filter(d => d.kind === "videoinput"));
        if (deviceId) setSelectedCamId(deviceId);
      } catch { showToast("Camera access denied", "error"); }
    }
  }, [cameraOn, localStream, showToast]);

  const toggleMic = useCallback(() => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(t => { t.enabled = micMuted; });
    setMicMuted(m => !m);
  }, [localStream, micMuted]);

  useEffect(() => {
    if (localStream && localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    peerStreams.forEach((stream, id) => {
      const el = peerVideoRefs.current.get(id);
      if (el && el.srcObject !== stream) el.srcObject = stream;
    });
  }, [peerStreams]);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Camera drag handlers
  const onTileMouseDown = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault();
    const pos = floatPos.get(id);
    dragging.current = { id, ox: e.clientX - (pos?.x ?? 0), oy: e.clientY - (pos?.y ?? 0) };
    const move = (ev: MouseEvent) => {
      if (!dragging.current || dragging.current.id !== id) return;
      setFloatPos(prev => { const n = new Map(prev); n.set(id, { x: ev.clientX - dragging.current!.ox, y: ev.clientY - dragging.current!.oy }); return n; });
    };
    const up = () => { dragging.current = null; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [floatPos]);

  const shapeRadius = camShape === "circle" ? "50%" : camShape === "rounded" ? 10 : 0;
  const tileW = camShape === "circle" ? 84 : 136;
  const tileH = 84;

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    const msg: ChatMsg = { id: crypto.randomUUID(), from: displayName || "Host", text, timestamp: Date.now() };
    useSessionStore.setState(s => ({ messages: [...s.messages, msg] }));
    setChatInput("");
  };

  const camTiles: CamTile[] = [
    ...(localStream ? [{ id: "local", label: "You (Host)", stream: localStream, isLocal: true }] : []),
    ...[...peerStreams.entries()].map(([id], i) => ({ id, label: peers.find(p => p.id === id)?.displayName ?? `Viewer ${i + 1}`, stream: peerStreams.get(id) ?? null, isLocal: false })),
  ];

  const rightShift = chatOpen ? 340 : 0;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* ── Fullscreen video + overlay ── */}
      <div style={{ position: "absolute", inset: 0 }}>
        <VideoPlayer onVideoRef={handleVideoRef} onHeartbeat={handleHeartbeat} />
        {videoEl && <VideoOverlay videoEl={videoEl} />}
      </div>

      {/* ── Floating camera tiles (dragged off strip) ── */}
      {camTiles.filter(t => floatPos.has(t.id)).map(tile => {
        const pos = floatPos.get(tile.id)!;
        const pinned = pinnedCam === tile.id;
        const tw = pinned ? tileW * 1.5 : tileW;
        const th = pinned ? tileH * 1.5 : tileH;
        return (
          <div key={tile.id} onMouseDown={e => onTileMouseDown(tile.id, e)} onClick={() => setPinnedCam(p => p === tile.id ? null : tile.id)}
            style={{ position: "absolute", left: pos.x, top: pos.y, width: tw, height: th, zIndex: 80, cursor: "grab", userSelect: "none" }}>
            <CamVideo tile={tile} localVideoRef={tile.isLocal ? localVideoRef : undefined} peerVideoRefs={peerVideoRefs} peerStreams={peerStreams} radius={shapeRadius} tw={tw} th={th} />
            {tile.isLocal && (
              <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 3 }}>
                <MiniBtn onClick={e => { e.stopPropagation(); toggleMic(); }} title={micMuted ? "Unmute" : "Mute"}>
                  {micMuted ? "🔇" : "🎤"}
                </MiniBtn>
              </div>
            )}
          </div>
        );
      })}

      {/* ── Top bar ── */}
      <div style={{ position: "absolute", top: 0, left: 0, right: rightShift, zIndex: 20, background: "linear-gradient(to bottom, rgba(0,0,0,0.88), transparent)", padding: "12px 20px", display: "flex", alignItems: "center", gap: 12, pointerEvents: "none" }}>
        <div style={{ pointerEvents: "all", display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <div style={{ width: 28, height: 28, background: "linear-gradient(135deg,#818cf8,#6366f1)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </div>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#f1f5f9" }}>StreamSync</span>
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

      {/* ── Bottom strip ── */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: rightShift, zIndex: 20, background: "linear-gradient(to top, rgba(0,0,0,0.92), transparent)", padding: "28px 16px 14px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, overflowX: "auto", scrollbarWidth: "none" }}>

          {/* Camera tiles in strip (not floating) */}
          {camTiles.filter(t => !floatPos.has(t.id)).map(tile => {
            const pinned = pinnedCam === tile.id;
            const tw = pinned ? tileW * 1.5 : tileW;
            const th = pinned ? tileH * 1.5 : tileH;
            return (
              <div key={tile.id} style={{ position: "relative", flexShrink: 0, width: tw, height: th, borderRadius: shapeRadius, overflow: "hidden", border: `2px solid ${pinned ? "#6366f1" : "rgba(255,255,255,0.12)"}`, background: "#111", cursor: "pointer", transition: "width 0.2s, height 0.2s, border-color 0.2s" }}
                onClick={() => setPinnedCam(p => p === tile.id ? null : tile.id)}
                onMouseDown={e => { if (e.button === 0 && e.shiftKey) onTileMouseDown(tile.id, e); }}>
                <CamVideo tile={tile} localVideoRef={tile.isLocal ? localVideoRef : undefined} peerVideoRefs={peerVideoRefs} peerStreams={peerStreams} radius={shapeRadius} tw={tw} th={th} />
                <div style={{ position: "absolute", bottom: 4, left: 6, fontSize: 10, color: "white", background: "rgba(0,0,0,0.65)", padding: "1px 5px", borderRadius: 4 }}>{tile.label}</div>
                {tile.isLocal && (
                  <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 3 }}>
                    <MiniBtn onClick={e => { e.stopPropagation(); toggleMic(); }}>{micMuted ? "🔇" : "🎤"}</MiniBtn>
                    <MiniBtn onClick={e => { e.stopPropagation(); setShowCamPicker(p => !p); }}>⚙</MiniBtn>
                  </div>
                )}
                {showCamPicker && tile.isLocal && (
                  <div onClick={e => e.stopPropagation()} style={{ position: "absolute", bottom: "100%", left: 0, background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: 8, minWidth: 180, zIndex: 30, marginBottom: 4 }}>
                    {availCams.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8", padding: "4px 6px" }}>No cameras found</div>}
                    {availCams.map(cam => (
                      <button key={cam.deviceId} onClick={() => { toggleCamera(cam.deviceId); setShowCamPicker(false); }}
                        style={{ display: "block", width: "100%", background: selectedCamId === cam.deviceId ? "rgba(99,102,241,0.2)" : "transparent", border: "none", color: "#e2e8f0", padding: "6px 8px", fontSize: 12, cursor: "pointer", borderRadius: 6, textAlign: "left" }}>
                        {cam.label || `Camera ${availCams.indexOf(cam) + 1}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {camTiles.length === 0 && <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>No cameras on</span>}
          <div style={{ flex: 1 }} />

          {/* Shape menu */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <StripBtn onClick={() => setShowShapeMenu(s => !s)} title="Camera shape">⬜</StripBtn>
            {showShapeMenu && (
              <div style={{ position: "absolute", bottom: 48, right: 0, background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 10, display: "flex", gap: 8, zIndex: 30 }}>
                {(["circle", "rounded", "square"] as CamShape[]).map(s => (
                  <button key={s} onClick={() => { setCamShape(s); setShowShapeMenu(false); }}
                    style={{ width: 40, height: 40, background: camShape === s ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.07)", border: `1px solid ${camShape === s ? "#6366f1" : "rgba(255,255,255,0.1)"}`, borderRadius: s === "circle" ? "50%" : s === "rounded" ? 8 : 2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#e2e8f0" }}>
                    {s[0].toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Camera toggle */}
          <StripBtn onClick={() => toggleCamera()} title={cameraOn ? "Turn off camera" : "Turn on camera"} active={cameraOn}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          </StripBtn>

          {/* Chat toggle */}
          <StripBtn onClick={chatOpen ? closeChat : openChat} title="Chat" active={chatOpen}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </StripBtn>
        </div>
      </div>

      {/* ── Chat overlay (conditionally mounted) ── */}
      {chatMounted && (
        <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 340, background: "rgba(10,10,10,0.97)", backdropFilter: "blur(20px)", borderLeft: "1px solid rgba(255,255,255,0.07)", transform: chatOpen ? "translateX(0)" : "translateX(340px)", transition: "transform 0.28s ease", zIndex: 50, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>Live Chat</span>
            <button onClick={closeChat} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4, fontSize: 16 }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
            {messages.length === 0 && <p style={{ color: "#555", fontSize: 13, textAlign: "center", marginTop: 24 }}>No messages yet</p>}
            {messages.map(msg => (
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
            <div style={{ display: "flex", gap: 8 }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendChat()} placeholder="Message..."
                style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#f1f5f9", borderRadius: 10, padding: "10px 12px", fontSize: 13, outline: "none" }} />
              <button onClick={sendChat} style={{ background: "linear-gradient(135deg,#818cf8,#6366f1)", border: "none", color: "white", borderRadius: 10, padding: "0 14px", cursor: "pointer", display: "flex", alignItems: "center" }}>
                <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
              </button>
            </div>
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

// ── Sub-components ───────────────────────────────────────────────

function CamVideo({ tile, localVideoRef, peerVideoRefs, peerStreams, radius, tw, th }: {
  tile: { id: string; isLocal: boolean; stream: MediaStream | null };
  localVideoRef?: React.RefObject<HTMLVideoElement>;
  peerVideoRefs: React.MutableRefObject<Map<string, HTMLVideoElement>>;
  peerStreams: Map<string, MediaStream>;
  radius: string | number; tw: number; th: number;
}) {
  if (tile.isLocal) {
    return <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />;
  }
  return (
    <video ref={el => { if (el) { peerVideoRefs.current.set(tile.id, el); const s = peerStreams.get(tile.id); if (s && el.srcObject !== s) el.srcObject = s; } }} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  );
}

function ChatToast({ from, text }: { from: string; text: string }) {
  const [vis, setVis] = useState(true);
  useEffect(() => { const t = setTimeout(() => setVis(false), 2800); return () => clearTimeout(t); }, []);
  return (
    <div style={{ background: "rgba(15,15,15,0.96)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#e2e8f0", opacity: vis ? 1 : 0, transition: "opacity 0.3s", boxShadow: "0 4px 20px rgba(0,0,0,0.5)", maxWidth: 270 }}>
      <div style={{ fontSize: 11, color: "#818cf8", fontWeight: 600, marginBottom: 3 }}>{from}</div>
      <div style={{ lineHeight: 1.4 }}>{text}</div>
    </div>
  );
}

function MiniBtn({ children, onClick, title }: { children: React.ReactNode; onClick?: React.MouseEventHandler; title?: string }) {
  return (
    <button onClick={onClick} title={title} style={{ background: "rgba(0,0,0,0.6)", border: "none", borderRadius: 4, padding: "2px 4px", fontSize: 11, cursor: "pointer", color: "white", lineHeight: 1 }}>
      {children}
    </button>
  );
}

function StripBtn({ children, onClick, title, active }: { children: React.ReactNode; onClick?: () => void; title?: string; active?: boolean }) {
  return (
    <button onClick={onClick} title={title} style={{ background: active ? "rgba(99,102,241,0.9)" : "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.12)", color: "white", borderRadius: 10, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, fontSize: 18, transition: "background 0.2s" }}>
      {children}
    </button>
  );
}

const btnGhost: React.CSSProperties = { background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", color: "#e2e8f0", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer" };
const btnDanger: React.CSSProperties = { background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer" };
