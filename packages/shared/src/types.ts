// ===== Signalling (over WebSocket via cloudflare) =====

export type SignalMessage =
  | { type: "join"; room: string; displayName?: string }
  | { type: "offer"; sdp: string; peerId: string }
  | { type: "answer"; sdp: string; peerId: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit; peerId: string }
  | { type: "peer-joined"; peerId: string; displayName: string }
  | { type: "peer-left"; peerId: string }
  | { type: "room-full" }
  | { type: "ping"; timestamp: number }
  | { type: "pong"; timestamp: number; serverTime: number }
  | { type: "error"; message: string };

// ===== Data Channel Messages (P2P, post-handshake) =====

export type ControlMessage =
  | { type: "magnet"; magnet: string; fileName: string; duration: number }
  | { type: "ping"; timestamp: number }
  | { type: "pong"; timestamp: number; serverTime: number };

export interface SyncMessage {
  type: "sync";
  position: number;
  playing: boolean;
  timestamp: number;
  sequence: number;
}

export interface ChatMessage {
  type: "chat";
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

// ===== Probe Result =====

export interface VideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  codecName: string;
  containerFormat: string;
  bitrateKbps: number;
  fps: number;
  hasHdr: boolean;
  audioCodec: string;
  needsTranscode: boolean;
  estimatedEncodeSeconds: number;
  fileSizeBytes: number;
}

// ===== Session =====

export interface SessionInfo {
  id: string;
  roomUrl: string;
  magnetLink: string | null;
  peerCount: number;
  encodeProgress: EncodeProgress | null;
  torrentStats: TorrentStats | null;
}

export interface EncodeProgress {
  percent: number;
  fps: number;
  etaSeconds: number;
  encoder: string;
  outputSizeBytes: number;
}

export interface TorrentStats {
  uploadSpeedBps: number;
  peerCount: number;
  piecesReady: number;
  totalPieces: number;
}
