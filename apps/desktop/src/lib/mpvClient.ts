//! Thin wrapper around `tauri-plugin-libmpv-api` for StreamSync's playback
//! surface.
//!
//! The plugin embeds mpv into the native Tauri window *behind* the WebView2
//! surface (via mpv's `--wid`). Our React UI sits on top with a transparent
//! page background (see `body.mpv-active` in globals.css). The video is
//! positioned to line up with a placeholder `<div>` using mpv's
//! `video-margin-ratio` properties — that geometry sync is owned by
//! `MpvHost.tsx`, which calls `setMarginsFromRect`.
//!
//! mpv gives us VLC-class format coverage (MKV/HEVC/AV1/AVI/MOV/TS/WMV/FLV/…)
//! with hardware decode via `hwdec=auto-safe` (D3D11VA/DXVA2 on Windows).

import {
  init as mpvInit,
  destroy as mpvDestroy,
  command as mpvCommand,
  setProperty as mpvSetProperty,
  getProperty as mpvGetProperty,
  observeProperties,
  setVideoMarginRatio,
  type MpvConfig,
  type MpvObservableProperty,
  type VideoMarginRatio,
} from "tauri-plugin-libmpv-api";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** Properties we observe so the UI can reflect playback state. */
const OBSERVED_PROPERTIES = [
  ["pause", "flag"],
  ["time-pos", "double", "none"],
  ["duration", "double", "none"],
  ["speed", "double", "none"],
  ["eof-reached", "flag", "none"],
  ["pause-for-cache", "flag", "none"],
] as const satisfies MpvObservableProperty[];

export interface MpvState {
  paused: boolean;
  position: number; // seconds
  duration: number; // seconds
  speed: number;
}

export interface MpvTrack {
  id: number;
  type: "video" | "audio" | "sub";
  title?: string;
  lang?: string;
  selected: boolean;
}

export interface MpvClientCallbacks {
  onTimePos?: (seconds: number) => void;
  onDuration?: (seconds: number) => void;
  onPauseChange?: (paused: boolean) => void;
  onSpeedChange?: (speed: number) => void;
  onEof?: () => void;
  /** True while mpv is stalled waiting for the cache to fill (guest streaming). */
  onBuffering?: (buffering: boolean) => void;
}

/**
 * Owns one mpv instance for the lifetime of the player screen.
 *
 * Sandboxed (`config: false`) so a host machine's `~/.config/mpv/mpv.conf`
 * cannot alter our embedded player. We render our own controls, so mpv's OSC
 * and key bindings are disabled.
 */
export class MpvClient {
  private unlisten: UnlistenFn | null = null;
  private initialized = false;

  constructor(private callbacks: MpvClientCallbacks = {}) {}

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Create the mpv handle embedded in the current window and start observing. */
  async init(): Promise<void> {
    if (this.initialized) return;

    const config: MpvConfig = {
      initialOptions: {
        vo: "gpu-next",
        hwdec: "auto-safe",
        "keep-open": "yes",
        // Never fall back to an unmanaged external mpv window. The plugin
        // supplies `wid` for the Tauri window; if that cannot be embedded we
        // want an explicit playback error instead of a second application UI.
        "force-window": "no",
        idle: "yes",
        // Stream-friendly buffering: the guest plays a file librqbit is still
        // writing, so keep a generous demuxer read-ahead + cache.
        cache: "yes",
        "cache-secs": 60,
        "demuxer-readahead-secs": 30,
        // Sandbox: ignore host machine mpv config + scripts.
        config: false,
        "load-scripts": false,
        // We draw our own UI; stop mpv from grabbing input/showing the OSC.
        osc: false,
        "input-default-bindings": false,
        "input-vo-keyboard": false,
      },
      observedProperties: OBSERVED_PROPERTIES,
    };

    await mpvInit(config);

    this.unlisten = await observeProperties(OBSERVED_PROPERTIES, (event) => {
      switch (event.name) {
        case "pause":
          this.callbacks.onPauseChange?.(event.data);
          break;
        case "time-pos":
          if (event.data != null) this.callbacks.onTimePos?.(event.data);
          break;
        case "duration":
          if (event.data != null) this.callbacks.onDuration?.(event.data);
          break;
        case "speed":
          if (event.data != null) this.callbacks.onSpeedChange?.(event.data);
          break;
        case "eof-reached":
          if (event.data) this.callbacks.onEof?.();
          break;
        case "pause-for-cache":
          this.callbacks.onBuffering?.(!!event.data);
          break;
      }
    });

    this.initialized = true;
  }

  /** Load a file by absolute path. Optionally start at a position (seconds). */
  async load(path: string, startPosition?: number): Promise<void> {
    const opts =
      startPosition && startPosition > 0
        ? [`start=${Math.floor(startPosition)}`]
        : [];
    // loadfile <path> [flags] [index] [options]
    await mpvCommand("loadfile", opts.length ? [path, "replace", "0", opts.join(",")] : [path]);
  }

  async play(): Promise<void> {
    await mpvSetProperty("pause", false);
  }

  async pause(): Promise<void> {
    await mpvSetProperty("pause", true);
  }

  /** Seek to an absolute position in seconds (exact). */
  async seek(positionSeconds: number): Promise<void> {
    await mpvCommand("seek", [positionSeconds, "absolute", "exact"]);
  }

  async setSpeed(speed: number): Promise<void> {
    await mpvSetProperty("speed", speed);
  }

  async setAudioTrack(id: number): Promise<void> {
    await mpvSetProperty("aid", id);
  }

  async setSubtitleTrack(id: number | "no"): Promise<void> {
    await mpvSetProperty("sid", id);
  }

  /** One-shot playback state snapshot. */
  async getState(): Promise<MpvState> {
    const [paused, position, duration, speed] = await Promise.all([
      mpvGetProperty<boolean>("pause", "flag"),
      mpvGetProperty<number | null>("time-pos", "double"),
      mpvGetProperty<number | null>("duration", "double"),
      mpvGetProperty<number | null>("speed", "double"),
    ]);
    return {
      paused: !!paused,
      position: position ?? 0,
      duration: duration ?? 0,
      speed: speed ?? 1,
    };
  }

  /** Read mpv's `track-list` and normalize it for track-selector UI. */
  async getTracks(): Promise<MpvTrack[]> {
    const raw = await mpvGetProperty<unknown>("track-list", "node");
    if (!Array.isArray(raw)) return [];
    return raw
      .map((t): MpvTrack | null => {
        const o = t as Record<string, unknown>;
        const type = o.type as string;
        if (type !== "video" && type !== "audio" && type !== "sub") return null;
        return {
          id: Number(o.id ?? 0),
          type,
          title: typeof o.title === "string" ? o.title : undefined,
          lang: typeof o.lang === "string" ? o.lang : undefined,
          selected: !!o.selected,
        };
      })
      .filter((t): t is MpvTrack => t !== null);
  }

  /** Whether mpv reports active hardware decoding (for diagnostics UI). */
  async hwdecActive(): Promise<string | null> {
    try {
      return await mpvGetProperty<string>("hwdec-current", "string");
    } catch {
      return null;
    }
  }

  /**
   * Position the video so it fills `rect` (a placeholder div's bounding box)
   * within the window. Converts pixel geometry to mpv's edge-ratio insets.
   */
  async setMarginsFromRect(rect: DOMRect): Promise<void> {
    const winW = window.innerWidth || 1;
    const winH = window.innerHeight || 1;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const ratio: VideoMarginRatio = {
      left: clamp(rect.left / winW),
      right: clamp((winW - rect.right) / winW),
      top: clamp(rect.top / winH),
      bottom: clamp((winH - rect.bottom) / winH),
    };
    await setVideoMarginRatio(ratio);
  }

  /** Remove all margins (video fills the whole window). */
  async resetMargins(): Promise<void> {
    await setVideoMarginRatio({ left: 0, right: 0, top: 0, bottom: 0 });
  }

  /** Tear down observers and the mpv instance. */
  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    try {
      this.unlisten?.();
    } catch {
      // ignore
    }
    this.unlisten = null;
    try {
      await mpvDestroy();
    } catch (err) {
      console.warn("[MpvClient] destroy failed:", err);
    }
  }
}
