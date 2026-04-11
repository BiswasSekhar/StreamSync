import { useRef, useEffect, useState } from "react";
import { useSessionStore } from "../store/session";

interface CamFeed {
  id: string;
  label: string;
  stream: MediaStream | null;
}

export function FacecamGrid() {
  const { peers, displayName } = useSessionStore();
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      setLocalStream(stream);
      setCameraOn(true);
      setMicOn(true);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (e) {
      console.error("Failed to get camera:", e);
    }
  };

  const stopCamera = () => {
    localStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setCameraOn(false);
  };

  const toggleMic = () => {
    localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled;
    });
    setMicOn(!micOn);
  };

  return (
    <div className="h-full flex items-center gap-2 px-3 overflow-x-auto">
      {/* Host feed */}
      <div className="relative flex-shrink-0 h-24 w-32 bg-[#1a1a1a] rounded-lg overflow-hidden border border-[#2a2a2a]">
        {localStream ? (
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover scale-x-[-1]"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2">
            <div className="w-8 h-8 rounded-full bg-indigo-500/30 flex items-center justify-center">
              <svg width="16" height="16" fill="none" stroke="#6366f1" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
          </div>
        )}
        <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between">
          <span className="text-xs bg-black/60 text-white px-1 rounded">You</span>
          <div className="flex gap-1">
            <button
              onClick={localStream ? stopCamera : startCamera}
              className="w-5 h-5 rounded bg-black/60 flex items-center justify-center hover:bg-black/80"
            >
              <svg width="10" height="10" fill={cameraOn ? "white" : "#ef4444"} viewBox="0 0 24 24">
                <path d="M15 10l4.553-2.069A1 1 0 0121 8.847v6.306a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              </svg>
            </button>
            {localStream && (
              <button
                onClick={toggleMic}
                className="w-5 h-5 rounded bg-black/60 flex items-center justify-center hover:bg-black/80"
              >
                <svg width="10" height="10" fill={micOn ? "white" : "#ef4444"} viewBox="0 0 24 24">
                  <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Peer feeds (placeholders — real video via WebRTC tracks in full impl) */}
      {peers.map((peer) => (
        <div
          key={peer.id}
          className="relative flex-shrink-0 h-24 w-32 bg-[#1a1a1a] rounded-lg overflow-hidden border border-[#2a2a2a]"
        >
          <div className="w-full h-full flex items-center justify-center">
            <div className="w-8 h-8 rounded-full bg-emerald-500/30 flex items-center justify-center">
              <span className="text-sm font-medium text-emerald-400">
                {(peer.displayName || "G")[0].toUpperCase()}
              </span>
            </div>
          </div>
          <div className="absolute bottom-1 left-1">
            <span className="text-xs bg-black/60 text-white px-1 rounded">
              {peer.displayName || "Guest"}
            </span>
          </div>
        </div>
      ))}

      {peers.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-[#666] ml-2">
          <span>Waiting for viewers to join…</span>
        </div>
      )}
    </div>
  );
}
