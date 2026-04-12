import { useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "../store/session";
import { VideoPlayer } from "../components/VideoPlayer";
import { FacecamGrid } from "../components/FacecamGrid";
import { ChatPanel } from "../components/ChatPanel";
import { RoomLink } from "../components/RoomLink";
import { PeerList } from "../components/PeerList";
import { HostWebRTC } from "../lib/hostWebrtc";

export function Session() {
  const { peers, roomUrl, closeRoom, leaveSession, sessionId, showToast } = useSessionStore();
  const hostRtcRef = useRef<HostWebRTC | null>(null);

  // Initialize HostWebRTC when session starts
  useEffect(() => {
    if (!sessionId || !roomUrl) return;

    const rtc = new HostWebRTC(
      // onPeerJoined
      (peerId, displayName) => {
        useSessionStore.setState((s) => ({
          peers: [
            ...s.peers,
            { id: peerId, displayName, videoPosition: 0, connected: true },
          ],
        }));
        showToast(`${displayName} joined the session`, "info");
      },
      // onPeerLeft
      (peerId) => {
        useSessionStore.setState((s) => ({
          peers: s.peers.filter((p) => p.id !== peerId),
        }));
      },
      // onChat
      (msg) => {
        useSessionStore.setState((s) => ({
          messages: [...s.messages, msg],
        }));
      },
      // onError
      (err) => {
        console.error("[Session] HostWebRTC error:", err);
        showToast(`WebRTC error: ${err}`, "error");
      }
    );

    hostRtcRef.current = rtc;
    rtc.connect(sessionId, useSessionStore.getState().displayName);

    return () => {
      rtc.close();
      hostRtcRef.current = null;
    };
  }, [sessionId, roomUrl]);

  // Bind magnet link to HostWebRTC
  const magnetLink = useSessionStore((s) => s.magnetLink);
  const filePath = useSessionStore((s) => s.filePath);

  useEffect(() => {
    if (magnetLink && hostRtcRef.current && roomUrl) {
      const fileName = filePath?.split(/[\\/]/).pop() ?? "video";
      
      const baseUrl = roomUrl.split("?")[0];
      const wsUrl = baseUrl.endsWith("/") ? baseUrl + "host-video" : baseUrl + "/host-video";
      const enrichedMagnet = magnetLink + `&ws=${encodeURIComponent(wsUrl)}`;

      hostRtcRef.current.setMagnet(enrichedMagnet, fileName);
    }
  }, [magnetLink, filePath, roomUrl]);

  // Forward host's own chat messages to peers
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (state.messages.length > prev.messages.length) {
        const newMsg = state.messages[state.messages.length - 1];
        if (newMsg.from === state.displayName && hostRtcRef.current) {
          hostRtcRef.current.broadcastChat(newMsg);
        }
      }
    });
    return unsub;
  }, []);

  // Forward sync state from VideoPlayer to all peers
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (!hostRtcRef.current) return;
      if (state.position !== prev.position || state.isPlaying !== prev.isPlaying) {
        hostRtcRef.current.broadcastSync(state.position, state.isPlaying);
      }
    });
    return unsub;
  }, []);

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
