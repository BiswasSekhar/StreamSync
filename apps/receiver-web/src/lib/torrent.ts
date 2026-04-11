// WebTorrent is loaded via CDN <script> tag in index.html
// Access it as window.WebTorrent (browser-native build)

declare const WebTorrent: any;

let client: any = null;

export async function startStreaming(
  magnet: string,
  videoElement: HTMLVideoElement,
  onProgress: (progress: number, speed: number) => void
): Promise<void> {
  if (client) {
    client.destroy();
  }

  // WebTorrent is available globally via CDN script
  if (typeof WebTorrent === "undefined") {
    throw new Error("WebTorrent CDN script not loaded");
  }

  client = new WebTorrent();

  return new Promise((resolve, reject) => {
    client.add(magnet, {}, (torrent: any) => {
      // Find largest file (the video)
      const file = torrent.files.reduce((a: any, b: any) =>
        a.length > b.length ? a : b
      );

      // renderTo feeds pieces directly into MediaSource API
      file.renderTo(
        videoElement,
        { autoplay: false },
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        }
      );

      torrent.on("download", () => {
        onProgress(torrent.progress, torrent.downloadSpeed);
      });

      // Prioritize pieces near current playback position on seek
      videoElement.addEventListener("seeking", () => {
        if (torrent.pieces && torrent.length > 0 && videoElement.duration) {
          const fraction = videoElement.currentTime / videoElement.duration;
          const seekPiece = Math.floor(fraction * torrent.pieces.length);
          const end = Math.min(seekPiece + 20, torrent.pieces.length - 1);
          torrent.critical(seekPiece, end);
        }
      });
    });

    client.on("error", (err: Error) => {
      reject(err);
    });
  });
}

export function cleanup() {
  if (client) {
    client.destroy();
    client = null;
  }
}
