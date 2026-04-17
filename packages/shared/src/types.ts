// Legacy domain models still shared across clients.

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
  needsRemux: boolean;
  /** MSE MIME codec string, e.g. 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' */
  codecHint: string;
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
