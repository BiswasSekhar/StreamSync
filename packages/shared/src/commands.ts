export const TAURI_COMMANDS = {
  PROBE_FILE: "probe_file",
  DETECT_HARDWARE: "detect_hardware",
  EXTRACT_SUBTITLE: "extract_subtitle_command",
  PREPARE_VIDEO_FOR_STREAMING: "prepare_video_for_streaming",
  START_SEEDING_ORIGINAL: "start_seeding_original",
  LOAD_TORRENT_FILE: "load_torrent_file",
  CREATE_ROOM: "create_room",
  CLOSE_ROOM: "close_room",
  GET_SESSION_STATUS: "get_session_status",
  GET_MAGNET: "get_magnet",
  GET_TORRENT_STATS: "get_torrent_stats",
  LOAD_MAGNET_LINK: "load_magnet_link",
} as const;

export type TauriCommandName = (typeof TAURI_COMMANDS)[keyof typeof TAURI_COMMANDS];

export type SignallingMode = "tracker" | "tunnel";

export interface CreateRoomResponse {
  sessionId: string;
  shareCode: string;
  trackerInfoHash: string;
  fallbackUrl: string | null;
  mode: SignallingMode;
  trackerUrls: string[];
}

export interface SessionStatusPeer {
  id: string;
  displayName: string;
}

export interface SessionStatusResponse {
  session: {
    id: string;
    mode: SignallingMode;
    shareCode: string;
    roomUrl: string;
    fallbackUrl: string | null;
    magnetLink: string | null;
  } | null;
  encodeProgress: {
    percent: number;
    fps: number;
    etaSeconds: number;
    encoder: string;
    outputSizeBytes: number;
  } | null;
  encodeComplete: boolean;
  selectedEncoder: string;
  torrent: {
    magnetLink: string;
    peerCount: number;
    uploadSpeedBps: number;
  } | null;
  peerCount: number;
  peers: SessionStatusPeer[];
}
