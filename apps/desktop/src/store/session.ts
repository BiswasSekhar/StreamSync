import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

const TORRENT_PROBE_RETRY_MS = 2_000;
const TORRENT_PROBE_MAX_ATTEMPTS = 120;

let torrentProbeRetryTimer: ReturnType<typeof setTimeout> | null = null;
let torrentProbeRetryPath: string | null = null;

function clearTorrentProbeRetry(path?: string) {
  if (path && torrentProbeRetryPath !== path) return;
  if (torrentProbeRetryTimer) {
    clearTimeout(torrentProbeRetryTimer);
    torrentProbeRetryTimer = null;
  }
  if (!path || torrentProbeRetryPath === path) {
    torrentProbeRetryPath = null;
  }
}

function scheduleTorrentProbe(path: string, attemptsLeft = TORRENT_PROBE_MAX_ATTEMPTS) {
  clearTorrentProbeRetry();
  torrentProbeRetryPath = path;
  torrentProbeRetryTimer = setTimeout(() => {
    void attemptTorrentProbe(path, attemptsLeft);
  }, TORRENT_PROBE_RETRY_MS);
}

async function attemptTorrentProbe(path: string, attemptsLeft = TORRENT_PROBE_MAX_ATTEMPTS) {
  if (!isTauriRuntime()) return;

  try {
    const probe = await invoke<VideoProbeResult>("probe_file", { path });
    clearTorrentProbeRetry(path);
    const state = useSessionStore.getState();
    if (!state.isTorrentSource || state.filePath !== path) return;
    useSessionStore.setState({ probeResult: probe, filePath: path });
  } catch (error) {
    if (attemptsLeft <= 1) {
      clearTorrentProbeRetry(path);
      console.warn("[session] Torrent video probe did not succeed in time:", error);
      return;
    }

    const state = useSessionStore.getState();
    if (!state.isTorrentSource || state.filePath !== path) {
      clearTorrentProbeRetry(path);
      return;
    }

    scheduleTorrentProbe(path, attemptsLeft - 1);
  }
}

export interface EncodeProgress {
  percent: number;
  fps: number;
  etaSeconds: number;
  encoder: string;
  outputSizeBytes: number;
}

export interface SubtitleStream {
  index: number;
  language: string;
  title: string;
  codecName: string;
}

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
  /** MSE MIME codec string for MediaSource.addSourceBuffer() */
  codecHint: string;
  estimatedEncodeSeconds: number;
  fileSizeBytes: number;
  subtitleStreams: SubtitleStream[];
}

export interface Peer {
  id: string;
  displayName: string;
  videoPosition: number;
  connected: boolean;
}

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: number;
}

interface UIState {
  toastMessage: string | null;
  toastType: "info" | "success" | "error" | "warning";
}

type AppView = "home" | "session" | "join";

export interface TorrentProgressInfo {
  downloadSpeedBps: number;
  haveBytes: number;
  totalBytes: number;
  peerCount: number;
}

interface SessionStore {
  // Navigation - explicit view state (not derived from sessionId)
  view: AppView;
  showSettings: boolean;

  // File state
  filePath: string | null;
  probeResult: VideoProbeResult | null;

  // Torrent-source state (set when host uploads a .torrent file)
  isTorrentSource: boolean;
  torrentFileName: string | null;
  torrentProgress: TorrentProgressInfo | null;

  // Encode state
  encodeProgress: EncodeProgress | null;
  encodeComplete: boolean;

  // Session
  sessionId: string | null;
  roomUrl: string | null;
  magnetLink: string | null;

  // Peers
  peers: Peer[];

  // Playback
  isPlaying: boolean;
  position: number;

  // Chat
  messages: ChatMessage[];
  displayName: string;

  // Tunnel
  tunnelUrl: string | null;
  tunnelConnected: boolean;

  // Hardware
  availableEncoders: string[];
  selectedEncoder: string | null;

  // UI
  ui: UIState;

  // Actions
  setFile: (path: string) => Promise<void>;
  loadTorrent: (path: string) => Promise<void>;
  createRoom: () => Promise<string>;
  joinRoom: (url: string) => void;
  enterSession: () => void;
  leaveSession: () => void;
  play: () => void;
  pause: () => void;
  seek: (position: number) => void;
  sendChat: (text: string) => Promise<void>;
  setDisplayName: (name: string) => void;
  showToast: (msg: string, type?: UIState["toastType"]) => void;
  closeRoom: () => Promise<void>;
  detectHardware: () => Promise<void>;
  toggleSettings: () => void;
  extractSubtitle: (index: number) => Promise<string>;

  // Joiner state
  joinRoomUrl: string | null;

  // Room code is only shown after the host enters the session view
  // to avoid the race where receivers join before the host is ready
  roomCodeVisible: boolean;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  view: "home",
  showSettings: false,
  filePath: null,
  probeResult: null,
  isTorrentSource: false,
  torrentFileName: null,
  torrentProgress: null,
  encodeProgress: null,
  encodeComplete: false,
  sessionId: null,
  roomUrl: null,
  magnetLink: null,
  peers: [],
  isPlaying: false,
  position: 0,
  messages: [],
  displayName: "Host",
  tunnelUrl: null,
  tunnelConnected: false,
  availableEncoders: [],
  selectedEncoder: null,
  ui: { toastMessage: null, toastType: "info" },

  joinRoomUrl: null,
  roomCodeVisible: false,

  setFile: async (path) => {
    clearTorrentProbeRetry();
    // Route .torrent files to the dedicated loader
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "torrent") {
      await get().loadTorrent(path);
      return;
    }
    try {
      const probe = await invoke<VideoProbeResult>("probe_file", { path });
      // Direct seeding — no encode needed, mark ready immediately
      set({
        filePath: path,
        probeResult: probe,
        isTorrentSource: false,
        torrentFileName: null,
        torrentProgress: null,
        encodeComplete: true,
        encodeProgress: null,
      });
    } catch (e) {
      get().showToast(`Failed to load file: ${e}`, "error");
    }
  },

  loadTorrent: async (path) => {
    clearTorrentProbeRetry();
    try {
      await invoke("load_torrent_file", { path });
      const torrentFileName = path.split(/[\\/]/).pop() ?? "Unknown torrent";
      set({
        filePath: path,
        probeResult: null,
        isTorrentSource: true,
        torrentFileName,
        torrentProgress: null,
        encodeComplete: true,   // mark ready so Create Room is enabled
        encodeProgress: null,
      });
      get().showToast("Torrent loading — connecting to swarm...", "info");
    } catch (e) {
      get().showToast(`Failed to load torrent: ${e}`, "error");
    }
  },

  createRoom: async () => {
    const { filePath, isTorrentSource } = get();
    if (!filePath) throw new Error("No file selected");

    try {
      if (!isTorrentSource) {
        // Prepare video for DataChannel streaming (remux/transcode as needed)
        await invoke("prepare_video_for_streaming", { path: filePath });
      }
      // For torrent source, load_torrent_file already kicked off the download

      // Backend returns full tunnel URL, e.g. https://...trycloudflare.com/?room=ABCDEFGH
      const roomUrl = await invoke<string>("create_room");
      const parsed = new URL(roomUrl);
      const sessionId = (parsed.searchParams.get("room") ?? "").trim().toUpperCase();

      set({ roomUrl, sessionId, tunnelConnected: true, tunnelUrl: parsed.origin });
      get().showToast("Room created! Open the session to share the URL.", "success");
      return roomUrl;
    } catch (e) {
      get().showToast(`Failed to create room: ${e}`, "error");
      throw e;
    }
  },

  joinRoom: (url: string) => {
    set({ joinRoomUrl: url, view: "join" });
  },

  enterSession: () => {
    // Reveal the room URL only now, once the host session UI is active.
    set({ view: "session", roomCodeVisible: true });
  },

  leaveSession: () => {
    clearTorrentProbeRetry();
    const { roomUrl } = get();

    // If the host leaves, close the room so peers do not hang waiting for a host
    // that is no longer present.
    // Fire-and-forget — we don't await so navigation is instant.
    if (roomUrl) {
      invoke("close_room").catch(() => {});
    }

    set({
      view: "home",
      joinRoomUrl: null,
      roomCodeVisible: false,
      // Reset all room/session state so the next "Create Watch Party" works
      roomUrl: null,
      sessionId: null,
      peers: [],
      messages: [],
      tunnelConnected: false,
      tunnelUrl: null,
      magnetLink: null,
      // Intentionally keep filePath / probeResult / isTorrentSource so the host
      // doesn't have to re-select the same file when starting a new room.
    });
  },

  play: () => {
    set({ isPlaying: true });
  },

  pause: () => {
    set({ isPlaying: false });
  },

  seek: (position) => {
    set({ position });
  },

  sendChat: async (text) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      from: get().displayName,
      text,
      timestamp: Date.now(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));
    // Broadcast is handled via store subscription in Session.tsx (Host)
    // or sent via ws in JoinSession.tsx (Joiner)
  },

  setDisplayName: (name) => set({ displayName: name }),

  showToast: (msg, type = "info") => {
    set({ ui: { toastMessage: msg, toastType: type } });
    setTimeout(() => set({ ui: { toastMessage: null, toastType: "info" } }), 4000);
  },

  closeRoom: async () => {
    clearTorrentProbeRetry();
    try {
      await invoke("close_room");
    } catch {
      // Ignore close errors
    }
    set({
      view: "home",
      sessionId: null,
      roomUrl: null,
      magnetLink: null,
      peers: [],
      messages: [],
      encodeProgress: null,
      encodeComplete: false,
      filePath: null,
      probeResult: null,
      isTorrentSource: false,
      torrentFileName: null,
      torrentProgress: null,
      tunnelConnected: false,
      tunnelUrl: null,
    });
  },

  detectHardware: async () => {
    try {
      const encoders = await invoke<string[]>("detect_hardware");
      set({ availableEncoders: encoders, selectedEncoder: encoders[0] ?? null });
    } catch {
      // silently ignore in browser dev mode
    }
  },

  extractSubtitle: async (index: number) => {
    try {
      const { filePath } = get();
      if (!filePath) throw new Error("No file selected");
      return await invoke<string>("extract_subtitle_command", { path: filePath, streamIndex: index });
    } catch (e) {
      get().showToast(`Failed to extract subtitle: ${e}`, "error");
      throw e;
    }
  },

  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
}));

export function initEventListeners() {
  if (!isTauriRuntime()) {
    // Avoid hard failures when running the desktop frontend in a regular browser.
    return;
  }

  const on = <T>(event: string, handler: Parameters<typeof listen<T>>[1]) => {
    void listen<T>(event, handler).catch((err) => {
      console.warn(`Failed to bind Tauri event '${event}':`, err);
    });
  };

  on<EncodeProgress>("encode-progress", ({ payload }) => {
    useSessionStore.setState({ encodeProgress: payload });
  });

  on<void>("encode-complete", () => {
    useSessionStore.setState({ encodeComplete: true });
    useSessionStore.getState().showToast("Encoding complete — streaming ready", "success");
  });

  on<{ magnet: string }>("magnet-ready", ({ payload }) => {
    useSessionStore.setState({ magnetLink: payload.magnet });
  });

  on<{ peerId: string; displayName: string }>("peer-joined", ({ payload }) => {
    useSessionStore.setState((state) => ({
      peers: [
        ...state.peers,
        {
          id: payload.peerId,
          displayName: payload.displayName || "Guest",
          videoPosition: 0,
          connected: true,
        },
      ],
    }));
    useSessionStore.getState().showToast(`${payload.displayName || "A viewer"} joined`, "info");
  });

  on<{ peerId: string }>("peer-left", ({ payload }) => {
    useSessionStore.setState((state) => ({
      peers: state.peers.filter((p) => p.id !== payload.peerId),
    }));
  });

  on<ChatMessage>("chat-message", ({ payload }) => {
    useSessionStore.setState((state) => ({
      messages: [...state.messages, payload],
    }));
  });

  on<{ url: string }>("tunnel-url", ({ payload }) => {
    useSessionStore.setState({ tunnelUrl: payload.url, tunnelConnected: true });
  });

  on<void>("tunnel-disconnected", () => {
    useSessionStore.setState({ tunnelConnected: false });
    useSessionStore.getState().showToast("Tunnel disconnected, reconnecting...", "warning");
  });

  on<string>("tunnel-error", ({ payload }) => {
    useSessionStore.getState().showToast(`Tunnel error: ${payload}`, "error");
  });

  on<string>("encoder-fallback", ({ payload }) => {
    useSessionStore.getState().showToast(`Hardware encoder failed, using ${payload}`, "warning");
  });

  on<string>("encode-error", ({ payload }) => {
    useSessionStore.getState().showToast(`Encode error: ${payload}`, "error");
  });

  on<{ fileName: string; filePath: string }>("torrent-video-ready", async ({ payload }) => {
    useSessionStore.setState({ torrentFileName: payload.fileName });
    // Point the player at the discovered video immediately, then keep retrying
    // ffprobe until the partially-downloaded file becomes probeable.
    useSessionStore.setState({ filePath: payload.filePath });
    await attemptTorrentProbe(payload.filePath);
    useSessionStore.getState().showToast(`Torrent video ready: ${payload.fileName}`, "success");
  });

  on<TorrentProgressInfo>("torrent-progress", ({ payload }) => {
    useSessionStore.setState({ torrentProgress: payload });
  });
}
