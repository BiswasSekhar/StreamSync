import React, { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "../store/session";
import type { TorrentProgressInfo } from "../store/session";
import type { SignallingMode } from "@streamsync/shared";
import { Settings } from "./Settings";

type HomeMode = "landing" | "host" | "join";

export function Home() {
  const {
    setFile, probeResult, filePath,
    isTorrentSource, torrentFileName, torrentProgress,
    createRoom, roomUrl, sessionId, joinRoom,
    signallingMode, setSignallingMode,
    shareCode,
    showToast, enterSession,
    showSettings, toggleSettings,
    displayName, setDisplayName,
  } = useSessionStore();
  const [joinDisplayName, setJoinDisplayName] = useState(() => sessionStorage.getItem("streamsync_name") ?? "");
  const [mode, setMode] = useState<HomeMode>("landing");
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [roomTimeout, setRoomTimeout] = useState(false);
  const [joinUrl, setJoinUrl] = useState("");
  // 20-second timeout while waiting for room setup
  useEffect(() => {
    if (!creatingRoom) { setRoomTimeout(false); return; }
    const t = setTimeout(() => setRoomTimeout(true), 20_000);
    return () => clearTimeout(t);
  }, [creatingRoom]);

  useEffect(() => {
    // Hardware detection not needed in direct seeding mode
  }, []);

  // Tauri native drag-drop listener (HTML5 ondrop does NOT give file paths in Tauri)
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
      const paths = event.payload?.paths;
      if (paths && paths.length > 0) {
        const first = paths[0];
        const ext = first.split(".").pop()?.toLowerCase() ?? "";
        const videoExts = ["mp4", "mkv", "avi", "mov", "ts", "wmv", "flv", "m4v", "webm"];
        if (ext === "torrent" || videoExts.includes(ext)) {
          if (mode !== "host") setMode("host");
          handleFile(first);
        } else {
          showToast("Unsupported file type. Drop a video or .torrent file.", "warning");
        }
      }
      setDragging(false);
    }).then((fn) => { unlisten = fn; });

    listen("tauri://drag-over", () => setDragging(true))
      .then((fn) => {
        const prev = unlisten;
        unlisten = () => { prev?.(); fn(); };
      });

    listen("tauri://drag-leave", () => setDragging(false))
      .then((fn) => {
        const prev = unlisten;
        unlisten = () => { prev?.(); fn(); };
      });

    return () => { unlisten?.(); };
  }, [mode]);

  const handleFile = async (path: string) => {
    setLoading(true);
    try {
      await setFile(path);
    } catch {
      // Error shown via toast in store
    } finally {
      setLoading(false);
    }
  };

  const handleBrowse = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Video or Torrent",
            extensions: ["mp4", "mkv", "avi", "mov", "ts", "wmv", "flv", "m4v", "webm", "torrent"],
          },
        ],
      });
      if (selected && typeof selected === "string") {
        await handleFile(selected);
      }
    } catch {
      // User cancelled or dialog not available
    }
  };

  const handleCreateRoom = async () => {
    if (!probeResult && !isTorrentSource) {
      showToast("Please select a video or .torrent file first", "warning");
      return;
    }
    setCreatingRoom(true);
    try {
      await createRoom(signallingMode);
    } catch {
      // Error shown in toast
    } finally {
      setCreatingRoom(false);
    }
  };

  const handleJoin = () => {
    const raw = joinUrl.trim();
    if (!raw) {
      showToast("Please paste a room URL or share code", "warning");
      return;
    }

    if (/^https?:\/\//i.test(raw)) {
      joinRoom(raw);
    } else {
      const normalized = raw
        .replace(/^tracker:\/\//i, "")
        .replace(/[^a-fA-F0-9]/g, "")
        .toLowerCase();

      if (normalized.length !== 40) {
        showToast("Enter a valid room URL or 40-character share code", "warning");
        return;
      }
      joinRoom(`tracker://${normalized}`);
    }

    // Persist display name for receiver
    const name = joinDisplayName.trim() || `Viewer${Math.floor(Math.random() * 9000) + 1000}`;
    sessionStorage.setItem("streamsync_name", name);
  };

  const signalModeButton = (mode: SignallingMode, title: string, subtitle: string) => {
    const active = signallingMode === mode;
    return (
      <button
        type="button"
        onClick={() => setSignallingMode(mode)}
        style={{
          flex: 1,
          borderRadius: 10,
          border: active ? "1px solid rgba(129,140,248,0.7)" : "1px solid rgba(255,255,255,0.12)",
          background: active ? "rgba(129,140,248,0.16)" : "rgba(0,0,0,0.32)",
          color: active ? "#c7d2fe" : "#cbd5e1",
          textAlign: "left",
          padding: "10px 12px",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 0,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 11, color: active ? "#a5b4fc" : "#94a3b8" }}>{subtitle}</span>
      </button>
    );
  };

  if (showSettings) {
    return <Settings />;
  }

  const fileName = filePath?.split(/[\\/]/).pop() ?? "";

  return (
    <div className="home-root">
      {/* Header */}
      <header className="home-header">
        <div className="home-header-left">
          <div className="logo-icon">
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24">
              <defs>
                <linearGradient id="logoGrad" x1="0" y1="0" x2="24" y2="24">
                  <stop stopColor="#818cf8" />
                  <stop offset="1" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              <path d="M8 5v14l11-7z" fill="url(#logoGrad)" />
            </svg>
          </div>
          <span className="logo-text">StreamSync</span>
          <span className="logo-badge">P2P</span>
        </div>
        <div className="home-header-right">
          {mode !== "landing" && (
            <button
              onClick={() => {
                setMode("landing");
                useSessionStore.setState({
                  filePath: null, probeResult: null,
                  isTorrentSource: false, torrentFileName: null, torrentProgress: null,
                  encodeProgress: null, encodeComplete: false,
                  roomUrl: null, sessionId: null,
                  shareCode: null,
                });
              }}
              className="btn-ghost"
            >
              ← Back
            </button>
          )}
          <button onClick={toggleSettings} className="btn-ghost" title="Settings">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a6.759 6.759 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      <main className="home-main">
        <div className="home-content">

          {/* ===== LANDING: Host vs Join ===== */}
          {mode === "landing" && (
            <>
              <div className="landing-heading">
                <h1 className="landing-title">Watch Together</h1>
                <p className="landing-subtitle">
                  Serverless, peer-to-peer watch parties. No accounts, no data stored.
                </p>
              </div>

              <div className="mode-cards">
                {/* Host card */}
                <button className="mode-card" onClick={() => setMode("host")}>
                  <div className="mode-icon host-icon">
                    <svg width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                    </svg>
                  </div>
                  <h2 className="mode-card-title">Host a Party</h2>
                  <p className="mode-card-desc">
                    Select a video from your machine. Your PC acts as the server — generates a shareable link for viewers.
                  </p>
                  <span className="mode-card-action">Select Video →</span>
                </button>

                {/* Join card */}
                <button className="mode-card" onClick={() => setMode("join")}>
                  <div className="mode-icon join-icon">
                    <svg width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                    </svg>
                  </div>
                  <h2 className="mode-card-title">Join a Party</h2>
                  <p className="mode-card-desc">
                    Paste the room URL or code shared by the host. Watch synchronized video right inside this app.
                  </p>
                  <span className="mode-card-action">Join In-App →</span>
                </button>
              </div>

              <p className="landing-footer">
                Your file never leaves your machine. Signalling is coordinated via your private cloudflared tunnel.
                <br />
                <span className="landing-footer-sub">
                  Powered by WebRTC, WebTorrent, and Cloudflare Tunnel.
                </span>
              </p>
            </>
          )}

          {/* ===== JOIN MODE ===== */}
          {mode === "join" && (
            <>
              <div className="landing-heading">
                <h1 className="landing-title" style={{ fontSize: 22 }}>Join a Watch Party</h1>
                <p className="landing-subtitle">
                  Paste the host room URL or tracker share code.
                </p>
              </div>

              <div className="join-input-group" style={{ flexDirection: "column", alignItems: "center", gap: 18, marginTop: 10 }}>
                {/* Name input for receiver */}
                <input
                  type="text"
                  placeholder="Your display name (optional)"
                  value={joinDisplayName}
                  onChange={e => { setJoinDisplayName(e.target.value); sessionStorage.setItem("streamsync_name", e.target.value.trim()); }}
                  maxLength={30}
                  style={{ width: 280, padding: "10px 14px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, color: "#f1f5f9", fontSize: 14, outline: "none" }}
                />
                <input
                  type="text"
                  placeholder="https://...trycloudflare.com/?room=ABCDEFGH or a1b2-c3d4-..."
                  value={joinUrl}
                  onChange={e => setJoinUrl(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleJoin()}
                  style={{ width: 420, maxWidth: "90vw", padding: "12px 14px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, color: "#f1f5f9", fontSize: 13, outline: "none" }}
                />
                <button onClick={handleJoin} className="btn-primary-large" style={{ width: 280 }}>
                  <span className="btn-content">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    Join Watch Party
                  </span>
                </button>
              </div>

              <div className="join-info">
                <div className="join-info-item">
                  <svg width="16" height="16" fill="none" stroke="var(--accent-light)" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <span>No account or install needed</span>
                </div>
                <div className="join-info-item">
                  <svg width="16" height="16" fill="none" stroke="var(--accent-light)" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <span>End-to-end encrypted via HTTPS</span>
                </div>
                <div className="join-info-item">
                  <svg width="16" height="16" fill="none" stroke="var(--accent-light)" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" />
                  </svg>
                  <span>Peer-to-peer — video streams directly from host</span>
                </div>
              </div>
            </>
          )}

          {/* ===== HOST MODE ===== */}
          {mode === "host" && (
            <>
              {/* Step indicator */}
              <div className="step-indicator">
                <StepDot active done={!!probeResult} num={1} label="Select Video" />
                <div className={`step-line ${probeResult ? "done" : ""}`} />
                <StepDot active={!!probeResult} done={!!sessionId} num={2} label="Create Room" />
                <div className={`step-line ${sessionId ? "done" : ""}`} />
                <StepDot active={!!sessionId} done={false} num={3} label="Watch Together" />
              </div>

              {/* Drop zone or file info */}
              {!probeResult && !isTorrentSource ? (
                <div
                  className={`drop-zone ${dragging ? "dragging" : ""} ${loading ? "loading" : ""}`}
                  onClick={handleBrowse}
                >
                  <div className="drop-zone-inner">
                    <div className="drop-icon-wrapper">
                      <svg width="40" height="40" fill="none" stroke="#6366f1" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                      </svg>
                    </div>
                    <div>
                      <p className="drop-title">
                        {loading ? "Analyzing file..." : "Drop your video or .torrent here"}
                      </p>
                      <p className="drop-subtitle">or click to browse files</p>
                    </div>
                    <div className="drop-formats">
                      {["MP4", "MKV", "AVI", "MOV", "TS", "WMV", "FLV", "TORRENT"].map((f) => (
                        <span key={f} className={`format-chip${f === "TORRENT" ? " torrent-chip" : ""}`}>{f}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : isTorrentSource ? (
                <TorrentInfoCard
                  torrentFileName={torrentFileName}
                  torrentProgress={torrentProgress}
                  onClear={() => useSessionStore.setState({
                    filePath: null, probeResult: null,
                    isTorrentSource: false, torrentFileName: null, torrentProgress: null,
                    encodeProgress: null, encodeComplete: false,
                    roomUrl: null, sessionId: null,
                    shareCode: null,
                  })}
                />
              ) : probeResult ? (
                <div className="file-info-card">
                  <div className="file-info-row">
                    <div className="file-info-icon">
                      <svg width="22" height="22" fill="none" stroke="#6366f1" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                      </svg>
                    </div>
                    <div className="file-info-meta">
                      <div className="file-info-name" title={fileName}>{fileName}</div>
                      <div className="file-info-details">
                        <span className="info-pill">{probeResult.width}×{probeResult.height}</span>
                        <span className="info-pill">{probeResult.codecName.toUpperCase()}</span>
                        <span className="info-pill">{probeResult.fps.toFixed(0)} fps</span>
                        <span className="info-pill">{(probeResult.durationSeconds / 60).toFixed(0)} min</span>
                        <span className="info-pill">{(probeResult.fileSizeBytes / 1e9).toFixed(2)} GB</span>
                        {probeResult.hasHdr && <span className="info-pill hdr">HDR</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => useSessionStore.setState({
                        filePath: null, probeResult: null,
                        encodeProgress: null, encodeComplete: false,
                        roomUrl: null, sessionId: null,
                          shareCode: null,
                      })}
                      className="btn-ghost"
                    >
                      Change
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Room code is shown only inside the Session view after host enters it */}
              {sessionId && (
                <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 10, padding: "10px 16px", fontSize: 13, color: "#4ade80", textAlign: "center" }}>
                  Room ready — click "Open Watch Party" to share {signallingMode === "tracker" ? "the code" : "the URL"}
                </div>
              )}

              {/* Host display name — set before creating room */}
              {(probeResult || isTorrentSource) && !sessionId && (
                <input
                  type="text"
                  placeholder="Your display name (Host)"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  maxLength={30}
                  style={{ width: "100%", padding: "10px 14px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, color: "#f1f5f9", fontSize: 14, outline: "none", boxSizing: "border-box" }}
                />
              )}

              {(probeResult || isTorrentSource) && !sessionId && (
                <div style={{ display: "flex", gap: 10, width: "100%" }}>
                  {signalModeButton(
                    "tracker",
                    "Tracker (Primary)",
                    "No tunnel on happy path; share code join",
                  )}
                  {signalModeButton(
                    "tunnel",
                    "Tunnel (Fallback)",
                    "Cloudflared URL for restricted networks",
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div className="home-actions">
                {(probeResult || isTorrentSource) && !sessionId && (
                  <button
                    onClick={handleCreateRoom}
                    disabled={creatingRoom}
                    className="btn-primary-large"
                  >
                    {creatingRoom ? (
                      <span className="btn-loading">
                        <svg className="spin-icon" fill="none" viewBox="0 0 24 24">
                          <circle className="spin-track" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="spin-fill" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        {signallingMode === "tracker" ? "Preparing tracker room..." : "Starting tunnel..."}
                      </span>
                    ) : (
                      <span className="btn-content">
                        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.1" />
                        </svg>
                        Create Watch Party
                      </span>
                    )}
                  </button>
                )}

                {/* Timeout nudge — shown after 20 s of waiting for room setup */}
                {creatingRoom && roomTimeout && (
                  <div className="timeout-nudge">
                    <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                    Taking too long? Close the app completely and reopen it, then try again.
                  </div>
                )}

                {sessionId && (
                  <button
                    onClick={enterSession}
                    className="btn-primary-large enter-session"
                  >
                    <span className="btn-content">
                      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Open Watch Party
                    </span>
                  </button>
                )}

                {!probeResult && !isTorrentSource && (
                  <p className="home-hint">
                    Select a video or drop a .torrent file to start a watch party.
                    <br />
                    <span className="home-hint-sub">
                      Your file never leaves your machine. Fully peer-to-peer.
                    </span>
                  </p>
                )}

                {(probeResult || isTorrentSource) && !sessionId && (
                  <p className="home-hint-small">
                      {signallingMode === "tracker"
                        ? "Tracker mode issues a share code first. Tunnel remains available as a fallback mode."
                        : isTorrentSource
                          ? "Torrent streams from the global swarm. Viewers join with the generated URL."
                          : "Creates a room URL through the tunnel fallback mode."}
                  </p>
                )}

                {shareCode && sessionId && signallingMode === "tracker" && (
                  <div style={{ background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.35)", borderRadius: 10, padding: "10px 16px", fontSize: 13, color: "#c7d2fe", textAlign: "center" }}>
                    Share code ready: <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{shareCode}</span>
                  </div>
                )}
              </div>
            </>
          )}

        </div>
      </main>
    </div>
  );
}

/* Torrent info card — shown when host uploads a .torrent file */
function TorrentInfoCard({
  torrentFileName,
  torrentProgress,
  onClear,
}: {
  torrentFileName: string | null;
  torrentProgress: TorrentProgressInfo | null;
  onClear: () => void;
}) {
  const displayName = torrentFileName ?? "Loading torrent…";
  const haveBytes = torrentProgress?.haveBytes ?? 0;
  const totalBytes = torrentProgress?.totalBytes ?? 0;
  const dlSpeed = torrentProgress?.downloadSpeedBps ?? 0;
  const peers = torrentProgress?.peerCount ?? 0;
  const percent = totalBytes > 0 ? Math.min(100, Math.round((haveBytes / totalBytes) * 100)) : 0;

  const fmtSpeed = (bps: number) => {
    if (bps > 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
    if (bps > 1_000) return `${(bps / 1_000).toFixed(0)} KB/s`;
    return `${bps} B/s`;
  };

  const fmtBytes = (b: number) => {
    if (b > 1e9) return `${(b / 1e9).toFixed(2)} GB`;
    if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`;
    return `${b} B`;
  };

  return (
    <div className="file-info-card torrent-info-card">
      <div className="file-info-row">
        {/* Torrent icon */}
        <div className="file-info-icon torrent-icon">
          <svg width="22" height="22" fill="none" stroke="#818cf8" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 16.5l1.5-1.5M15.5 16.5l-1.5-1.5" />
          </svg>
        </div>

        <div className="file-info-meta" style={{ flex: 1, minWidth: 0 }}>
          <div className="file-info-name" title={displayName}>{displayName}</div>
          <div className="file-info-details">
            <span className="info-pill torrent-badge">TORRENT</span>
            {torrentProgress ? (
              <>
                <span className="info-pill">{peers} peer{peers !== 1 ? "s" : ""}</span>
                <span className="info-pill">{fmtSpeed(dlSpeed)} ↓</span>
                {totalBytes > 0 && (
                  <span className="info-pill">{fmtBytes(haveBytes)} / {fmtBytes(totalBytes)}</span>
                )}
              </>
            ) : (
              <span className="info-pill swarm-connecting">Connecting to swarm…</span>
            )}
          </div>

          {/* Download progress bar */}
          {totalBytes > 0 && (
            <div className="torrent-progress-bar-wrap">
              <div className="torrent-progress-bar" style={{ width: `${percent}%` }} />
              <span className="torrent-progress-label">{percent}%</span>
            </div>
          )}
        </div>

        <button onClick={onClear} className="btn-ghost">Change</button>
      </div>
    </div>
  );
}

/* Step dot component */
function StepDot({ active, done, num, label }: { active: boolean; done: boolean; num: number; label: string }) {
  return (
    <div className={`step-dot-group ${active ? "active" : ""} ${done ? "done" : ""}`}>
      <div className="step-dot">
        {done ? (
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <span>{num}</span>
        )}
      </div>
      <span className="step-label">{label}</span>
    </div>
  );
}
