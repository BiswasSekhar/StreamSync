# StreamSync

A serverless, anonymous, peer-to-peer video streaming and watch-party app. Host your own watch party — no accounts, no cloud, no servers you don't own.

## Features

- **Serverless** — Your machine IS the server
- **Anonymous** — No accounts, no persistent IDs, ephemeral room links
- **Any video file** — MP4, MKV, HEVC/H.265, AVI, MOV, TS, WMV, FLV
- **Stream immediately** — Playback starts within 2–5 seconds, before encoding finishes
- **Hardware accelerated** — NVENC, VideoToolbox, QSV, AMF, or software fallback
- **Cross-platform** — Host on macOS/Windows/Linux, receive on any browser or iOS/Android
- **Watch together** — Synchronized playback, video calls, real-time chat

## Architecture

```
Host Machine (Tauri app)
  FFmpeg → librqbit (torrent seeder) → magnet link
  Axum WebSocket server ← cloudflared tunnel (signalling only)
  webrtc-rs (peer connections + data channels + video call)

Receivers
  Browser: webtorrent.js + MSE (zero install, just open the link)
  Mobile: React Native + WebView bridge (webtorrent.js)
```

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) 1.78+
- [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/)
- [FFmpeg](https://ffmpeg.org/download.html) in PATH
- [Tauri CLI prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites/)

### Setup

```bash
# Install JS dependencies
pnpm install

# Download cloudflared binary for your platform
node scripts/download-cloudflared.js

# Build receiver-web (served to browser receivers)
cd apps/receiver-web && pnpm build && cd ../..

# Start desktop app in dev mode
cd apps/desktop && pnpm tauri dev
```

### Building for production

```bash
cd apps/desktop && pnpm tauri build
```

The installer will be in `apps/desktop/src-tauri/target/release/bundle/`.

## How It Works

1. **Drop a video file** → FFmpeg probes it and starts encoding to fragmented MP4
2. **Create room** → cloudflared starts a free ephemeral HTTPS tunnel exposing the local signalling server
3. **Share the link** → Receivers open it in any browser (no install needed)
4. **P2P connection** → WebRTC handshake via the signalling relay
5. **Streaming begins** → Host sends magnet link over data channel; receiver downloads via WebTorrent
6. **Sync + call** → Playback synced every 2s; video calls via WebRTC media tracks

## Project Structure

```
apps/
  desktop/          Tauri desktop app (host)
    src/            React frontend
    src-tauri/      Rust backend
      engine/
        ffmpeg.rs   Hardware detection + encode pipeline
        torrent.rs  librqbit seeding
        signaller.rs Axum WebSocket server
        webrtc.rs   Peer connections + data channels
        tunnel.rs   cloudflared sidecar
  receiver-web/     Browser receiver (served by host)
  receiver-mobile/  React Native mobile receiver

packages/
  shared/           TypeScript types shared between apps

scripts/
  download-cloudflared.js  Download cloudflared binary
  dev.sh                   Start dev environment
```

## Privacy

- No accounts, no telemetry, no analytics
- Video data never touches Cloudflare (P2P only after handshake)
- Room links expire when you close the app
- DHT disabled by default (only invited peers can reach the torrent)

**Honest limitations:** WebRTC ICE candidates include your NAT-mapped IP, visible to receivers after P2P is established.

## Dependencies

| Component | Library |
|-----------|---------|
| App shell | Tauri 2.0 |
| Encode | FFmpeg (system) + ffmpeg-next bindings |
| Torrent | librqbit (pure Rust) |
| WebRTC | webrtc-rs |
| Signalling server | Axum + Tokio |
| Tunnel | cloudflared (free, no account) |
| Browser streaming | webtorrent.js + MSE |

## License

MIT
