/**
 * MpvOverlay — playback controls for the embedded mpv player.
 *
 * The legacy `VideoOverlay` drives an `HTMLVideoElement`; this one drives an
 * `MpvClient` (property observers report state, commands change it). State
 * (position/duration/paused/speed) is owned by the parent (`Session`), which
 * receives it from `MpvHost`'s observer callbacks and passes it down here.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { MpvClient } from "../lib/mpvClient";

interface Props {
  client: MpvClient | null;
  position: number;
  duration: number;
  paused: boolean;
  /** True while mpv is stalled filling its cache (guest streaming). */
  buffering?: boolean;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function MpvOverlay({ client, position, duration, paused, buffering }: Props) {
  const [visible, setVisible] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!paused) hideTimer.current = setTimeout(() => setVisible(false), 3000);
  }, [paused]);

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    if (paused) setVisible(true);
  }, [paused]);

  const togglePlay = useCallback(() => {
    if (!client) return;
    if (paused) void client.play();
    else void client.pause();
  }, [client, paused]);

  const seekBy = useCallback(
    (delta: number) => {
      if (!client) return;
      const target = Math.max(0, Math.min(duration || Infinity, position + delta));
      void client.seek(target);
    },
    [client, position, duration],
  );

  const onBarClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!client || !duration) return;
      const r = e.currentTarget.getBoundingClientRect();
      void client.seek(((e.clientX - r.left) / r.width) * duration);
    },
    [client, duration],
  );

  const pickSpeed = useCallback(
    (s: number) => {
      setSpeed(s);
      setShowSpeed(false);
      void client?.setSpeed(s);
    },
    [client],
  );

  // Keyboard shortcuts (space / arrows), ignoring text inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekBy(-10);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekBy(10);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy]);

  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 15, cursor: visible ? "default" : "none" }}
      onMouseMove={reveal}
      onMouseLeave={() => { if (!paused) setVisible(false); }}
    >
      {/* Click-to-play area (above controls) */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 90 }} onClick={togglePlay} />

      {/* Buffering spinner */}
      {buffering && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: "#fff", fontSize: 13, background: "rgba(0,0,0,0.6)", padding: "10px 16px", borderRadius: 10, pointerEvents: "none" }}>
          Buffering…
        </div>
      )}

      {/* Controls panel */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "56px 18px 14px", background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 60%, transparent 100%)", opacity: visible ? 1 : 0, transition: "opacity 0.3s", pointerEvents: visible ? "all" : "none" }}
      >
        {/* Progress bar */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ height: 5, background: "rgba(255,255,255,0.18)", borderRadius: 5, cursor: "pointer", position: "relative" }} onClick={onBarClick}>
            <div style={{ position: "absolute", inset: "0 auto 0 0", width: `${pct}%`, background: "linear-gradient(90deg,#818cf8,#6366f1)", borderRadius: 5 }} />
            <div style={{ position: "absolute", top: "50%", left: `${pct}%`, transform: "translate(-50%,-50%)", width: 13, height: 13, background: "#818cf8", borderRadius: "50%", boxShadow: "0 0 8px rgba(99,102,241,0.9)" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 5 }}>
            <span>{fmt(position)}</span><span>{fmt(duration)}</span>
          </div>
        </div>

        {/* Button row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <CtrlBtn onClick={() => seekBy(-10)} title="Back 10s">⏪</CtrlBtn>
          <CtrlBtn onClick={togglePlay} title={paused ? "Play" : "Pause"} big>{paused ? "▶" : "⏸"}</CtrlBtn>
          <CtrlBtn onClick={() => seekBy(10)} title="Forward 10s">⏩</CtrlBtn>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <CtrlBtn onClick={() => setShowSpeed((s) => !s)} title="Speed" active={speed !== 1}>
              <span style={{ fontSize: 11, fontWeight: 700 }}>{speed}×</span>
            </CtrlBtn>
            {showSpeed && (
              <div style={{ position: "absolute", bottom: 48, right: 0, background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, overflow: "hidden", zIndex: 50, minWidth: 72 }}>
                {SPEEDS.map((s) => (
                  <button key={s} onClick={() => pickSpeed(s)}
                    style={{ display: "block", width: "100%", padding: "7px 18px", background: speed === s ? "rgba(99,102,241,0.2)" : "transparent", border: "none", color: speed === s ? "#818cf8" : "#e2e8f0", fontSize: 12, cursor: "pointer", fontWeight: speed === s ? 700 : 400 }}>
                    {s}×
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CtrlBtn({ children, onClick, title, big, active }: { children: React.ReactNode; onClick?: () => void; title?: string; big?: boolean; active?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} title={title}
      style={{ background: active ? "rgba(99,102,241,0.3)" : hover ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.08)", border: `1px solid ${active ? "rgba(99,102,241,0.5)" : "rgba(255,255,255,0.12)"}`, color: "white", borderRadius: 8, width: big ? 42 : 36, height: big ? 42 : 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, fontSize: big ? 16 : 13 }}>
      {children}
    </button>
  );
}
