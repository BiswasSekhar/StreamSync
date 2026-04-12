/**
 * VideoOverlay — custom video controls layer.
 * Sits on top of a <video> element. No native `controls` needed on the video.
 * Handles: progress bar, play/pause, ±10s seek, volume, speed, subtitles, visual flash feedback.
 */
import React, { useEffect, useState, useRef, useCallback } from "react";

/* ── Global key→video map (space, arrows, M, etc.) ── */
function useVideoKeyboard(videoEl: HTMLVideoElement | null) {
  useEffect(() => {
    if (!videoEl) return;
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keys when the user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          videoEl.paused ? videoEl.play().catch(() => {}) : videoEl.pause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
          break;
        case "ArrowRight":
          e.preventDefault();
          videoEl.currentTime = Math.min(
            isFinite(videoEl.duration) ? videoEl.duration : Infinity,
            videoEl.currentTime + 10,
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          videoEl.volume = Math.min(1, videoEl.volume + 0.05);
          videoEl.muted = false;
          break;
        case "ArrowDown":
          e.preventDefault();
          videoEl.volume = Math.max(0, videoEl.volume - 0.05);
          break;
        case "m":
        case "M":
          e.preventDefault();
          videoEl.muted = !videoEl.muted;
          break;
        case "f":
        case "F":
          e.preventDefault();
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          } else {
            videoEl.closest("div")?.requestFullscreen?.().catch(() => {});
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [videoEl]);
}

import { useSessionStore } from "../store/session";

interface SubEntry { start: number; end: number; text: string; }

interface Props {
  videoEl: HTMLVideoElement | null;
}

export function VideoOverlay({ videoEl }: Props) {
  // Wire up keyboard shortcuts
  useVideoKeyboard(videoEl);

  const { probeResult, extractSubtitle } = useSessionStore();
  const [extractingSubIdx, setExtractingSubIdx] = useState<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [visible, setVisible] = useState(true);
  const [showVol, setShowVol] = useState(false);
  const [showSpeed, setShowSpeed] = useState(false);
  const [showSub, setShowSub] = useState(false);
  const [flash, setFlash] = useState<{ type: string; key: number } | null>(null);
  const [subtitles, setSubtitles] = useState<SubEntry[]>([]);
  const [currentSub, setCurrentSub] = useState("");
  const [subPos, setSubPos] = useState<"top" | "center" | "bottom">("bottom");
  const [subSize, setSubSize] = useState(18);

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashKeyRef = useRef(0);

  // ── Attach / detach event listeners when videoEl changes ──
  useEffect(() => {
    const v = videoEl;
    if (!v) return;

    const sync = () => {
      setPlaying(!v.paused);
      setDuration(isFinite(v.duration) ? v.duration : 0);
      setTime(v.currentTime);
      setVolume(v.volume);
      setMuted(v.muted);
      setSpeed(v.playbackRate);
    };
    sync();

    const onPlay = () => setPlaying(true);
    const onPause = () => { setPlaying(false); setVisible(true); };
    const onDurationChange = () => setDuration(isFinite(v.duration) ? v.duration : 0);
    const onTimeUpdate = () => setTime(v.currentTime);
    const onVolumeChange = () => { setVolume(v.volume); setMuted(v.muted); };
    const onRateChange = () => setSpeed(v.playbackRate);

    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("durationchange", onDurationChange);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("volumechange", onVolumeChange);
    v.addEventListener("ratechange", onRateChange);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("durationchange", onDurationChange);
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("volumechange", onVolumeChange);
      v.removeEventListener("ratechange", onRateChange);
    };
  }, [videoEl]);

  // Update current subtitle line
  useEffect(() => {
    if (!subtitles.length) { setCurrentSub(""); return; }
    const s = subtitles.find(e => time >= e.start && time <= e.end);
    setCurrentSub(s?.text ?? "");
  }, [time, subtitles]);

  // Auto-hide controls when playing
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (videoEl && !videoEl.paused) {
      hideTimerRef.current = setTimeout(() => setVisible(false), 3000);
    }
  }, [videoEl]);

  const revealControls = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const doFlash = (type: string) => {
    flashKeyRef.current++;
    setFlash({ type, key: flashKeyRef.current });
    setTimeout(() => setFlash(null), 750);
  };

  const togglePlay = useCallback(() => {
    const v = videoEl;
    if (!v) return;
    if (v.paused) { v.play().catch(console.error); doFlash("play"); }
    else { v.pause(); doFlash("pause"); }
  }, [videoEl]);

  const seekBy = useCallback((delta: number) => {
    const v = videoEl;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(isFinite(v.duration) ? v.duration : 0, v.currentTime + delta));
    doFlash(delta > 0 ? "fwd" : "bwd");
  }, [videoEl]);

  const onBarClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoEl;
    if (!v || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = ((e.clientX - r.left) / r.width) * duration;
  }, [videoEl, duration]);

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return "0:00";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };

  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

  const subStyle: React.CSSProperties = subPos === "top"
    ? { top: 60, bottom: "auto", transform: "translateX(-50%)" }
    : subPos === "center"
    ? { top: "50%", bottom: "auto", transform: "translateX(-50%) translateY(-50%)" }
    : { bottom: 92, top: "auto", transform: "translateX(-50%)" };

  // Flash position: bwd=left quarter, fwd=right quarter, play/pause=center
  const flashLeft = flash?.type === "bwd" ? "25%" : flash?.type === "fwd" ? "75%" : "50%";

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 15, cursor: visible ? "default" : "none" }}
      onMouseMove={revealControls}
      onMouseLeave={() => { if (playing) setVisible(false); }}
    >
      {/* Transparent click-to-play area (stops at controls) */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 90 }} onClick={togglePlay} />

      {/* Flash animation */}
      {flash && (
        <div key={flash.key} style={{ position: "absolute", top: "50%", left: flashLeft, transform: "translate(-50%,-50%)", pointerEvents: "none", zIndex: 30, animation: "vcFlash 0.7s ease forwards" }}>
          <FlashBadge type={flash.type} />
        </div>
      )}

      {/* Subtitle */}
      {currentSub && (
        <div style={{ position: "absolute", left: "50%", zIndex: 20, textAlign: "center", pointerEvents: "none", maxWidth: "80%", ...subStyle }}>
          {currentSub.split("\n").map((line, i) => (
            <div key={i} style={{ display: "inline-block", background: "rgba(0,0,0,0.8)", color: "#fff", fontSize: subSize, lineHeight: 1.5, padding: "2px 12px", borderRadius: 4, marginBottom: 2 }}>{line}</div>
          ))}
        </div>
      )}

      {/* Controls panel */}
      <div
        onClick={e => e.stopPropagation()}
        style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "56px 18px 14px", background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 60%, transparent 100%)", opacity: visible ? 1 : 0, transition: "opacity 0.3s", pointerEvents: visible ? "all" : "none" }}
      >
        {/* Progress bar */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ height: 5, background: "rgba(255,255,255,0.18)", borderRadius: 5, cursor: "pointer", position: "relative", overflow: "visible" }} onClick={onBarClick}>
            <div style={{ position: "absolute", inset: "0 auto 0 0", width: `${pct}%`, background: "linear-gradient(90deg,#818cf8,#6366f1)", borderRadius: 5 }} />
            <div style={{ position: "absolute", top: "50%", left: `${pct}%`, transform: "translate(-50%,-50%)", width: 13, height: 13, background: "#818cf8", borderRadius: "50%", boxShadow: "0 0 8px rgba(99,102,241,0.9)", flexShrink: 0 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 5 }}>
            <span>{fmt(time)}</span><span>{fmt(duration)}</span>
          </div>
        </div>

        {/* Button row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>

          <VBtn onClick={() => seekBy(-10)} title="Back 10s">
            <RewindIcon /><sup style={{ fontSize: 9, marginLeft: 1 }}>10</sup>
          </VBtn>

          <VBtn onClick={togglePlay} title={playing ? "Pause" : "Play"} big>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </VBtn>

          <VBtn onClick={() => seekBy(10)} title="Forward 10s">
            <FastFwdIcon /><sup style={{ fontSize: 9, marginLeft: 1 }}>10</sup>
          </VBtn>

          {/* Volume */}
          <div style={{ position: "relative" }} onMouseLeave={() => setShowVol(false)}>
            <VBtn
              onMouseEnter={() => setShowVol(true)}
              onClick={() => { if (videoEl) videoEl.muted = !videoEl.muted; }}
              title={muted ? "Unmute" : "Mute"}
            >
              <VolIcon vol={muted ? 0 : volume} />
            </VBtn>
            {showVol && (
              <div onMouseEnter={() => setShowVol(true)} style={{ position: "absolute", bottom: 48, left: "50%", transform: "translateX(-50%)", background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "14px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, zIndex: 50 }}>
                <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
                  onChange={e => { if (videoEl) { videoEl.volume = +e.target.value; videoEl.muted = false; } }}
                  style={{ writingMode: "vertical-lr" as any, direction: "rtl" as any, height: 80, accentColor: "#6366f1" }} />
                <span style={{ fontSize: 10, color: "#94a3b8" }}>{muted ? "0" : Math.round(volume * 100)}%</span>
              </div>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* Speed */}
          <div style={{ position: "relative" }}>
            <VBtn onClick={() => { setShowSpeed(s => !s); setShowSub(false); }} title="Speed" active={speed !== 1}>
              <span style={{ fontSize: 11, fontWeight: 700 }}>{speed}×</span>
            </VBtn>
            {showSpeed && (
              <div style={{ position: "absolute", bottom: 48, right: 0, background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, overflow: "hidden", zIndex: 50, minWidth: 72 }}>
                {speeds.map(s => (
                  <button key={s} onClick={() => { if (videoEl) videoEl.playbackRate = s; setShowSpeed(false); }}
                    style={{ display: "block", width: "100%", padding: "7px 18px", background: speed === s ? "rgba(99,102,241,0.2)" : "transparent", border: "none", color: speed === s ? "#818cf8" : "#e2e8f0", fontSize: 12, cursor: "pointer", fontWeight: speed === s ? 700 : 400, textAlign: "center" }}>
                    {s}×
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Subtitles */}
          <div style={{ position: "relative" }}>
            <VBtn onClick={() => { setShowSub(s => !s); setShowSpeed(false); }} title="Subtitles" active={subtitles.length > 0}>
              <span style={{ fontSize: 11, fontWeight: 700 }}>CC</span>
            </VBtn>
            {showSub && (
              <div style={{ position: "absolute", bottom: 48, right: 0, background: "#0d0d0d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 16, minWidth: 230, zIndex: 50, maxHeight: 350, overflowY: "auto" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#f1f5f9", marginBottom: 12 }}>Subtitles</div>
                
                {/* Embedded Subtitles */}
                {probeResult?.subtitleStreams && probeResult.subtitleStreams.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>Embedded</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {probeResult.subtitleStreams.map(s => (
                        <button
                          key={s.index}
                          onClick={async () => {
                            try {
                              setExtractingSubIdx(s.index);
                              const vttText = await extractSubtitle(s.index);
                              setSubtitles(parseVTT(vttText));
                              setShowSub(false);
                            } catch (e) {
                              console.error("Failed to extract sub", e);
                            } finally {
                              setExtractingSubIdx(null);
                            }
                          }}
                          disabled={extractingSubIdx === s.index}
                          style={{ textAlign: "left", padding: "7px 10px", fontSize: 11, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)", color: extractingSubIdx === s.index ? "#6366f1" : "#e2e8f0", borderRadius: 6, cursor: extractingSubIdx === s.index ? "wait" : "pointer", display: "flex", justifyContent: "space-between" }}
                        >
                          <span>{s.language.toUpperCase()} • {s.codecName} {s.title ? `(${s.title})` : ""}</span>
                          {extractingSubIdx === s.index && <span style={{ opacity: 0.5 }}>...</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>External</div>
                <label style={{ display: "block", cursor: "pointer", textAlign: "center", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)", color: "#e2e8f0", borderRadius: 8, padding: "9px 0", fontSize: 12 }}>
                  Load .srt / .vtt
                  <input type="file" accept=".srt,.vtt" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) { loadSubs(f, setSubtitles); setShowSub(false); } }} />
                </label>
                
                {subtitles.length > 0 && (
                  <>
                    <button onClick={() => { setSubtitles([]); setCurrentSub(""); }} style={{ display: "block", width: "100%", marginTop: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "#f87171", borderRadius: 8, padding: "7px 0", fontSize: 12, cursor: "pointer" }}>
                      Remove subtitles
                    </button>
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>Position</div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {(["top", "center", "bottom"] as const).map(p => (
                          <button key={p} onClick={() => setSubPos(p)}
                            style={{ flex: 1, padding: "5px 0", fontSize: 11, border: `1px solid ${subPos === p ? "#6366f1" : "rgba(255,255,255,0.1)"}`, background: subPos === p ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.04)", color: subPos === p ? "#818cf8" : "#e2e8f0", borderRadius: 6, cursor: "pointer" }}>
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>Size: {subSize}px</div>
                      <input type="range" min={12} max={48} value={subSize} onChange={e => setSubSize(+e.target.value)} style={{ width: "100%", accentColor: "#6366f1" }} />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      <style>{`
        @keyframes vcFlash {
          0%  { opacity: 1; transform: translate(-50%,-50%) scale(0.7); }
          30% { opacity: 1; transform: translate(-50%,-50%) scale(1.15); }
          100%{ opacity: 0; transform: translate(-50%,-50%) scale(1.35); }
        }
      `}</style>
    </div>
  );
}

// ── Subtitle parsers ──────────────────────────────────────────
function parseVTT(text: string): SubEntry[] {
  const entries: SubEntry[] = [];
  const body = text.replace(/^WEBVTT[^\n]*\n/, "").replace(/^NOTE[^\n]*\n[\s\S]*?\n\n/gm, "").trim();
  if (!body) return entries;
  
  for (const block of body.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    
    let tsLineIdx = -1;
    let m: RegExpMatchArray | null = null;
    for (let i = 0; i < 2; i++) {
      if (lines[i]) {
        m = lines[i].match(/(?:(\d{2}):)?(\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}:\d{2}[,\.]\d{3})/);
        if (m) {
          tsLineIdx = i;
          break;
        }
      }
    }
    
    if (tsLineIdx === -1 || !m) continue;
    
    const parseTime = (h: string | undefined, msString: string) => {
      const hr = h || "00";
      const [mi, s_ms] = msString.split(":");
      const [s, ms] = s_ms.replace(",", ".").split(".");
      return Number(hr) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
    };
    
    const start = parseTime(m[1], m[2]);
    const end = parseTime(m[3], m[4]);
    const txt = lines.slice(tsLineIdx + 1).join("\n").replace(/<[^>]+>/g, "");
    
    entries.push({ start, end, text: txt });
  }
  return entries;
}

function parseSRT(text: string): SubEntry[] {
  return parseVTT(text);
}
function loadSubs(file: File, set: (e: SubEntry[]) => void) {
  const r = new FileReader();
  r.onload = e => {
    const t = e.target?.result as string;
    if (t) set(file.name.endsWith(".vtt") ? parseVTT(t) : parseSRT(t));
  };
  r.readAsText(file);
}

// ── Shared button ──────────────────────────────────────────────
function VBtn({ children, onClick, onMouseEnter, title, big, active }: {
  children: React.ReactNode; onClick?: () => void; onMouseEnter?: () => void;
  title?: string; big?: boolean; active?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => { setHover(true); onMouseEnter?.(); }} onMouseLeave={() => setHover(false)} title={title}
      style={{ background: active ? "rgba(99,102,241,0.3)" : hover ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.08)", border: `1px solid ${active ? "rgba(99,102,241,0.5)" : "rgba(255,255,255,0.12)"}`, color: "white", borderRadius: 8, width: big ? 42 : 36, height: big ? 42 : 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, gap: 1, transition: "background 0.15s, border 0.15s" }}>
      {children}
    </button>
  );
}

// ── Icons ──────────────────────────────────────────────────────
function PlayIcon() {
  return <svg width="14" height="14" fill="white" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>;
}
function PauseIcon() {
  return <svg width="14" height="14" fill="white" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>;
}
function RewindIcon() {
  return <svg width="14" height="14" fill="none" stroke="white" strokeWidth="2.2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>;
}
function FastFwdIcon() {
  return <svg width="14" height="14" fill="none" stroke="white" strokeWidth="2.2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4"/></svg>;
}
function VolIcon({ vol }: { vol: number }) {
  if (vol === 0) return <svg width="16" height="16" fill="none" stroke="white" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>;
  if (vol < 0.5) return <svg width="16" height="16" fill="none" stroke="white" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>;
  return <svg width="16" height="16" fill="none" stroke="white" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>;
}
function FlashBadge({ type }: { type: string }) {
  const s: React.CSSProperties = { width: 72, height: 72, borderRadius: "50%", background: "rgba(0,0,0,0.55)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "white", gap: 3 };
  const label = type === "fwd" ? "+10s" : type === "bwd" ? "-10s" : "";
  return (
    <div style={s}>
      {type === "play" && <PlayIcon />}
      {type === "pause" && <PauseIcon />}
      {type === "fwd" && <FastFwdIcon />}
      {type === "bwd" && <RewindIcon />}
      {label && <span style={{ fontSize: 11, fontWeight: 700 }}>{label}</span>}
    </div>
  );
}
