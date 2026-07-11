//! JS bridge to the libp2p signaling layer (Rust `commands/p2p.rs`).
//!
//! Mirrors the callback shape of the old `JoinWebRTC` so the UI can swap
//! its signaling backend with a minimal diff. The Rust supervisor owns the
//! swarm; this class is a thin event pump:
//!
//!   - `invoke('p2p_start_session', ...)` builds the swarm + joins the topic.
//!   - `listen('p2p-gossip', ...)` delivers every decrypted envelope.
//!   - `publishEvent(kind, payload, target?)` maps to `p2p_publish_event`.
//!
//! All payloads are encrypted end-to-end by the Rust `SessionCipher`; this
//! layer never sees the share-code key.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Kinds of gossip events. Must match the Rust `GossipKind` (kebab-case serde). */
export type GossipKind =
  | "presence"
  | "sync"
  | "chat"
  | "video-ready"
  | "magnet-ready"
  | "join-request"
  | "join-decision"
  | "host-ended"
  | "webrtc-offer"
  | "webrtc-answer"
  | "webrtc-ice";

/** Decrypted envelope as emitted by the Rust supervisor on `p2p-gossip`. */
export interface GossipEnvelope<P = unknown> {
  kind: GossipKind;
  /** libp2p PeerId of the publisher (already cross-checked against the signed source). */
  senderPeerId: string;
  /** Present only for directed messages (e.g. webrtc-offer). */
  targetPeerId?: string;
  id: string;
  timestampMs: number;
  payload: P;
}

export interface StartSessionResponse {
  peerId: string;
  gossipTopicHex: string;
  role: "host" | "guest";
}

export type NatStatus = "unknown" | "public" | "private";

export interface DiagnosticsSnapshot {
  localPeerId: string;
  listenAddrs: string[];
  externalAddrs: string[];
  kadPeers: number;
  gossipNeighbors: number;
  joinedPeers: number;
  natStatus: NatStatus;
}

export interface PublishFileResult {
  infoHash: string;
  magnet: string;
  fileName: string;
  fileSize: number;
  durationSeconds: number;
  mimeCodec: string;
  /** Host plays this path directly. */
  localPath: string;
}

export interface OpenMagnetResult {
  infoHash: string;
  magnet: string;
  fileName: string;
  fileSize: number;
  selectedFileId: number;
  videoFiles: Array<{ fileId: number; fileName: string; fileSize: number }>;
  /** librqbit localhost stream URL — what mpv opens. */
  streamUrl: string;
}

export interface LocalPathResult {
  infoHash: string;
  fileName: string;
  streamUrl: string;
}

export interface P2pClientCallbacks {
  /** Any decrypted gossip envelope addressed to us (or broadcast). */
  onGossip?: (env: GossipEnvelope) => void;
  /** A swarm connection was established with a peer. */
  onPeerJoined?: (peerId: string) => void;
  /** All connections to a peer dropped. */
  onPeerLeft?: (peerId: string) => void;
  /** Periodic (30s) diagnostics snapshot from the supervisor. */
  onDiagnostics?: (snap: DiagnosticsSnapshot) => void;
  /** Reachability changed (autonat). */
  onNatStatus?: (status: NatStatus) => void;
}

/**
 * Owns one libp2p session for the app's lifetime within a room.
 *
 * Usage:
 * ```ts
 * const p2p = new P2pClient({ onGossip: handleEvent });
 * await p2p.start(shareCode, isHost);
 * await p2p.publishEvent("chat", { text: "hi" });
 * // ...
 * await p2p.close();
 * ```
 */
export class P2pClient {
  private unlisteners: UnlistenFn[] = [];
  private started = false;
  private session: StartSessionResponse | null = null;

  constructor(private callbacks: P2pClientCallbacks = {}) {}

  get localPeerId(): string | null {
    return this.session?.peerId ?? null;
  }

  get role(): "host" | "guest" | null {
    return this.session?.role ?? null;
  }

  /**
   * Build the swarm, join the gossip topic, and wire up event listeners.
   * Listeners are registered *before* the backend session starts so we never
   * miss an early `p2p-peer-joined` or presence frame.
   */
  async start(shareCode: string, isHost: boolean): Promise<StartSessionResponse> {
    if (this.started) {
      throw new Error("P2pClient already started — call close() first");
    }
    this.started = true;

    await this.attachListeners();

    try {
      this.session = await invoke<StartSessionResponse>("p2p_start_session", {
        shareCode,
        isHost,
      });
    } catch (err) {
      // Roll back listeners if the backend failed to start.
      await this.detachListeners();
      this.started = false;
      throw err;
    }

    return this.session;
  }

  /**
   * Encrypt + broadcast an event over gossipsub. If `target` is set the
   * envelope is directed (used for webrtc-offer/answer/ice) and dropped by
   * every peer except the addressed one.
   *
   * Returns the envelope id, useful for local dedup / ack tracking.
   */
  async publishEvent(
    kind: GossipKind,
    payload: unknown,
    target?: string,
  ): Promise<string> {
    if (!this.started) {
      throw new Error("P2pClient not started");
    }
    const res = await invoke<{ envelopeId: string }>("p2p_publish_event", {
      args: { kind, payload, target: target ?? null },
    });
    return res.envelopeId;
  }

  /** One-shot diagnostics snapshot (also delivered periodically via onDiagnostics). */
  async getStats(): Promise<DiagnosticsSnapshot> {
    return invoke<DiagnosticsSnapshot>("p2p_get_stats");
  }

  // ─── Content layer (BitTorrent) ──────────────────────────────────────────

  /**
   * Host only. Seed the original file as-is (no transcode), and broadcast a
   * `video-ready` gossip event so guests can join. The host plays back from
   * `localPath` directly (instant + fully seekable); guests use the magnet.
   */
  async publishFile(filePath: string): Promise<PublishFileResult> {
    return invoke<PublishFileResult>("p2p_publish_file", { filePath });
  }

  /**
   * Load a magnet into the shared session and return librqbit's localhost
   * stream URL for mpv. Pass `broadcast: true` to re-announce `magnet-ready`
   * so co-watchers converge on the same swarm (host's private magnet); pass
   * `false` for a guest joining an already-announced magnet.
   */
  async openMagnet(magnet: string, broadcast: boolean): Promise<OpenMagnetResult> {
    return invoke<OpenMagnetResult>("p2p_open_magnet", { magnet, broadcast });
  }

  /** The active torrent's localhost stream URL (what mpv opens for guests). */
  async torrentLocalPath(): Promise<LocalPathResult> {
    return invoke<LocalPathResult>("p2p_torrent_local_path");
  }

  /** Leave the gossip topic, drop the swarm, and detach all listeners. */
  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.detachListeners();
    this.session = null;
    try {
      await invoke("p2p_close_session");
    } catch (err) {
      console.warn("[P2pClient] close_session failed:", err);
    }
  }

  private async attachListeners(): Promise<void> {
    const { callbacks } = this;

    this.unlisteners.push(
      await listen<GossipEnvelope>("p2p-gossip", (e) => {
        callbacks.onGossip?.(e.payload);
      }),
    );
    this.unlisteners.push(
      await listen<string>("p2p-peer-joined", (e) => {
        callbacks.onPeerJoined?.(e.payload);
      }),
    );
    this.unlisteners.push(
      await listen<string>("p2p-peer-left", (e) => {
        callbacks.onPeerLeft?.(e.payload);
      }),
    );
    this.unlisteners.push(
      await listen<DiagnosticsSnapshot>("p2p-diagnostics", (e) => {
        callbacks.onDiagnostics?.(e.payload);
      }),
    );
    this.unlisteners.push(
      await listen<{ status: NatStatus }>("p2p-nat-status", (e) => {
        callbacks.onNatStatus?.(e.payload.status);
      }),
    );
  }

  private async detachListeners(): Promise<void> {
    const fns = this.unlisteners;
    this.unlisteners = [];
    for (const unlisten of fns) {
      try {
        unlisten();
      } catch {
        // ignore — listener may already be torn down
      }
    }
  }
}
