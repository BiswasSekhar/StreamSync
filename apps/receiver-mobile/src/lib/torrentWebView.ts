import React, { useRef, useState } from "react";
import { WebView } from "react-native-webview";

const WEBTORRENT_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>body { margin: 0; background: black; }</style>
</head>
<body>
<script src="https://cdn.jsdelivr.net/npm/webtorrent@2/webtorrent.min.js"><\/script>
<script>
const client = new WebTorrent();
let currentTorrent = null;

window.addEventListener('message', (e) => {
  let msg;
  try { msg = JSON.parse(e.data); } catch(err) { return; }

  if (msg.type === 'add' && msg.magnet) {
    if (currentTorrent) {
      currentTorrent.destroy();
      currentTorrent = null;
    }

    client.add(msg.magnet, {}, (torrent) => {
      currentTorrent = torrent;

      // Find largest file (video)
      const file = torrent.files.reduce((a, b) => a.length > b.length ? a : b);

      // Create server for native video player
      torrent.on('ready', () => {
        const serverUrl = torrent.streamURL || null;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'ready',
          name: file.name,
        }));
      });

      torrent.on('download', () => {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'progress',
          progress: torrent.progress,
          downloadSpeed: torrent.downloadSpeed,
          numPeers: torrent.numPeers,
        }));
      });

      torrent.on('error', (err) => {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'error',
          message: err.message || String(err),
        }));
      });

      // For streaming: get blob URL when enough data is available
      // Check every second if enough is buffered
      const checkBuffer = setInterval(() => {
        if (file.downloaded >= file.length * 0.02 || file.downloaded > 1024 * 1024) {
          clearInterval(checkBuffer);
          file.getBlobURL((err, url) => {
            if (!err && url) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'stream-url',
                url: url,
              }));
            }
          });
        }
      }, 500);
    });
  }

  if (msg.type === 'destroy') {
    client.destroy();
  }
});

window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'loaded' }));
<\/script>
</body>
</html>
`;

export function useTorrentWebView() {
  const webViewRef = useRef<WebView>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [torrentProgress, setTorrentProgress] = useState(0);
  const [numPeers, setNumPeers] = useState(0);

  const addMagnet = (magnet: string) => {
    webViewRef.current?.postMessage(
      JSON.stringify({ type: "add", magnet })
    );
  };

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "stream-url") {
        setStreamUrl(msg.url);
      } else if (msg.type === "progress") {
        setTorrentProgress(msg.progress);
        setNumPeers(msg.numPeers || 0);
      } else if (msg.type === "error") {
        console.error("Torrent error:", msg.message);
      }
    } catch (e) {
      console.error("WebView message parse error:", e);
    }
  };

  const TorrentWebView = React.createElement(WebView, {
    ref: webViewRef,
    source: { html: WEBTORRENT_HTML },
    onMessage: onMessage,
    style: { width: 0, height: 0, position: "absolute" } as any,
    javaScriptEnabled: true,
    originWhitelist: ["*"],
    mediaPlaybackRequiresUserAction: false,
  });

  return {
    webViewRef,
    addMagnet,
    streamUrl,
    torrentProgress,
    numPeers,
    TorrentWebView,
  };
}
