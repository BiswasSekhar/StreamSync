import { useState, useEffect } from "react";
import { useSessionStore } from "../store/session";

interface Props {
  compact?: boolean;
}

export function RoomLink({ compact = false }: Props) {
  const { roomUrl, magnetLink, encodeProgress, tunnelConnected } = useSessionStore();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    if (roomUrl && !compact) {
      generateQR(roomUrl).then(setQrDataUrl).catch(console.error);
    }
  }, [roomUrl, compact]);

  if (!roomUrl) return null;

  const copyLink = async () => {
    await navigator.clipboard.writeText(roomUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isReady = magnetLink !== null;

  if (compact) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {tunnelConnected ? (
          <span className="badge-ready" style={{ fontSize: 10, padding: "2px 8px" }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#34d399" }} />
            Live
          </span>
        ) : (
          <span className="badge-error" style={{ fontSize: 10, padding: "2px 8px" }}>Reconnecting…</span>
        )}
        <button onClick={copyLink} className="btn-ghost" style={{ fontSize: 11 }}>
          {copied ? "✓ Copied!" : "Copy link"}
        </button>
      </div>
    );
  }

  return (
    <div className="surface" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14, animation: "fadeInUp 0.3s ease-out" }}>
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
        {!tunnelConnected && (
          <span className="badge-error">Tunnel reconnecting…</span>
        )}
      </div>

      {/* Link */}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          readOnly
          value={roomUrl}
          style={{ flex: 1, fontFamily: "monospace", fontSize: 11 }}
          onFocus={(e) => e.target.select()}
        />
        <button onClick={copyLink} className="btn-secondary" style={{ whiteSpace: "nowrap" }}>
          {copied ? (
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <svg width="14" height="14" fill="none" stroke="#34d399" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </span>
          ) : "Copy"}
        </button>
      </div>

      {/* QR + info */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => setShowQr(!showQr)} className="btn-ghost" style={{ fontSize: 12 }}>
          {showQr ? "Hide QR" : "📱 Show QR Code"}
        </button>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          No account or install needed. Link expires when you close StreamSync.
        </span>
      </div>

      {showQr && qrDataUrl && (
        <div style={{ display: "flex", justifyContent: "center", padding: 12, background: "white", borderRadius: 12 }}>
          <img src={qrDataUrl} alt="Room QR code" width={180} height={180} />
        </div>
      )}
    </div>
  );
}

async function generateQR(url: string): Promise<string> {
  const QRCode = await import("qrcode");
  return QRCode.default.toDataURL(url, { width: 200, margin: 2, color: { dark: "#1a1a28", light: "#ffffff" } });
}
