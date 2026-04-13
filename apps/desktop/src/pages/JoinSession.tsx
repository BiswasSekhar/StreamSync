import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { JoinWebRTC, CameraPermissionStatus } from "../lib/joinWebrtc";
import { SyncMessage } from "../lib/sync";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "../store/session";
import { VideoOverlay } from "../components/VideoOverlay";

type Status = "connecting" | "waiting-approval" | "connected" | "streaming" | "playing" | "error" | "disconnected" | "denied";
interface ChatMsg { id: string; from: string; text: string; timestamp: number; }
interface Toast { id: string; from: string; text: string; }
type CamShape = "circle" | "rounded" | "square";
interface FloatPos { x: number; y: number; }

export function JoinSession() {
  const { leaveSession, showToast } = useSessionStore();
  const [status, setStatus] = useState<Status>("connecting");
  const [chats, setChats] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMounted, setChatMounted] = useState(false);
  const [chatToasts, setChatToasts] = useState<Toast[]>([]);
  const [fileName, setFileName] = useState("Connecting...");
  const [error, setError] = useState<string | null>(null);
  const [connectTimeout, setConnectTimeout] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<CameraPermissionStatus | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [camDeniedOpen, setCamDeniedOpen] = useState(false);

  // Video
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  // Camera / PiP
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<MediaStream[]>([]);
  const [micMuted, setMicMuted] = useState(false);
  const [availCams, setAvailCams] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamId, setSelectedCamId] = useState("");
  const [camShape, setCamShape] = useState<CamShape>("rounded");
  const [camSizes, setCamSizes] = useState<Map<string, number>>(new Map());
  const [floatPos, setFloatPos] = useState<Map<string, FloatPos>>(new Map());
  const [hoveredTile, setHoveredTile] = useState<string | null>(null);
  const [showShapeMenu, setShowShapeMenu] = useState<string | null>(null);
  const [showCamPicker, setShowCamPicker] = useState<string | null>(null);
  const dragging = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const floatPosRef = useRef(floatPos);
  floatPosRef.current = floatPos;

  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const rtcRef = useRef<JoinWebRTC | null>(null);
  const pendingSyncRef = useRef<SyncMessage | null>(null);
  const suppressControlRef = useRef(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const roomUrl = useSessionStore(s => s.joinRoomUrl);
  const torrentProgress = useSessionStore(s => s.torrentProgress);

  const bufferingLabel = useMemo(() => {
    if (status === "playing") return "Watching";
    if (status !== "streaming") return "Buffering...";
    if (!torrentProgress) return "Buffering...";

    if (torrentProgress.totalBytes > 0) {
      const percent = Math.min(100, (torrentProgress.haveBytes / torrentProgress.totalBytes) * 100);
      return `Buffering ${percent.toFixed(0)}%`;
    }

    if (torrentProgress.haveBytes > 0) {
      const downloadedMb = torrentProgress.haveBytes / (1024 * 1024);
      return `Buffering ${downloadedMb.toFixed(downloadedMb >= 10 ? 0 : 1)} MB`;
    }

    return "Buffering...";
  }, [status, torrentProgress]);

  const openChat = useCallback(() => { setChatMounted(true); requestAnimationFrame(() => setChatOpen(true)); }, []);
  const closeChat = useCallback(() => { setChatOpen(false); setTimeout(() => setChatMounted(false), 300); }, []);

  const addToast = useCallback((from: string, text: string, id: string) => {
    setChatToasts(prev => [...prev, { id, from, text }]);
    setTimeout(() => setChatToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  // Capture video element once mounted
  useEffect(() => {
    if (videoRef.current) setVideoEl(videoRef.current);
  }, []);

  // Extend timeout to 30s to account for approval wait
  useEffect(() => {
    if (status !== "connecting" && status !== "waiting-approval") { setConnectTimeout(false); return; }
    const t = setTimeout(() => setConnectTimeout(true), 30_000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (localStream && localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    remoteStreams.forEach(s => {
      const el = remoteVideoRefs.current.get(s.id);
      if (el && el.srcObject !== s) el.srcObject = s;
    });
  }, [remoteStreams]);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chats]);

  const handleSync = useCallback((sync: SyncMessage) => {
    const v = videoRef.current;
    if (v && rtcRef.current) {
      const changed = rtcRef.current.applySync(sync, v);
      if (changed) suppressControlRef.current = Date.now() + 500;
    } else {
      pendingSyncRef.current = sync;
    }
  }, []);

  const handleMagnet = useCallback(async (magnet: string, name: string) => {
    setStatus("streaming"); setFileName(name || "Video");
    try {
      await invoke("load_magnet_link", { magnetLink: magnet });
    } catch (e: any) {
      setError(`Failed to load torrent: ${e}`);
      setStatus("error");
    }
  }, []);

  // Listen for the torrent video becoming available locally
  useEffect(() => {
    const unlisten = listen("torrent-video-ready", (event: any) => {
      const v = videoRef.current;
      if (!v) return;
      v.src = "http://localhost:8787/host-video";
      v.oncanplay = () => {
        setStatus("playing");
        if (pendingSyncRef.current && rtcRef.current) {
          rtcRef.current.applySync(pendingSyncRef.current, v);
          pendingSyncRef.current = null;
        }
      };
      v.onerror = () => { setError("Video failed to load."); setStatus("error"); };
    });
    return () => {
      unlisten.then(un => un());
    };
  }, []);

  const handleChat = useCallback((msg: ChatMsg) => {
    setChats(prev => [...prev, msg]);
    addToast(msg.from, msg.text, msg.id);
  }, [addToast]);

  const handleRemoteStream = useCallback((stream: MediaStream) => {
    setRemoteStreams(prev => prev.some(s => s.id === stream.id) ? prev : [...prev, stream]);
  }, []);

  useEffect(() => {
    if (!roomUrl) { setError("No room URL"); setStatus("error"); return; }
    const rtc = new JoinWebRTC(
      handleMagnet,
      handleSync,
      handleChat,
      () => { setStatus("connected"); showToast("Connected to host!", "success"); },
      () => { setStatus("disconnected"); showToast("Disconnected", "warning"); },
      // onJoinDenied
      (reason) => { setError(reason); setStatus("denied"); showToast(reason, "error"); },
      // onCameraStream — auto-opens; also called on retry
      (stream, camSt) => {
        setCameraStatus(camSt);
        if (stream) {
          setLocalStream(stream);
          if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          navigator.mediaDevices.enumerateDevices()
            .then(devs => setAvailCams(devs.filter(d => d.kind === "videoinput")));
        }
      },
      handleRemoteStream,
    );
    rtcRef.current = rtc;
    setStatus("connecting");
    rtc.connect(roomUrl).then(() => setStatus(prev => prev === "connecting" ? "waiting-approval" : prev));
    return () => { rtc.close(); };
  }, [handleMagnet, handleSync, handleChat, handleRemoteStream, roomUrl, showToast]);

  const sendControl = useCallback((action: "play" | "pause" | "seek") => {
    if (Date.now() < suppressControlRef.current) return;
    rtcRef.current?.sendPlaybackControl(action, videoRef.current?.currentTime ?? 0);
  }, []);

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    rtcRef.current?.sendChat(text);
    setChats(prev => [...prev, { id: crypto.randomUUID(), from: "You", text, timestamp: Date.now() }]);
    setChatInput("");
  };

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
      setShowCamPicker(null);
    } catch { showToast("Camera switch failed", "error"); }
  };

  const toggleCamera = useCallback(async (deviceId?: string) => {
    if (cameraOn && localStream && !deviceId) {
      // Turn OFF
      localStream.getTracks().forEach(t => t.stop());
      setLocalStream(null); setCameraOn(false);
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
    } else {
      // Turn ON (or switch device)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 640, height: 480, frameRate: 30 },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        localStream?.getTracks().forEach(t => t.stop());
        setLocalStream(stream); setCameraOn(true); setCameraStatus("granted"); setCamDeniedOpen(false);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        // Add tracks to peer connection if already connected
        if (rtcRef.current) {
          stream.getTracks().forEach(track => {
            // addTrack is on the PeerConnection — use openCamera which does this
          });
          rtcRef.current.openCamera();
        }
        const devs = await navigator.mediaDevices.enumerateDevices();
        setAvailCams(devs.filter(d => d.kind === "videoinput"));
        if (deviceId) setSelectedCamId(deviceId);
      } catch (err: any) {
        if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
          setCameraStatus("denied"); setCamDeniedOpen(true);
        } else {
          showToast("Camera access failed", "error");
        }
      }
    }
  }, [cameraOn, localStream, showToast]);

  const handleLeave = () => { rtcRef.current?.close(); localStream?.getTracks().forEach(t => t.stop()); leaveSession(); };

  const camTiles = useMemo(() => [
    ...(localStream ? [{ id: "local", label: "You", isLocal: true }] : []),
    ...remoteStreams.map((s, i) => ({ id: s.id, label: i === 0 ? "Host" : `Viewer ${i}`, isLocal: false })),
  ], [localStream, remoteStreams]);

  // Initialize PiP positions for new tiles
  const camTileIdStr = camTiles.map(t => t.id).join(",");
  useEffect(() => {
    const ids = camTileIdStr ? camTileIdStr.split(",") : [];
    setFloatPos(prev => {
      const n = new Map(prev);
      let changed = false;
      let col = n.size;
      ids.forEach(id => {
        if (!n.has(id)) {
          n.set(id, { x: window.innerWidth - 196, y: 70 + col * 150 });
          col++;
          changed = true;
        }
      });
      return changed ? n : prev;
    });
  }, [camTileIdStr]);

  const onTileMouseDown = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const pos = floatPosRef.current.get(id) ?? { x: 0, y: 0 };
    dragging.current = { id, ox: e.clientX - pos.x, oy: e.clientY - pos.y };
    const move = (ev: MouseEvent) => {
      if (!dragging.current || dragging.current.id !== id) return;
      const d = dragging.current;
      setFloatPos(prev => { const n = new Map(prev); n.set(id, { x: ev.clientX - d.ox, y: ev.clientY - d.oy }); return n; });
    };
    const up = () => { dragging.current = null; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, []);

  const getTileSize = (id: string) => camSizes.get(id) ?? 160;
  const changeSize = (id: string, delta: number) => {
    setCamSizes(prev => { const n = new Map(prev); n.set(id, Math.max(80, Math.min(320, (n.get(id) ?? 160) + delta))); return n; });
  };
  const shapeRadius = (s: CamShape) => s === "circle" ? "50%" : s === "rounded" ? "12px" : "4px";

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* ── Connection states ── */}
      {(status === "connecting" || status === "connected" || status === "waiting-approval") && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <Spinner size={36} />
          <p style={{ color: "#94a3b8", fontSize: 15, margin: 0 }}>
            {status === "waiting-approval" ? "Waiting for host to admit you…" :
             status === "connected" ? "Waiting for host..." : "Connecting..."}
          </p>
          {status === "waiting-approval" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.25)", borderRadius: 10, padding: "10px 16px", maxWidth: 340, textAlign: "center" }}>
              <span style={{ fontSize: 18 }}>🔒</span>
              <span style={{ color: "#a5b4fc", fontSize: 13, lineHeight: 1.45 }}>
                Your join request has been sent. The host needs to approve it before you can watch.
              </span>
            </div>
          )}
          {(status === "connecting") && connectTimeout && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)", borderRadius: 10, padding: "10px 16px", maxWidth: 360, textAlign: "center" }}>
              <svg width="16" height="16" fill="none" stroke="#eab308" strokeWidth="2" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <span style={{ color: "#fbbf24", fontSize: 13, lineHeight: 1.45 }}>
                Taking too long? Make sure the Room Code is correct and the host is online.
              </span>
            </div>
          )}
        </div>
      )}
      {error && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 14, padding: "24px 32px", maxWidth: 360, textAlign: "center" }}>
            <p style={{ color: "#f87171", margin: 0, fontSize: 14 }}>{error}</p>
            <button onClick={handleLeave} style={{ ...btnGhost, marginTop: 16 }}>Go Back</button>
          </div>
        </div>
      )}
      {status === "streaming" && (
        <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", zIndex: 30, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 18px", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#e2e8f0" }}>
          <Spinner size={16} /> {bufferingLabel}
        </div>
      )}

      {/* ── Fullscreen video ── */}
      <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, right: chatOpen ? 340 : 0, transition: "right 0.28s ease", display: (status === "streaming" || status === "playing") ? "block" : "none" }}>
        <video
          ref={videoRef}
          onPlay={() => sendControl("play")}
          onPause={() => sendControl("pause")}
          onSeeked={() => sendControl("seek")}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
        {videoEl && <VideoOverlay videoEl={videoEl} />}
      </div>

      {/* ── PiP camera tiles ── */}
      {camTiles.map(tile => {
        const pos = floatPos.get(tile.id);
        if (!pos) return null;
        const size = getTileSize(tile.id);
        const tileW = size;
        const tileH = camShape === "circle" ? size : Math.round(size * 0.75);
        const radius = shapeRadius(camShape);
        const hovered = hoveredTile === tile.id;
        const stream = tile.isLocal ? localStream : remoteStreams.find(s => s.id === tile.id) ?? null;

        return (
          <div key={tile.id}
            onMouseEnter={() => setHoveredTile(tile.id)}
            onMouseLeave={() => { setHoveredTile(null); setShowShapeMenu(null); setShowCamPicker(null); }}
            style={{ position: "absolute", left: pos.x, top: pos.y, zIndex: 70, userSelect: "none", width: tileW }}>

            <div onMouseDown={e => onTileMouseDown(tile.id, e)}
              style={{ width: tileW, height: tileH, borderRadius: radius, overflow: "hidden", border: `2px solid ${hovered ? "rgba(99,102,241,0.8)" : "rgba(255,255,255,0.15)"}`, background: "#111", cursor: "grab", position: "relative", transition: "border-color 0.2s", boxShadow: "0 4px 24px rgba(0,0,0,0.6)" }}>

              {/* Video feed */}
              {tile.isLocal ? (
                <video ref={el => { if (el && localStream && el.srcObject !== localStream) el.srcObject = localStream; }} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
              ) : (
                <video
                  ref={el => { if (el && stream) { remoteVideoRefs.current.set(tile.id, el); if (el.srcObject !== stream) el.srcObject = stream; } }}
                  autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              )}

              {/* Label */}
              <div style={{ position: "absolute", bottom: 6, left: 8, fontSize: 10, color: "white", background: "rgba(0,0,0,0.7)", padding: "2px 6px", borderRadius: 4, pointerEvents: "none" }}>{tile.label}</div>

              {/* Hover controls inside tile */}
              {hovered && (
                <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
                  style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(0,0,0,0.72)", padding: "6px 4px", display: "flex", gap: 4, justifyContent: "center", alignItems: "center" }}>
                  {tile.isLocal && (
                    <TileCtrlBtn onClick={toggleMic} title={micMuted ? "Unmute" : "Mute"}>
                      {micMuted ? "🔇" : "🎤"}
                    </TileCtrlBtn>
                  )}
                  <div style={{ position: "relative" }}>
                    <TileCtrlBtn onClick={() => setShowShapeMenu(s => s === tile.id ? null : tile.id)} title="Shape">⬡</TileCtrlBtn>
                    {showShapeMenu === tile.id && (
                      <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: "50%", transform: "translateX(-50%)", background: "#111", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 6, display: "flex", gap: 4, zIndex: 10 }}>
                        {(["circle", "rounded", "square"] as CamShape[]).map(s => (
                          <button key={s} onClick={() => { setCamShape(s); setShowShapeMenu(null); }}
                            style={{ width: 26, height: 26, background: camShape === s ? "rgba(99,102,241,0.4)" : "rgba(255,255,255,0.08)", border: `1px solid ${camShape === s ? "#6366f1" : "rgba(255,255,255,0.1)"}`, borderRadius: s === "circle" ? "50%" : s === "rounded" ? 6 : 2, cursor: "pointer", fontSize: 13, color: "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {s === "circle" ? "●" : s === "rounded" ? "▢" : "□"}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <TileCtrlBtn onClick={() => changeSize(tile.id, -20)} title="Shrink">−</TileCtrlBtn>
                  <TileCtrlBtn onClick={() => changeSize(tile.id, 20)} title="Grow">+</TileCtrlBtn>
                  {tile.isLocal && availCams.length > 0 && (
                    <div style={{ position: "relative" }}>
                      <TileCtrlBtn onClick={() => setShowCamPicker(s => s === tile.id ? null : tile.id)} title="Switch camera">⚙</TileCtrlBtn>
                      {showCamPicker === tile.id && (
                        <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: "50%", transform: "translateX(-50%)", background: "#111", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: 6, minWidth: 160, zIndex: 10 }}>
                          {availCams.map(cam => (
                            <button key={cam.deviceId} onClick={() => switchCamera(cam.deviceId)}
                              style={{ display: "block", width: "100%", background: selectedCamId === cam.deviceId ? "rgba(99,102,241,0.2)" : "transparent", border: "none", color: "#e2e8f0", padding: "5px 8px", fontSize: 11, cursor: "pointer", borderRadius: 4, textAlign: "left" }}>
                              {cam.label || `Camera ${availCams.indexOf(cam) + 1}`}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* ── Top bar ── */}
      <div style={{ position: "absolute", top: 0, left: 0, right: chatOpen ? 340 : 0, zIndex: 20, background: "linear-gradient(to bottom, rgba(0,0,0,0.88), transparent)", padding: "12px 20px", display: "flex", alignItems: "center", gap: 10, pointerEvents: "none" }}>
        <div style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
          <div style={{ width: 26, height: 26, background: "linear-gradient(135deg,#818cf8,#6366f1)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="12" height="12" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </div>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>StreamSync</span>
          <span style={{ fontSize: 12, color: "#94a3b8" }}>{fileName}</span>
        </div>
        <div style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge status={status} text={bufferingLabel} />
          <button onClick={handleLeave} style={btnGhost}>← Leave</button>
        </div>
      </div>

      {/* ── Camera permission denied guidance popup ── */}
      {camDeniedOpen && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 90, background: "rgba(10,10,18,0.98)", backdropFilter: "blur(20px)", border: "1px solid rgba(234,179,8,0.3)", borderRadius: 18, padding: "28px 32px", maxWidth: 380, textAlign: "center", boxShadow: "0 8px 40px rgba(0,0,0,0.7)" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🎥</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Camera Access Denied</div>
          <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.5, margin: "0 0 16px" }}>
            You previously blocked camera access. To fix this:<br />
            <strong style={{ color: "#fbbf24" }}>Click the 🔒 icon</strong> in your browser's address bar → set Camera & Microphone to <strong style={{ color: "#4ade80" }}>Allow</strong> → then refresh.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              onClick={async () => { setCamDeniedOpen(false); await toggleCamera(); }}
              style={{ background: "linear-gradient(135deg,#818cf8,#6366f1)", border: "none", color: "white", borderRadius: 10, padding: "9px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >Try Again</button>
            <button
              onClick={() => setCamDeniedOpen(false)}
              style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8", borderRadius: 10, padding: "9px 20px", fontSize: 13, cursor: "pointer" }}
            >Skip</button>
          </div>
        </div>
      )}

      {/* ── Floating action buttons (right edge, vertically centered) ── */}
      <div style={{ position: "absolute", right: (chatOpen ? 340 : 0) + 16, top: "50%", transform: "translateY(-50%)", zIndex: 25, display: "flex", flexDirection: "column", gap: 10 }}>
        <StripBtn onClick={() => toggleCamera()} title={cameraOn ? "Turn off camera" : "Turn on camera"} active={cameraOn}>
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
          </svg>
        </StripBtn>
        <StripBtn onClick={chatOpen ? closeChat : openChat} active={chatOpen} title="Chat">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
        </StripBtn>
      </div>

      {/* ── Chat overlay ── */}
      {chatMounted && (
        <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 340, background: "rgba(10,10,10,0.97)", backdropFilter: "blur(20px)", borderLeft: "1px solid rgba(255,255,255,0.07)", transform: chatOpen ? "translateX(0)" : "translateX(340px)", transition: "transform 0.28s ease", zIndex: 50, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>Live Chat</span>
            <button onClick={closeChat} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 4, fontSize: 16 }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
            {chats.length === 0 && <p style={{ color: "#555", fontSize: 13, textAlign: "center", marginTop: 24 }}>No messages yet</p>}
            {chats.map(msg => (
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
        <div style={{ position: "absolute", bottom: 80, right: 16, zIndex: 60, display: "flex", flexDirection: "column-reverse", gap: 8, alignItems: "flex-end", maxWidth: 270, pointerEvents: "none" }}>
          {chatToasts.map(t => <ChatToast key={t.id} from={t.from} text={t.text} />)}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

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

function StatusBadge({ status, text }: { status: Status; text: string }) {
  const cfg: Record<Status, { color: string; text: string }> = {
    connecting: { color: "#eab308", text: "Connecting" },
    "waiting-approval": { color: "#818cf8", text: "Awaiting Approval" },
    connected: { color: "#3b82f6", text: "Connected" },
    streaming: { color: "#818cf8", text },
    playing: { color: "#22c55e", text: "Watching" },
    error: { color: "#ef4444", text: "Error" },
    disconnected: { color: "#6b7280", text: "Disconnected" },
    denied: { color: "#ef4444", text: "Admission Denied" },
  };
  const { color, text: label } = cfg[status];
  return <span style={{ background: `${color}18`, border: `1px solid ${color}40`, color, borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />{label}</span>;
}

function TileCtrlBtn({ children, onClick, title }: { children: React.ReactNode; onClick?: React.MouseEventHandler; title?: string }) {
  return <button onClick={onClick} title={title} style={{ background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 5, padding: "2px 6px", fontSize: 12, cursor: "pointer", color: "white", lineHeight: 1.4, minWidth: 24, display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</button>;
}

function StripBtn({ children, onClick, active, title }: { children: React.ReactNode; onClick?: () => void; active?: boolean; title?: string }) {
  return <button onClick={onClick} title={title} style={{ pointerEvents: "auto", background: active ? "rgba(99,102,241,0.9)" : "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.12)", color: "white", borderRadius: 10, width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, transition: "background 0.2s" }}>{children}</button>;
}

function Spinner({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} fill="none" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}><circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.15)" strokeWidth="3" /><path fill="#6366f1" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>;
}

const btnGhost: React.CSSProperties = { background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.1)", color: "#e2e8f0", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer" };
