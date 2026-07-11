import { useEffect, useRef } from "react";
import { MpvClient, type MpvClientCallbacks } from "../lib/mpvClient";

interface Props extends MpvClientCallbacks {
  /** Called once the mpv instance is initialized and ready for load/play. */
  onReady?: (client: MpvClient) => void;
}

/**
 * Transparent placeholder that the embedded mpv video is aligned to.
 *
 * mpv renders into the native window behind the WebView2 surface; this div is
 * a see-through "hole" in the UI. We keep the video lined up with the hole by
 * translating the div's bounding box into mpv `video-margin-ratio` insets on
 * mount and on every resize/scroll.
 *
 * The `body.mpv-active` class makes the page background transparent only while
 * this component is mounted, so other screens keep their opaque shell.
 */
export function MpvHost({ onReady, ...callbacks }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<MpvClient | null>(null);
  // Keep latest callbacks without re-running the init effect.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let disposed = false;
    document.body.classList.add("mpv-active");

    const client = new MpvClient({
      onTimePos: (s) => callbacksRef.current.onTimePos?.(s),
      onDuration: (s) => callbacksRef.current.onDuration?.(s),
      onPauseChange: (p) => callbacksRef.current.onPauseChange?.(p),
      onSpeedChange: (s) => callbacksRef.current.onSpeedChange?.(s),
      onEof: () => callbacksRef.current.onEof?.(),
      onBuffering: (b) => callbacksRef.current.onBuffering?.(b),
    });
    clientRef.current = client;

    const syncMargins = () => {
      const el = hostRef.current;
      if (!el || !client.isInitialized) return;
      void client.setMarginsFromRect(el.getBoundingClientRect());
    };

    (async () => {
      try {
        await client.init();
        if (disposed) {
          await client.destroy();
          return;
        }
        syncMargins();
        onReadyRef.current?.(client);
      } catch (err) {
        console.error("[MpvHost] mpv init failed:", err);
      }
    })();

    const resizeObserver = new ResizeObserver(syncMargins);
    if (hostRef.current) resizeObserver.observe(hostRef.current);
    window.addEventListener("resize", syncMargins);
    window.addEventListener("scroll", syncMargins, true);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncMargins);
      window.removeEventListener("scroll", syncMargins, true);
      document.body.classList.remove("mpv-active");
      void clientRef.current?.destroy();
      clientRef.current = null;
    };
  }, []);

  // Transparent so the mpv layer behind the webview shows through here.
  return <div ref={hostRef} style={{ width: "100%", height: "100%", background: "transparent" }} />;
}
