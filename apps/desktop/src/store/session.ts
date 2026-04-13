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

  setFile: async (path) => {
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
        // Start seeding the original video file via librqbit
        await invoke("start_seeding_original", { path: filePath });
      }
      // For torrent source, load_torrent_file already kicked off the download+seed

      // Create room in backend to get the short code
      const code = await invoke<string>("create_room");

      set({ roomUrl: code, sessionId: code, tunnelConnected: true });
      get().showToast("Room created! Share the code to invite viewers.", "success");
      return code;
    } catch (e) {
      get().showToast(`Failed to create room: ${e}`, "error");
      throw e;
    }
  },

  joinRoom: (url: string) => {
    set({ joinRoomUrl: url, view: "join" });
  },

  enterSession: () => {
    set({ view: "session" });
  },

  leaveSession: () => {
    const { roomUrl } = get();

    // If the HOST is leaving (not the joiner), stop the cloudflared tunnel so
    // the old room is dead and peers don't hang waiting for a host that's gone.
    // Fire-and-forget — we don't await so navigation is instant.
    if (roomUrl) {
      invoke("close_room").catch(() => {});
    }

    set({
      view: "home",
      joinRoomUrl: null,
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
    invoke("send_host_sync", { position: get().position, playing: true }).catch(console.error);
  },

  pause: () => {
    set({ isPlaying: false });
    invoke("send_host_sync", { position: get().position, playing: false }).catch(console.error);
  },

  seek: (position) => {
    set({ position });
    invoke("send_host_sync", { position, playing: get().isPlaying }).catch(console.error);
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

  on<{ fileName: string; filePath: string }>("torrent-video-ready", ({ payload }) => {
    useSessionStore.setState({ torrentFileName: payload.fileName });
    useSessionStore.getState().showToast(`Torrent video ready: ${payload.fileName}`, "success");
  });

  on<TorrentProgressInfo>("torrent-progress", ({ payload }) => {
    useSessionStore.setState({ torrentProgress: payload });
  });
}
