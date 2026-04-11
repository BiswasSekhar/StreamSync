import { useRef, useEffect, useCallback } from "react";
import { useSessionStore } from "../store/session";

// The signaller server (Rust/axum) at :8787 serves the host's current video
// with range requests so the browser can seek without loading the full file.
const HOST_VIDEO_URL = "http://localhost:8787/host-video";

export function VideoPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { filePath, play, pause, seek } = useSessionStore();
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSyncTime = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !filePath) return;

    // Point to the local video streaming endpoint — works in both dev & prod
    // Adding a cache-buster ensures the browser re-fetches when file changes
    video.src = `${HOST_VIDEO_URL}?t=${Date.now()}`;
    video.load();

    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, [filePath]);

  // Periodic sync broadcast
  useEffect(() => {
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(() => {
      const video = videoRef.current;
      if (video && !video.paused) {
        const now = Date.now();
        if (now - lastSyncTime.current >= 2000) {
          lastSyncTime.current = now;
          useSessionStore.getState().seek(video.currentTime);
        }
      }
    }, 500);
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, []);

  const handlePlay = useCallback(() => play(), [play]);
  const handlePause = useCallback(() => pause(), [pause]);
  const handleSeeked = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    seek(e.currentTarget.currentTime);
  }, [seek]);
  const handleTimeUpdate = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    useSessionStore.setState({ position: e.currentTarget.currentTime });
  }, []);

  if (!filePath) {
    return (
      <div className="flex items-center justify-center text-[#9ca3af] text-sm">
        No video loaded
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      onPlay={handlePlay}
      onPause={handlePause}
      onSeeked={handleSeeked}
      onTimeUpdate={handleTimeUpdate}
      controls
      className="w-full h-full object-contain bg-black"
      style={{ maxHeight: "calc(100vh - 180px)", borderRadius: "12px", overflow: "hidden", boxShadow: "0 20px 40px rgba(0,0,0,0.4)" }}
    />
  );
}

