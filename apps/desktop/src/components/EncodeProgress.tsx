import { useSessionStore } from "../store/session";

export function EncodeProgress() {
  const { encodeProgress, encodeComplete } = useSessionStore();

  if (encodeComplete) {
    return (
      <div className="surface" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="badge-ready">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399" }} className="dot-pulse" />
            Ready to stream
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Encoding complete</span>
        </div>
      </div>
    );
  }

  if (!encodeProgress) return null;

  const { percent, fps, etaSeconds, encoder, outputSizeBytes } = encodeProgress;

  const formatEta = (s: number) => {
    if (s <= 0) return "–";
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  return (
    <div className="surface" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="badge-encoding">
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fbbf24" }} className="dot-pulse" />
          Encoding…
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {encoder} · {fps > 0 ? `${fps.toFixed(0)} fps` : ""} · ETA {formatEta(etaSeconds)}
        </span>
      </div>
      <div className="progress-bar">
        <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
        <span>{percent.toFixed(1)}%</span>
        {outputSizeBytes > 0 && (
          <span>{(outputSizeBytes / 1e6).toFixed(0)} MB written</span>
        )}
      </div>
      <p style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        Receivers can join now — streaming starts before encoding is complete
      </p>
    </div>
  );
}
