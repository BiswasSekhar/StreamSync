import { useSessionStore } from "../store/session";
import { useState, useEffect } from "react";

export function Settings() {
  const { displayName, setDisplayName, availableEncoders, selectedEncoder, toggleSettings } = useSessionStore();
  const [name, setName] = useState(displayName);
  const [devices, setDevices] = useState<{ cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ cameras: [], mics: [] });

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((devs) => {
      setDevices({
        cameras: devs.filter((d) => d.kind === "videoinput"),
        mics: devs.filter((d) => d.kind === "audioinput"),
      });
    }).catch(() => {});
  }, []);

  return (
    <div className="home-root">
      <header className="home-header">
        <div className="home-header-left">
          <button onClick={toggleSettings} className="btn-ghost">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back
          </button>
        </div>
        <div className="home-header-right">
          <span className="logo-text" style={{ fontSize: 14 }}>Settings</span>
        </div>
      </header>

      <main className="home-main">
        <div className="settings-container">
          {/* Display Name */}
          <div className="settings-section">
            <h3 className="settings-label">Display Name</h3>
            <p className="settings-desc">How you appear to viewers in the chat</p>
            <div className="settings-row">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setDisplayName(name || "Host")}
                placeholder="Host"
                className="settings-input"
              />
            </div>
          </div>

          {/* Encoder */}
          <div className="settings-section">
            <h3 className="settings-label">Video Encoder</h3>
            <p className="settings-desc">Hardware encoder used for transcoding</p>
            <div className="settings-row">
              <select
                value={selectedEncoder ?? "auto"}
                onChange={(e) => useSessionStore.setState({ selectedEncoder: e.target.value })}
                className="settings-select"
              >
                <option value="auto">Auto (fastest available)</option>
                {availableEncoders.map((enc) => (
                  <option key={enc} value={enc}>{enc}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Camera */}
          <div className="settings-section">
            <h3 className="settings-label">Camera</h3>
            <p className="settings-desc">Device used for face cam in watch party</p>
            <div className="settings-row">
              <select className="settings-select">
                <option value="">Default Camera</option>
                {devices.cameras.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 8)}`}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Microphone */}
          <div className="settings-section">
            <h3 className="settings-label">Microphone</h3>
            <p className="settings-desc">Audio input device</p>
            <div className="settings-row">
              <select className="settings-select">
                <option value="">Default Microphone</option>
                {devices.mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 8)}`}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Privacy */}
          <div className="settings-section">
            <h3 className="settings-label">Privacy</h3>
            <p className="settings-desc">Network privacy preferences</p>
            <label className="settings-checkbox">
              <input type="checkbox" defaultChecked />
              <span>Disable DHT (private mode — only invited peers can connect)</span>
            </label>
            <label className="settings-checkbox">
              <input type="checkbox" />
              <span>Use TURN relay (hides direct IPs, but Cloudflare sees traffic)</span>
            </label>
          </div>

          {/* About */}
          <div className="settings-section about">
            <p>StreamSync v1.0.0</p>
            <p>Serverless P2P watch parties. No accounts. No data stored.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
