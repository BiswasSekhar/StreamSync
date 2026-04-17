import { useState } from "react";
import { useSessionStore } from "../store/session";

interface Props {
  compact?: boolean;
}

export function RoomLink({ compact = false }: Props) {
  const { roomUrl, shareCode, signallingMode, magnetLink, encodeProgress } = useSessionStore();
  const [copied, setCopied] = useState(false);

  const isTracker = signallingMode === "tracker";
  const shareValue = isTracker ? shareCode : roomUrl;

  if (!shareValue) return null;

  const copyCode = async () => {
    await navigator.clipboard.writeText(shareValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isReady = magnetLink !== null;

  if (compact) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={copyCode} className="btn-ghost" style={{ fontSize: 11 }}>
          {copied ? "✓ Copied!" : isTracker ? "Copy Share Code" : "Copy Room URL"}
        </button>
      </div>
    );
  }

  return (
    <div className="surface" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16, animation: "fadeInUp 0.3s ease-out", alignItems: "center", textAlign: "center" }}>
      {/* Status */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {isReady ? (
          <span className="badge-ready">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399" }} className="dot-pulse" />
            Ready to stream
          </span>
        ) : (
          <span className="badge-encoding">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fbbf24" }} className="dot-pulse" />
            Preparing…
            {encodeProgress && ` ${encodeProgress.percent.toFixed(0)}%`}
          </span>
        )}
      </div>

      {/* Code Display */}
      <div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
          {isTracker ? "Share this Room Code" : "Share this Room URL"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(0,0,0,0.4)", padding: "12px 16px", borderRadius: 16, border: "1px solid rgba(255,255,255,0.05)", maxWidth: 620 }}>
          <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 600, color: "#f1f5f9", wordBreak: "break-all" }}>
            {shareValue}
          </span>
          <div style={{ width: 1, height: 40, background: "rgba(255,255,255,0.1)", margin: "0 2px" }} />
          <button onClick={copyCode} className="btn-ghost" style={{ width: 44, height: 44, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {copied ? (
              <svg width="20" height="20" fill="none" stroke="#34d399" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>
      
      <span style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 300 }}>
        {isTracker
          ? "Friends can join by entering this share code in StreamSync desktop."
          : "Friends can join by opening the URL in a browser or pasting it in StreamSync desktop."}
      </span>
    </div>
  );
}
