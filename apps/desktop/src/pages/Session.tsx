import { useSessionStore } from "../store/session";
import { VideoPlayer } from "../components/VideoPlayer";
import { FacecamGrid } from "../components/FacecamGrid";
import { ChatPanel } from "../components/ChatPanel";
import { RoomLink } from "../components/RoomLink";
import { PeerList } from "../components/PeerList";

export function Session() {
  const { peers, roomUrl, closeRoom, leaveSession } = useSessionStore();

  return (
    <div className="session-root">
      {/* Header */}
      <header className="session-header">
        <div className="session-header-left">
          <div className="logo-icon-sm">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
              <defs>
                <linearGradient id="logoGradSm" x1="0" y1="0" x2="24" y2="24">
                  <stop stopColor="#818cf8" />
                  <stop offset="1" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              <path d="M8 5v14l11-7z" fill="url(#logoGradSm)" />
            </svg>
          </div>
          <span className="session-title">StreamSync</span>
          <span className="viewer-count">
            <span className="viewer-dot" />
            {peers.length} viewer{peers.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="session-header-right">
          {roomUrl && <RoomLink compact />}
          <button onClick={leaveSession} className="btn-ghost">
            ← Back
          </button>
          <button
            onClick={closeRoom}
            className="btn-danger"
          >
            End Session
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="session-body">
        {/* Left: Video */}
        <div className="session-video-area">
          <div className="video-container">
            <VideoPlayer />
          </div>
          {/* Facecam row */}
          <div className="facecam-row">
            <FacecamGrid />
          </div>
        </div>

        {/* Right: Sidebar */}
        <div className="session-sidebar">
          <PeerList />
          <div className="sidebar-chat">
            <ChatPanel />
          </div>
        </div>
      </div>
    </div>
  );
}
