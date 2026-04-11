import { useRef, useEffect, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/session";

export function VideoPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { filePath, encodeComplete, play, pause, seek, encodeProgress } = useSessionStore();
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSyncTime = useRef(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !filePath) return;

    // Host plays encoded output file directly via Tauri convertFileSrc
    const loadSrc = async () => {
      try {
        // Build temp path (same logic as Rust get_temp_output_path)
        const name = filePath.split(/[\\/]/).pop()!;
        const stem = name.replace(/\.[^.]+$/, "");
        const tempPath = await getTempDir();
        const outputPath = `${tempPath}\\${stem}_streamsync_output.mp4`;
        video.src = convertFileSrc(outputPath);
      } catch (e) {
        console.error("Failed to set video source:", e);
        // Fallback: load the original file
        video.src = convertFileSrc(filePath);
      }
    };

    loadSrc();

    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, [filePath, encodeComplete]);

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

  if (encodeProgress && !encodeComplete) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-[#9ca3af]">
        <svg className="animate-spin w-8 h-8" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm">
          Encoding… {encodeProgress.percent.toFixed(0)}% ({encodeProgress.encoder})
        </span>
        <span className="text-xs text-[#666]">
          Video will be playable shortly
        </span>
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
      className="max-w-full max-h-full"
      style={{ maxHeight: "calc(100vh - 260px)" }}
    />
  );
}

async function getTempDir(): Promise<string> {
  try {
    const { tempDir } = await import("@tauri-apps/api/path");
    const dir = await tempDir();
    return dir.replace(/\/$/, "");
  } catch {
    return "/tmp";
  }
}
