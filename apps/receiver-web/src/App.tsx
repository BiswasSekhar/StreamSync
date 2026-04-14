import { useEffect, useRef, useState, useCallback } from "react";
import { ReceiverWebRTC, VideoReadyInfo, ChunkMeta } from "./lib/webrtc";
import { SyncMessage } from "./lib/sync";
import { EulaModal } from "./EulaModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type AppStatus =
  | "name-entry"
  | "join"
  | "connecting"
  | "approved"
  | "streaming"
  | "playing"
  | "host-ended"
  | "denied"
  | "disconnected"
  | "error";

interface ChatMsg {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

// ── MSE constants ─────────────────────────────────────────────────────────────
const CHUNK_SIZE = 128 * 1024; // 128 KB per range request
const MAX_IN_FLIGHT = 4;        // max simultaneous chunk requests
const WEBTORRENT_TIMEOUT_MS = 30_000; // fall back to DataChannel after 30s

// ── Helpers ───────────────────────────────────────────────────────────────────

function storedName(): string {
  return sessionStorage.getItem("streamsync_name") ?? "";
}

function saveName(name: string) {
  sessionStorage.setItem("streamsync_name", name.trim());
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  // URL params
  const params = new URLSearchParams(window.location.search);
  const urlRoomCode = params.get("room")?.trim().toUpperCase() ?? null;

  // Name + room state
  const [name, setName] = useState(() => storedName());
  const [roomCode, setRoomCode] = useState(urlRoomCode ?? "");
  const [status, setStatus] = useState<AppStatus>(() => {
    const hasName = Boolean(storedName());
    if (urlRoomCode) return hasName ? "connecting" : "name-entry";
    return hasName ? "join" : "name-entry";
  });
  const [denyReason, setDenyReason] = useState("");

  // Chat
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const webrtcRef = useRef<ReceiverWebRTC | null>(null);
  const pendingSyncRef = useRef<SyncMessage | null>(null);
  const torrentClientRef = useRef<any>(null);
  const torrentFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // MSE DataChannel pump state
  const msRef = useRef<MediaSource | null>(null);
  const sbRef = useRef<SourceBuffer | null>(null);
  const chunkQueueRef = useRef<ArrayBuffer[]>([]);
  const isAppendingRef = useRef(false);
  const nextByteRef = useRef(0);
  const fileSizeRef = useRef(0);
  const inFlightRef = useRef(0);
  const videoInfoRef = useRef<VideoReadyInfo | null>(null);

  // ── MSE pump ───────────────────────────────────────────────────────────────

  const appendNext = useCallback(() => {
    const sb = sbRef.current;
    if (!sb || sb.updating || isAppendingRef.current) return;
    const chunk = chunkQueueRef.current.shift();
    if (!chunk) return;
    isAppendingRef.current = true;
    try {
      sb.appendBuffer(chunk);
    } catch (e) {
      isAppendingRef.current = false;
      console.warn("[App] appendBuffer error:", e);
    }
  }, []);

  const pumpChunks = useCallback(() => {
    if (!webrtcRef.current || !videoInfoRef.current) return;
    const fileSize = fileSizeRef.current;
    while (inFlightRef.current < MAX_IN_FLIGHT && nextByteRef.current < fileSize) {
      const start = nextByteRef.current;
      const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
      const reqId = `${start}`;
      webrtcRef.current.requestChunk(start, end, reqId);
      nextByteRef.current = end + 1;
      inFlightRef.current++;
    }
  }, []);

  const handleMediaChunk = useCallback((data: ArrayBuffer, _meta: ChunkMeta) => {
    inFlightRef.current = Math.max(0, inFlightRef.current - 1);
    chunkQueueRef.current.push(data);
    if (!isAppendingRef.current) appendNext();
    pumpChunks();
  }, [appendNext, pumpChunks]);

  // ── MSE initialisation (WebRTC DataChannel path) ───────────────────────────

  const startMSE = useCallback((info: VideoReadyInfo) => {
    const video = videoRef.current;
    if (!video) return;

    // Reset pump state
    videoInfoRef.current = info;
    fileSizeRef.current = info.fileSize;
    nextByteRef.current = 0;
    inFlightRef.current = 0;
    chunkQueueRef.current = [];
    isAppendingRef.current = false;

    const ms = new MediaSource();
    msRef.current = ms;
    video.src = URL.createObjectURL(ms);

    ms.addEventListener("sourceopen", () => {
      let sb: SourceBuffer;
      try {
        sb = ms.addSourceBuffer(info.mimeCodec);
      } catch (err) {
        console.error("[App] addSourceBuffer failed:", err);
        setStatus("error");
        return;
      }
      sbRef.current = sb;

      sb.addEventListener("updateend", () => {
        isAppendingRef.current = false;
        appendNext();
        pumpChunks();
        // Signal end-of-stream once all bytes are buffered
        if (
          nextByteRef.current >= fileSizeRef.current &&
          chunkQueueRef.current.length === 0 &&
          ms.readyState === "open"
        ) {
          try { ms.endOfStream(); } catch {}
        }
      });

      sb.addEventListener("error", (e) => console.warn("[App] SourceBuffer error", e));

      if (info.durationSeconds > 0) {
        try { ms.duration = info.durationSeconds; } catch {}
      }

      pumpChunks();
      setStatus("streaming");
    });
  }, [appendNext, pumpChunks]);

  // ── WebTorrent path (public swarm) ─────────────────────────────────────────

  const startWebTorrent = useCallback((magnetLink: string, info: VideoReadyInfo) => {
    const WT = (window as any).WebTorrent;
    if (!WT) {
      // CDN not loaded — fall straight to DataChannel
      startMSE(info);
      return;
    }

    const client = new WT();
    torrentClientRef.current = client;

    // If no peers are found within timeout, fall back to DataChannel
    const fallbackTimer = setTimeout(() => {
      console.log("[App] WebTorrent: no peers within timeout, falling back to DataChannel");
      client.destroy().catch(() => {});
      torrentClientRef.current = null;
      startMSE(info);
    }, WEBTORRENT_TIMEOUT_MS);
    torrentFallbackTimer.current = fallbackTimer;

    client.add(magnetLink, (torrent: any) => {
      clearTimeout(fallbackTimer);
      torrentFallbackTimer.current = null;

      const VIDEO_EXTS = ["mp4", "mkv", "avi", "mov", "webm", "ts", "m4v", "wmv"];
      const file = torrent.files.find((f: any) =>
        VIDEO_EXTS.some(ext => f.name.toLowerCase().endsWith(`.${ext}`))
      );

      if (!file) {
        console.warn("[App] WebTorrent: no video file in torrent, falling back");
        client.destroy().catch(() => {});
        torrentClientRef.current = null;
        startMSE(info);
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      // WebTorrent handles its own MSE internally via renderTo
      file.renderTo(video, (err: any) => {
        if (err) {
          console.warn("[App] WebTorrent renderTo error:", err, " — falling back to DataChannel");
          client.destroy().catch(() => {});
          torrentClientRef.current = null;
          startMSE(info);
        } else {
          setStatus("playing");
        }
      });
      setStatus("streaming");
    });

    client.on("error", (err: any) => {
      console.warn("[App] WebTorrent error:", err);
    });
  }, [startMSE]);

  // ── Video ready callback ───────────────────────────────────────────────────

  const handleVideoReady = useCallback((info: VideoReadyInfo) => {
    if (info.magnetLink && (window as any).WebTorrent) {
      // Public swarm available — try WebTorrent first; DataChannel is fallback
      startWebTorrent(info.magnetLink, info);
    } else {
      // Direct DataChannel streaming
      startMSE(info);
    }
  }, [startMSE, startWebTorrent]);

  // ── Sync ───────────────────────────────────────────────────────────────────

  const handleSync = useCallback((sync: SyncMessage) => {
    const video = videoRef.current;
    if (video && webrtcRef.current) {
      webrtcRef.current.applySync(sync, video);
    } else {
      pendingSyncRef.current = sync;
    }
  }, []);

  // ── Chat ───────────────────────────────────────────────────────────────────

  const handleChat = useCallback((msg: ChatMsg) => {
    setChatMsgs(prev => [...prev, msg]);
  }, []);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMsgs]);

  const sendChat = useCallback(() => {
    const text = chatInput.trim();
    if (!text || !webrtcRef.current) return;
    webrtcRef.current.sendChat(text);
    setChatInput("");
  }, [chatInput]);

  // ── Connection lifecycle ───────────────────────────────────────────────────

  const handlePeerJoined = useCallback(() => {
    setStatus(s => (s === "connecting" || s === "approved") ? "approved" : s);
  }, []);

  const handleHostEnded = useCallback(() => {
    setStatus("host-ended");
    // Tear down media
    if (torrentFallbackTimer.current) { clearTimeout(torrentFallbackTimer.current); torrentFallbackTimer.current = null; }
    torrentClientRef.current?.destroy().catch(() => {});
    torrentClientRef.current = null;
    webrtcRef.current?.close();
    webrtcRef.current = null;
  }, []);

  const handleJoinDenied = useCallback((reason: string) => {
    setDenyReason(reason);
    setStatus("denied");
  }, []);

  const doConnect = useCallback((code: string) => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;

    // Tear down any previous connection
    if (torrentFallbackTimer.current) { clearTimeout(torrentFallbackTimer.current); torrentFallbackTimer.current = null; }
    torrentClientRef.current?.destroy().catch(() => {});
    torrentClientRef.current = null;
    webrtcRef.current?.close();
    webrtcRef.current = null;

    // Reset MSE state
    nextByteRef.current = 0;
    inFlightRef.current = 0;
    chunkQueueRef.current = [];
    isAppendingRef.current = false;
    videoInfoRef.current = null;
    sbRef.current = null;
    msRef.current = null;

    const rtc = new ReceiverWebRTC(
      handleVideoReady,
      handleSync,
      handleChat,
      handlePeerJoined,
      () => setStatus("disconnected"),
      handleJoinDenied,
      handleHostEnded,
      handleMediaChunk,
    );
    webrtcRef.current = rtc;
    rtc.connect(trimmed);
    setStatus("connecting");
  }, [handleVideoReady, handleSync, handleChat, handlePeerJoined, handleJoinDenied, handleHostEnded, handleMediaChunk]);

  // Auto-connect when room code in URL and name already set
  useEffect(() => {
    if (urlRoomCode && storedName()) {
      doConnect(urlRoomCode);
    }
    return () => {
      webrtcRef.current?.close();
      if (torrentFallbackTimer.current) clearTimeout(torrentFallbackTimer.current);
      torrentClientRef.current?.destroy().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // Transition to "playing" once video can play
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onCanPlay = () => {
      setStatus(s => (s === "streaming" || s === "approved") ? "playing" : s);
      if (pendingSyncRef.current && webrtcRef.current) {
        webrtcRef.current.applySync(pendingSyncRef.current, video);
        pendingSyncRef.current = null;
      }
    };
    video.addEventListener("canplay", onCanPlay);
    return () => video.removeEventListener("canplay", onCanPlay);
  }, []);

  // ── Name submit ───────────────────────────────────────────────────────────

  const submitName = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    saveName(trimmed);
    if (urlRoomCode) {
      doConnect(urlRoomCode);
    } else {
      setStatus("join");
    }
  }, [name, urlRoomCode, doConnect]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (status === "name-entry") {
    return (
      <div style={s.center}>
        <EulaModal />
        <div style={s.card}>
          <Logo />
          <h2 style={s.title}>Welcome to StreamSync</h2>
          <p style={s.subtitle}>Enter your display name to join the watch party</p>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submitName()}
            placeholder="Your name (e.g. Alice)"
            autoFocus
            style={s.input}
          />
          <button onClick={submitName} disabled={!name.trim()} style={s.btnPrimary}>
            Continue →
          </button>
        </div>
      </div>
    );
  }

  if (status === "join") {
    return (
      <div style={s.center}>
        <EulaModal />
        <div style={s.card}>
          <Logo />
          <h2 style={s.title}>Join Watch Party</h2>
          <p style={s.subtitle}>Enter the room code shared by the host</p>
          <input
            value={roomCode}
            onChange={e => setRoomCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && doConnect(roomCode)}
            placeholder="e.g. ABCD1234"
            autoFocus
            style={s.input}
          />
          <button onClick={() => doConnect(roomCode)} disabled={!roomCode.trim()} style={s.btnPrimary}>
            Join
          </button>
          <button onClick={() => setStatus("name-entry")} style={s.btnGhost}>
            ← Change name
          </button>
        </div>
      </div>
    );
  }

  if (status === "denied") {
    return (
      <div style={s.center}>
        <div style={s.card}>
          <Logo />
          <h2 style={{ ...s.title, color: "#f87171" }}>Access Denied</h2>
          <p style={s.subtitle}>{denyReason || "The host declined your request."}</p>
          <button onClick={() => setStatus("join")} style={s.btnPrimary}>Try Again</button>
        </div>
      </div>
    );
  }

  if (status === "host-ended") {
    return (
      <div style={s.center}>
        <div style={s.card}>
          <Logo />
          <h2 style={s.title}>Session Ended</h2>
          <p style={s.subtitle}>The host ended the watch party.</p>
          <button
            onClick={() => { setStatus("join"); setRoomCode(""); }}
            style={s.btnPrimary}
          >
            ← Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (status === "disconnected") {
    return (
      <div style={s.center}>
        <div style={s.card}>
          <Logo />
          <h2 style={{ ...s.title, color: "#f59e0b" }}>Disconnected</h2>
          <p style={s.subtitle}>Lost connection to the host. Try rejoining.</p>
          <button onClick={() => doConnect(roomCode)} style={s.btnPrimary}>Reconnect</button>
          <button onClick={() => setStatus("join")} style={s.btnGhost}>← Change room</button>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={s.center}>
        <div style={s.card}>
          <Logo />
          <h2 style={{ ...s.title, color: "#f87171" }}>Playback Error</h2>
          <p style={s.subtitle}>Failed to start video. The host may need to re-open the session.</p>
          <button onClick={() => doConnect(roomCode)} style={s.btnPrimary}>Retry</button>
        </div>
      </div>
    );
  }

  // ── Video / active session view ────────────────────────────────────────────

  const isLive = status === "playing";

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", fontFamily: "Inter, system-ui, sans-serif" }}>
      <EulaModal />

      {/* Video element — always mounted so MSE/WebTorrent can attach */}
      <video
        ref={videoRef}
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
        autoPlay
        playsInline
        controls={isLive}
      />

      {/* Connecting / buffering overlay */}
      {!isLive && (
        <div style={{
          position: "absolute", inset: 0,
          background: "rgba(0,0,0,0.75)",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 18,
        }}>
          <Logo />
          <Spinner />
          <p style={{ color: "#cbd5e1", fontSize: 14, margin: 0 }}>
            {status === "connecting" ? "Waiting for host approval…" :
             status === "approved"   ? "Setting up connection…" :
             status === "streaming"  ? "Buffering video…" : "Loading…"}
          </p>
        </div>
      )}

      {/* Top bar when playing */}
      {isLive && (
        <div style={{
          position: "absolute", top: 0, left: 0,
          right: chatOpen ? 300 : 0,
          background: "linear-gradient(to bottom, rgba(0,0,0,0.72), transparent)",
          padding: "12px 16px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          pointerEvents: "none", transition: "right 0.25s ease",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 8px #22c55e", display: "inline-block" }} />
            <span style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 500 }}>StreamSync Live</span>
          </div>
          <div style={{ pointerEvents: "auto", display: "flex", gap: 8 }}>
            <button
              onClick={() => setChatOpen(o => !o)}
              style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)", color: "white", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}
            >
              💬 Chat{chatMsgs.length > 0 ? ` (${chatMsgs.length})` : ""}
            </button>
          </div>
        </div>
      )}

      {/* Chat panel */}
      {chatOpen && (
        <div style={{
          position: "absolute", top: 0, right: 0, bottom: 0, width: 300,
          background: "rgba(8,8,12,0.97)", backdropFilter: "blur(20px)",
          borderLeft: "1px solid rgba(255,255,255,0.07)",
          display: "flex", flexDirection: "column", zIndex: 50,
        }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>Chat</span>
            <button onClick={() => setChatOpen(false)} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 18, padding: 4, lineHeight: 1 }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {chatMsgs.length === 0 && (
              <p style={{ color: "#555", fontSize: 13, textAlign: "center", marginTop: 24 }}>No messages yet</p>
            )}
            {chatMsgs.map(msg => (
              <div key={msg.id}>
                <div style={{ display: "flex", gap: 6, marginBottom: 3, alignItems: "baseline" }}>
                  <span style={{ fontSize: 12, color: "#818cf8", fontWeight: 600 }}>{msg.from}</span>
                  <span style={{ fontSize: 10, color: "#555" }}>{new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.45, background: "rgba(255,255,255,0.05)", padding: "7px 10px", borderRadius: "0 10px 10px 10px" }}>
                  {msg.text}
                </p>
              </div>
            ))}
            <div ref={chatBottomRef} />
          </div>
          <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendChat()}
                placeholder="Message…"
                style={{ flex: 1, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)", color: "#f1f5f9", borderRadius: 8, padding: "9px 12px", fontSize: 13, outline: "none" }}
              />
              <button
                onClick={sendChat}
                style={{ background: "linear-gradient(135deg,#818cf8,#6366f1)", border: "none", color: "white", borderRadius: 8, padding: "0 14px", cursor: "pointer", display: "flex", alignItems: "center" }}
              >
                <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
      <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#818cf8,#6366f1)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <svg width="16" height="16" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
      </div>
      <span style={{ fontWeight: 700, fontSize: 20, color: "#f1f5f9", letterSpacing: "-0.02em" }}>StreamSync</span>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes ss-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ width: 38, height: 38, border: "3px solid rgba(255,255,255,0.1)", borderTopColor: "#6366f1", borderRadius: "50%", animation: "ss-spin 0.9s linear infinite" }} />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  center: {
    background: "#080810", minHeight: "100vh",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 20, fontFamily: "Inter, system-ui, sans-serif",
  },
  card: {
    width: "100%", maxWidth: 440,
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 20, padding: 36,
    display: "flex", flexDirection: "column", gap: 14,
    boxShadow: "0 24px 48px rgba(0,0,0,0.6)",
  },
  title: { fontSize: 22, fontWeight: 700, color: "#f1f5f9", margin: 0, letterSpacing: "-0.02em" },
  subtitle: { color: "#94a3b8", fontSize: 14, margin: 0, lineHeight: 1.55 },
  input: {
    background: "rgba(0,0,0,0.4)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#f0f0f0", borderRadius: 12,
    padding: "13px 16px", fontSize: 15, outline: "none",
    width: "100%", boxSizing: "border-box",
  },
  btnPrimary: {
    background: "linear-gradient(135deg,#818cf8,#6366f1)",
    border: "none", color: "white", borderRadius: 12,
    padding: "13px 0", fontSize: 15, fontWeight: 600,
    cursor: "pointer", width: "100%",
  },
  btnGhost: {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.09)",
    color: "#94a3b8", borderRadius: 12,
    padding: "11px 0", fontSize: 13,
    cursor: "pointer", width: "100%",
  },
};
