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

let wtClient: any = null;

export function JoinSession() {
  const { leaveSession, showToast } = useSessionStore();
  const [status, setStatus] = useState<Status>("connecting");
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [chats, setChats] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [fileName, setFileName] = useState("Connecting...");
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const rtcRef = useRef<JoinWebRTC | null>(null);
  const pendingSyncRef = useRef<SyncMessage | null>(null);

  const roomUrl = useSessionStore((s) => s.joinRoomUrl);

  // Auto-scroll chat
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chats]);

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
    setFileName(name || "Video");
    const video = videoRef.current;
    if (!video) return;

    try {
      if (wtClient) { wtClient.destroy(); wtClient = null; }

      if (typeof WebTorrent === "undefined") {
        throw new Error("WebTorrent not loaded — check internet connection");
      }

      wtClient = new WebTorrent();
      wtClient.add(magnet, {}, (torrent: any) => {
        // Pick the largest file (the video)
        const file = torrent.files.reduce((a: any, b: any) =>
          a.length > b.length ? a : b
        );

        file.renderTo(video, { autoplay: false }, (err: Error | null) => {
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

        // Prioritize pieces near seek position
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
      setError(`Failed: ${e.message || e}`);
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
      () => {
        setStatus("connected");
        showToast("Connected to host!", "success");
      },
      () => {
        setStatus("disconnected");
        showToast("Disconnected from host", "warning");
      }
    );
    rtcRef.current = rtc;

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
      if (wtClient) { wtClient.destroy(); wtClient = null; }
    };
  }, [handleMagnet, handleSync, handleChat, roomUrl, showToast]);

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

  const handleLeave = () => {
    rtcRef.current?.close();
    if (wtClient) { wtClient.destroy(); wtClient = null; }
    localStream?.getTracks().forEach(t => t.stop());
    leaveSession();
  };

  const formatSpeed = (bps: number) => {
    if (bps > 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
    if (bps > 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
    return `${bps.toFixed(0)} B/s`;
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="session-root">
      {/* Header — identical structure to Session.tsx */}
      <header className="session-header">
        <div className="session-header-left">
          <div className="logo-icon-sm">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
              <defs>
                <linearGradient id="logoGradJoin" x1="0" y1="0" x2="24" y2="24">
                  <stop stopColor="#818cf8" />
                  <stop offset="1" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              <path d="M8 5v14l11-7z" fill="url(#logoGradJoin)" />
            </svg>
          </div>
          <span className="session-title">StreamSync</span>
          <span className="viewer-count">
            <span className="viewer-dot" />
            {fileName}
          </span>
        </div>
        <div className="session-header-right">
          {/* Status badge */}
          <StatusBadge status={status} progress={progress} speed={formatSpeed(speed)} />
          <button onClick={handleLeave} className="btn-ghost">
            ← Leave
          </button>
        </div>
      </header>

      {/* Body — same layout as Session.tsx */}
      <div className="session-body">
        {/* Left: Video area */}
        <div className="session-video-area">
          <div className="video-container" style={{ position: "relative" }}>
            {/* Loading state */}
            {(status === "connecting" || status === "connected") && (
              <div className="flex flex-col items-center justify-center gap-4 w-full h-full">
                <svg width="36" height="36" fill="none" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite" }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
                  <path fill="#6366f1" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <div style={{ textAlign: "center" }}>
                  <p style={{ color: "var(--text-primary)", fontSize: 15, fontWeight: 600 }}>
                    {status === "connecting" ? "Connecting to room..." : "Waiting for host to share video..."}
                  </p>
                  <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 6 }}>
                    P2P connection establishing
                  </p>
                </div>
              </div>
            )}

            {/* Error state */}
            {error && (
              <div className="flex flex-col items-center justify-center gap-3 w-full h-full">
                <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 14, padding: "20px 28px", maxWidth: 380, textAlign: "center" }}>
                  <div style={{ fontSize: 28, marginBottom: 10 }}>⚠️</div>
                  <p style={{ color: "#f87171", fontSize: 14 }}>{error}</p>
                  <button onClick={handleLeave} className="btn-ghost" style={{ marginTop: 14 }}>Go Back</button>
                </div>
              </div>
            )}

            {/* Streaming overlay badge */}
            {status === "streaming" && (
              <div style={{ position: "absolute", bottom: 16, left: 16, zIndex: 10, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#e5e7eb" }}>
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
                  <path fill="#6366f1" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Buffering {progress.toFixed(0)}% · {formatSpeed(speed)}
              </div>
            )}

            {/* The video player */}
            <video
              ref={videoRef}
              controls
              className="w-full h-full object-contain bg-black"
              style={{ maxHeight: "calc(100vh - 180px)", borderRadius: "12px", overflow: "hidden", boxShadow: "0 20px 40px rgba(0,0,0,0.4)", display: (status === "streaming" || status === "playing") ? "block" : "none" }}
            />
          </div>

          {/* Facecam row — your own camera */}
          <div className="facecam-row">
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 12px", height: "100%" }}>
              <div style={{ position: "relative", flexShrink: 0, height: 88, width: 120, background: "#1a1a1a", borderRadius: 10, overflow: "hidden", border: "1px solid #2a2a2a" }}>
                {localStream ? (
                  <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(99,102,241,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <svg width="16" height="16" fill="none" stroke="#6366f1" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    </div>
                  </div>
                )}
                <div style={{ position: "absolute", bottom: 4, left: 4 }}>
                  <span style={{ fontSize: 10, background: "rgba(0,0,0,0.7)", color: "white", padding: "1px 5px", borderRadius: 4 }}>You</span>
                </div>
              </div>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Watching together</span>
            </div>
          </div>
        </div>

        {/* Right: Sidebar — same structure as Session.tsx */}
        <div className="session-sidebar">
          {/* Peer info section (replaces PeerList) */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid #2a2a2a", flexShrink: 0 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, marginBottom: 8 }}>Room Info</div>
            <div style={{ background: "#1a1a1a", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "var(--text-muted)" }}>
              Connected to host room
            </div>
          </div>

          {/* Chat — uses exact same styling pattern as ChatPanel.tsx */}
          <div className="sidebar-chat" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div className="flex flex-col h-full">
              <div className="px-3 py-2 border-b border-[#2a2a2a] flex-shrink-0">
                <span className="text-xs font-medium text-[#9ca3af] uppercase tracking-wide">Chat</span>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {chats.length === 0 && (
                  <p className="text-xs text-[#666] text-center py-4">No messages yet. Say hello!</p>
                )}
                {chats.map((msg) => (
                  <div key={msg.id} className="space-y-0.5">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-indigo-400">{msg.from}</span>
                      <span className="text-xs text-[#555]">{formatTime(msg.timestamp)}</span>
                    </div>
                    <p className="text-sm text-[#e0e0e0] break-words">{msg.text}</p>
                  </div>
                ))}
                <div ref={chatBottomRef} />
              </div>

              <div className="p-3 border-t border-[#2a2a2a] flex-shrink-0">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendChat()}
                    placeholder="Message..."
                    className="flex-1 text-sm"
                  />
                  <button onClick={sendChat} className="btn-primary px-3 py-1.5">
                    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, progress, speed }: { status: Status; progress: number; speed: string }) {
  const cfg = {
    connecting:   { color: "#eab308", text: "Connecting" },
    connected:    { color: "#3b82f6", text: "Connected" },
    streaming:    { color: "#818cf8", text: `${progress.toFixed(0)}% · ${speed}` },
    playing:      { color: "#22c55e", text: "Watching" },
    error:        { color: "#ef4444", text: "Error" },
    disconnected: { color: "#6b7280", text: "Disconnected" },
  }[status];

  return (
    <span style={{
      background: `${cfg.color}18`,
      border: `1px solid ${cfg.color}40`,
      color: cfg.color,
      borderRadius: 20,
      padding: "4px 12px",
      fontSize: 12,
      fontWeight: 600,
      display: "flex",
      alignItems: "center",
      gap: 6,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: cfg.color, boxShadow: `0 0 6px ${cfg.color}` }} />
      {cfg.text}
    </span>
  );
}
