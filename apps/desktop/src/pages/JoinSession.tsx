import { useEffect, useRef, useState, useCallback } from "react";
import { JoinWebRTC } from "../lib/joinWebrtc";
import { SyncMessage } from "../lib/sync";
import { useSessionStore } from "../store/session";

// WebTorrent is loaded via CDN script tag in index.html
declare const WebTorrent: any;

type Status = "connecting" | "connected" | "streaming" | "playing" | "error" | "disconnected";

interface ChatMsg {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

let wtClient: InstanceType<typeof WebTorrent> | null = null;

export function JoinSession() {
  const { leaveSession, showToast } = useSessionStore();
  const [status, setStatus] = useState<Status>("connecting");
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [chats, setChats] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const rtcRef = useRef<JoinWebRTC | null>(null);
  const pendingSyncRef = useRef<SyncMessage | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Room URL is stored in the session store
  const roomUrl = useSessionStore((s) => s.joinRoomUrl);

  const handleSync = useCallback((sync: SyncMessage) => {
    const video = videoRef.current;
    if (video && rtcRef.current) {
      rtcRef.current.applySync(sync, video);
    } else {
      pendingSyncRef.current = sync;
    }
  }, []);

  const handleMagnet = useCallback(async (magnet: string, name: string) => {
    setStatus("streaming");
    setFileName(name);
    const video = videoRef.current;
    if (!video) return;

    try {
      if (wtClient) {
        wtClient.destroy();
        wtClient = null;
      }

      wtClient = new WebTorrent();
      wtClient.add(magnet, {}, (torrent: any) => {
        const file = torrent.files.reduce((a: any, b: any) =>
          a.length > b.length ? a : b
        );

        file.renderTo(video, { autoplay: true }, (err: Error | null) => {
          if (err) {
            setError(`Playback error: ${err.message}`);
            setStatus("error");
          } else {
            setStatus("playing");
            if (pendingSyncRef.current && rtcRef.current) {
              rtcRef.current.applySync(pendingSyncRef.current, video);
              pendingSyncRef.current = null;
            }
          }
        });

        torrent.on("download", () => {
          setProgress(torrent.progress * 100);
          setSpeed(torrent.downloadSpeed);
        });

        video.addEventListener("seeking", () => {
          if (torrent.pieces && torrent.length > 0 && video.duration) {
            const fraction = video.currentTime / video.duration;
            const seekPiece = Math.floor(fraction * torrent.pieces.length);
            torrent.critical(seekPiece, Math.min(seekPiece + 20, torrent.pieces.length - 1));
          }
        });
      });

      wtClient.on("error", (err: Error) => {
        setError(`Torrent error: ${err.message}`);
        setStatus("error");
      });
    } catch (e: any) {
      setError(`Failed to start torrent: ${e}`);
      setStatus("error");
    }
  }, []);

  const handleChat = useCallback((msg: ChatMsg) => {
    setChats((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    if (!roomUrl) {
      setError("No room URL provided");
      setStatus("error");
      return;
    }

    const rtc = new JoinWebRTC(
      handleMagnet,
      handleSync,
      handleChat,
      () => setStatus("connected"),
      () => setStatus("disconnected")
    );
    rtcRef.current = rtc;

    rtc.connect(roomUrl).then((stream) => {
      if (stream) {
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      }
    });

    return () => {
      rtc.close();
      if (wtClient) { wtClient.destroy(); wtClient = null; }
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [handleMagnet, handleSync, handleChat, roomUrl]);

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    rtcRef.current?.sendChat(text);
    setChats(prev => [...prev, {
      id: crypto.randomUUID(),
      from: "You",
      text,
      timestamp: Date.now(),
    }]);
    setChatInput("");
  };

  const formatSpeed = (bps: number) => {
    if (bps > 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
    if (bps > 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
    return `${bps.toFixed(0)} B/s`;
  };

  const handleLeave = () => {
    rtcRef.current?.close();
    if (wtClient) { wtClient.destroy(); wtClient = null; }
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    leaveSession();
    showToast("Left the watch party", "info");
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0a0a0a", color: "#f0f0f0", fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Header */}
      <header style={{ padding: "14px 24px", background: "rgba(0,0,0,0.6)", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 16, backdropFilter: "blur(12px)", flexShrink: 0 }}>
        <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #818cf8, #6366f1)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <svg width="16" height="16" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>StreamSync</div>
          {fileName && <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 1 }}>{fileName}</div>}
        </div>
        <StatusPill status={status} progress={progress} speed={formatSpeed(speed)} />
        <button
          onClick={handleLeave}
          style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}
          onMouseOver={e => e.currentTarget.style.background = "rgba(239,68,68,0.25)"}
          onMouseOut={e => e.currentTarget.style.background = "rgba(239,68,68,0.15)"}
        >
          Leave
        </button>
      </header>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Video area */}
        <div style={{ flex: 1, background: "#000", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          {/* Loading states */}
          {(status === "connecting" || status === "connected") && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
              <Spinner size={40} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: "#f0f0f0" }}>
                  {status === "connecting" ? "Connecting to room..." : "Waiting for host..."}
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>
                  {status === "connecting" ? "Establishing P2P connection" : "Host will share the video shortly"}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 16, padding: "20px 28px", maxWidth: 400, textAlign: "center" }}>
              <div style={{ fontSize: 24, marginBottom: 12 }}>⚠️</div>
              <div style={{ fontSize: 14, color: "#f87171" }}>{error}</div>
              <button onClick={handleLeave} style={{ marginTop: 16, background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171", borderRadius: 10, padding: "8px 20px", fontSize: 13, cursor: "pointer" }}>Go Back</button>
            </div>
          )}

          {/* Streaming overlay */}
          {status === "streaming" && (
            <div style={{ position: "absolute", bottom: 20, left: 20, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, zIndex: 10 }}>
              <Spinner size={16} />
              <span style={{ fontSize: 13, color: "#e5e7eb" }}>Buffering {progress.toFixed(0)}%</span>
              <span style={{ fontSize: 12, color: "#6b7280" }}>·</span>
              <span style={{ fontSize: 13, color: "#818cf8" }}>{formatSpeed(speed)}</span>
            </div>
          )}

          {/* Main video player */}
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

        {/* Right sidebar */}
        <div style={{ width: 300, borderLeft: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column", background: "rgba(12,12,12,0.98)", backdropFilter: "blur(20px)" }}>
          {/* Camera */}
          <div style={{ padding: 16, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ background: "#050505", borderRadius: 12, overflow: "hidden", aspectRatio: "16/9", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(255,255,255,0.05)" }}>
              {localStreamRef.current ? (
                <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                  <svg width="20" height="20" fill="none" stroke="#444" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span style={{ fontSize: 11, color: "#555" }}>Camera off</span>
                </div>
              )}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280", textAlign: "center" }}>Your Camera</div>
          </div>

          {/* Chat */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)", fontSize: 12, color: "#6b7280", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Live Chat
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {chats.length === 0 ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ color: "#444", fontSize: 13 }}>No messages yet</span>
                </div>
              ) : chats.map(msg => (
                <div key={msg.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: 11, color: "#818cf8", fontWeight: 600 }}>{msg.from}</span>
                  <span style={{ fontSize: 13, color: "#d1d5db", lineHeight: 1.4, background: "rgba(255,255,255,0.04)", padding: "8px 12px", borderRadius: "0 10px 10px 10px" }}>{msg.text}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 8 }}>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendChat()}
                placeholder="Message..."
                style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", borderRadius: 10, padding: "10px 12px", fontSize: 13, outline: "none" }}
              />
              <button
                onClick={sendChat}
                disabled={!chatInput.trim()}
                style={{ background: chatInput.trim() ? "linear-gradient(135deg,#818cf8,#6366f1)" : "rgba(255,255,255,0.08)", border: "none", color: "white", borderRadius: 10, padding: "0 14px", cursor: chatInput.trim() ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" }}
              >
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status, progress, speed }: { status: Status; progress: number; speed: string }) {
  const cfg = {
    connecting: { dot: "#eab308", text: "Connecting", bg: "rgba(234,179,8,0.1)" },
    connected:  { dot: "#3b82f6", text: "Connected",  bg: "rgba(59,130,246,0.1)" },
    streaming:  { dot: "#818cf8", text: `${progress.toFixed(0)}% · ${speed}`, bg: "rgba(129,140,248,0.1)" },
    playing:    { dot: "#22c55e", text: "Watching",   bg: "rgba(34,197,94,0.1)" },
    error:      { dot: "#ef4444", text: "Error",      bg: "rgba(239,68,68,0.1)" },
    disconnected: { dot: "#6b7280", text: "Disconnected", bg: "rgba(107,114,128,0.1)" },
  }[status];

  return (
    <div style={{ background: cfg.bg, border: `1px solid ${cfg.dot}30`, borderRadius: 20, padding: "6px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: "#e5e7eb" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: cfg.dot, boxShadow: `0 0 8px ${cfg.dot}`, flexShrink: 0 }} />
      {cfg.text}
    </div>
  );
}

function Spinner({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}>
      <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
      <path fill="#6366f1" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
