import { useRef, useEffect, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/session";

interface Props {
  onVideoRef?: (el: HTMLVideoElement | null) => void;
  onHeartbeat?: (position: number, playing: boolean) => void;
}

export function VideoPlayer({ onVideoRef, onHeartbeat }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { filePath, play, pause, seek } = useSessionStore();
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onHeartbeatRef = useRef(onHeartbeat);
  onHeartbeatRef.current = onHeartbeat;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !filePath) return;
    // Tauri's asset protocol — reads the file directly from disk with
    // native Range support. No HTTP server, no localhost dependency.
    video.src = convertFileSrc(filePath);
    video.load();
  }, [filePath]);

  // Expose video element to parent
  useEffect(() => {
    onVideoRef?.(videoRef.current);
    return () => { onVideoRef?.(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat: broadcast every 1s regardless of play/pause state
  useEffect(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = setInterval(() => {
      const video = videoRef.current;
      if (video) {
        onHeartbeatRef.current?.(video.currentTime, !video.paused);
      }
    }, 1000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
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
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: 15 }}>
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
      style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
    />
  );
}
