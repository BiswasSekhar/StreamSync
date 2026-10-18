# StreamSync stack analysis: `main` vs `codex/public-torrent-testing`

Date: 2026-08-15  
Compared: `main` (baseline) → current branch `codex/public-torrent-testing`  
Delta: 2 commits, **+4756 / −337** across **48 files**

- `5014854` feat: add decentralized public torrent streaming  
- `7cd3afd` fix: connect peers through websocket trackers  

This document is a full-stack map of what the repo is, how the two branches differ, and which planes are live versus scaffolded. It supersedes the April 2026 audit in `docs/STREAMSYNC_ARCHITECTURE_AUDIT_AND_WORKPLAN.md` for runtime facts on the current branch. The README still describes an older “cloudflared-first + webrtc-rs” picture; the code does not match that README.

---

## 1. Product in one paragraph

StreamSync is a **serverless watch-party**: a desktop host (Tauri) shares a local video or a public torrent; receivers join from another desktop, a browser, or (partially) mobile. There is no StreamSync cloud. Discovery and admission ride public WebTorrent WebSocket trackers or an optional Cloudflare tunnel. Video bytes ride BitTorrent (librqbit / WebTorrent) with a WebRTC DataChannel range fallback. Chat, sync, and facecam are WebRTC in the **JavaScript** layer, not Rust `webrtc-rs`.

---

## 2. Monorepo layout (unchanged between branches)

| Path | Role |
|------|------|
| `apps/desktop` | Host + native join: React/Vite UI + Rust/Tauri backend |
| `apps/receiver-web` | Zero-install browser receiver, served by the host Axum server |
| `apps/receiver-mobile` | React Native receiver (protocol lag vs desktop/web) |
| `packages/shared` | TypeScript contracts (signalling, control, limits, crypto) |
| `scripts/` | `download-cloudflared.js`, `dev.sh` |
| `docs/` | Architecture notes |

**Build:** pnpm 9 workspace + Turbo 1.13. Root scripts: `dev`, `build`, `dev:desktop`, `build:desktop`, `dev:web-receiver`.  
**App versions:** desktop JS `1.0.1`, Tauri crate `1.0.2`, receivers `1.0.0`.

```
Host (Tauri)
  React UI  ←IPC→  Rust engine (FFmpeg, librqbit, Axum, optional libp2p, mpv plugin)
       │
       ├── signalling: WSS trackers  OR  local Axum /ws + cloudflared
       ├── content:    BitTorrent swarm (librqbit)
       └── A/V call:   browser WebRTC (STUN only, no TURN)

Receivers
  Desktop: same Tauri app (join) + mpv on current branch
  Browser: Vite React + webtorrent.js + MSE
  Mobile:  RN WebRTC + WebView WebTorrent
```

---

## 3. Complete technology stack

### 3.1 Workspace / language

| Layer | Choice |
|-------|--------|
| Package manager | pnpm 9.0.0 |
| JS orchestration | turbo ^1.13 |
| Languages | TypeScript 5.4 (apps), TypeScript 5.0.4 (mobile), Rust 2021 / rustc 1.78+ |
| License | MIT |

### 3.2 Desktop host — frontend

| Piece | Version / library | Notes |
|-------|-------------------|--------|
| Shell | Tauri 2 | `com.streamsync.app`, window 1280×800, transparent decorations |
| UI | React 18.3, Vite 5.2, Tailwind 3.4 | Pages: Home, Session, JoinSession, Settings |
| State | Zustand 4.5 | `apps/desktop/src/store/session.ts` |
| IPC | `@tauri-apps/api` + plugins dialog/fs/shell | |
| QR | `qrcode` | Room / share-code display |
| WebRTC | **browser `RTCPeerConnection`** | `hostWebrtc.ts`, `joinWebrtc.ts` |
| Tracker mesh | custom WS client | `trackerSignalling.ts` — WebTorrent announce protocol |
| **Current only** | `tauri-plugin-libmpv-api` 0.3.2 | Embedded mpv player |
| **Current only** | `p2pClient.ts` | JS facade over Rust libp2p commands |

### 3.3 Desktop host — Rust backend (`apps/desktop/src-tauri`)

| Piece | Crate | Role |
|-------|--------|------|
| App | `tauri` 2 (`protocol-asset`) | Window, IPC, resource dir |
| Plugins | shell, fs, dialog | File pick, spawn cloudflared |
| Async | tokio (full), futures, tokio-util | |
| HTTP / WS | axum 0.7, tower, tower-http (cors, fs, trace) | Signalling + optional static receiver dist |
| Torrent | **librqbit 8** | Seed local file, open magnet/.torrent |
| HTTP client | reqwest 0.12 (rustls) | Tunnel URL scrape; current: loopback range reads |
| Tracker WS | tokio-tungstenite 0.24 | Native tracker announce helper |
| Encode | system **FFmpeg / ffprobe** (bundled resources) | Probe, remux, HW transcode |
| Tunnel | **cloudflared** sidecar | Compatibility-mode public HTTPS |
| Logging | tracing + tracing-subscriber | |
| Declared but **unused in source** | `webrtc` 0.12 | README claims webrtc-rs; no `use webrtc` in the repo |

**Current-branch additions**

| Piece | Crate / module | Role |
|-------|----------------|------|
| P2P signalling | **libp2p 0.54** | gossipsub, kad, identify, mdns, autonat, relay, dcutr, ping, quic, tcp, noise, yamux, ed25519 |
| Crypto | sha1, sha2, hkdf, aes-gcm, rand | Share-code derivation + session cipher |
| Playback | **tauri-plugin-libmpv** 0.3 | Native decode of MKV/HEVC/AV1/… |
| librqbit extra | `http-api`, `tracing-subscriber-utils` | Loopback Range stream for mpv |

macOS extras (both branches): `cocoa`, `objc`.

### 3.4 Shared TypeScript package (`@streamsync/shared`)

**On `main`:** `types`, `utils`, `limits`, `signalling`, `control`, `commands`, `events`.

**Added on current:** `shareCode`, `crypto` (AES-256-GCM SessionCipher), `iceServers` (expanded STUN pool), `relay` (host-relay binary framing).

Limits change: **6 peers → 12** (1 host + 11 viewers). New constants: `MAX_CONFERENCE_SENDERS = 10`, `MAX_RELAYED_PEERS = 2`, ICE probe / tracker grace timers. `relay.ts` exists; **no `relayMesh.ts` / `guestMesh.ts` implementation** in the apps.

### 3.5 Browser receiver (`apps/receiver-web`)

| Piece | Detail |
|-------|--------|
| React 18.3 + Vite 5.2 + Tailwind | Port 5174 in dev |
| webtorrent ^2.4 | Magnet-first; 30s timeout then DataChannel MSE |
| MSE | 128 KB chunks, 4 in-flight |
| Signalling | `ws(s)://{host}/ws` — **tunnel / served-by-host path only** |
| Unused dep | `nostr-tools` is in `package.json`, **no imports** |

This app is not wired to tracker-mode share codes or libp2p. Browser join still assumes the host serves the SPA behind the same origin as `/ws` (cloudflared compatibility mode).

### 3.6 Mobile receiver (`apps/receiver-mobile`)

| Piece | Version |
|-------|---------|
| React Native | 0.74 |
| Navigation | native-stack 6 |
| WebRTC | react-native-webrtc 118 |
| Playback | react-native-video 6 |
| Torrent | react-native-webview + embedded WebTorrent |
| Current | imports `EXPANDED_STUN_POOL` from shared |

Protocol still diverges: join is direct WS to a **room URL**, not tracker share-code; it handles `offer` / ICE, not the desktop `join-request` admission sequence.

### 3.7 External infrastructure (not operated by StreamSync)

| Service | Used for |
|---------|----------|
| WebTorrent WSS trackers (`tracker.files.fm`, `openwebtorrent.com`, `webtorrent.dev`) | Serverless signalling (default mode) |
| UDP/HTTP BitTorrent trackers (OpenTrackr, etc.) | Swarm discovery for content |
| Cloudflare `trycloudflare` via local `cloudflared` | Optional tunnel signalling + hosting receiver-web |
| Public STUN (Google, Cloudflare, …) | ICE; **no TURN** |
| IPFS libp2p bootstrap (`bootstrap.libp2p.io`) | **Current only** — Kademlia anchors for the new swarm |

---

## 4. Runtime planes (how a session actually works)

There are four independent planes. Mixing them up is the main source of README / audit drift.

### Plane A — Admission / signalling (who is in the room)

**`main` and current (live path):**

1. Host `create_room(mode?)` — default **`tracker`**.
2. Tracker mode: random 20-byte info-hash, share code = hex of that hash, `room_url = tracker://{infoHash}`. Frontend `TrackerSignallingMesh` announces to WSS trackers and piggybacks StreamSync JSON on the WebTorrent offer/answer channel.
3. Tunnel mode: UUID session id, spawn cloudflared to local **8787**, return `https://…trycloudflare.com/?room=ID`. Axum `/ws` relays join/offer/ICE/chat/sync.

Axum still starts on **0.0.0.0:8787** at app boot (both branches) and can static-serve `receiver-web/dist`.

**Current extra (scaffolded):** libp2p gossipsub topic derived from a Crockford-Base32 share code (`ABCD-EFGH-JKLM-NPQR`). Commands: `p2p_start_session`, `p2p_publish_event`, `p2p_get_stats`, `p2p_close_session`. Host PeerId is deterministic from the share code; guests are ephemeral. This is a **second** signalling stack, not a replacement of the tracker/tunnel path in the Home UI.

### Plane B — Content (the movie file)

| Path | `main` | Current |
|------|--------|---------|
| Local file | FFmpeg probe → remux/transcode → librqbit seed | Same, plus `p2p_publish_file` / `TorrentStreamManager` |
| `.torrent` / magnet | `load_torrent_file` / `load_magnet_link` | Same + `p2p_open_magnet` / `p2p_open_torrent_file` |
| Host playback | HTML `<video>` via `/host-video` | **mpv** on file path or librqbit loopback URL |
| Guest native | `load_magnet_link` + `/host-video` | mpv on `127.0.0.1:{ephemeral}/torrents/…/stream/…` |
| Browser | WebTorrent, else DataChannel ranges | Same fallback; ranges now filled by `read_video_chunk` on the host |

librqbit on current enables **`http-api`** bound to **loopback only**. That HTTP port is process-local IPC for mpv, not a public server.

Public magnets are treated as **public**: info-hash, file names, peer IPs, and bytes are visible to the swarm. Watch-party secrets must not be written into torrent metadata (`docs/PUBLIC_TORRENT_ARCHITECTURE.md`).

### Plane C — Compatibility media (DataChannel ranges)

**`main`:** receiver asks `WEBRTC_CHUNK_REQUEST`; host `fetch`es `http://localhost:8787/host-video` with `Range`. That works for the host process and for tunnel guests who never needed localhost; it **breaks tracker-mode remote guests** if anyone assumed they could hit the host’s 8787.

**Current:** `/host-video` **removed**. Host `hostWebrtc.ts` calls Tauri `read_video_chunk` / `get_video_size` and pushes bytes on `mediaDc` (optional 8-byte `SSCH` envelope). For public torrents, `read_video_chunk` Range-GETs the same loopback librqbit URL. Browser guests still consume host upload; native guests join the public swarm.

### Plane D — Sync, chat, facecam

Implemented in TS WebRTC data channels + media tracks (`hostWebrtc.ts` / `joinWebrtc.ts` / receiver `webrtc.ts`). Sync messages: `sync`, `control` play/pause/seek, `heartbeat`. Facecam is a full mesh of `RTCPeerConnection`s, STUN-only. Host-relay mesh types exist in shared; **not wired**.

---

## 5. Tauri command surface

### `main`

`probe_file`, `detect_hardware`, `extract_subtitle_command`, `prepare_video_for_streaming`, `start_seeding_original`, `load_torrent_file`, `create_room`, `close_room`, `get_session_status`, `get_magnet`, `load_magnet_link`, `get_torrent_stats`

### Current additions

| Command | Purpose |
|---------|---------|
| `read_video_chunk`, `get_video_size` | Range read via IPC (replaces `/host-video`) |
| `p2p_start_session` / `p2p_close_session` / `p2p_publish_event` / `p2p_get_stats` | libp2p signalling actor |
| `p2p_publish_file` | Seed local file through `TorrentStreamManager` |
| `p2p_open_magnet` / `p2p_open_torrent_file` | Join public/private torrent, return loopback stream URL |
| `p2p_get_active_torrent_stats` / `p2p_select_torrent_video` / `p2p_torrent_local_path` | Multi-file torrents + stats |

`packages/shared/src/commands.ts` **does not yet list** the p2p / chunk commands (frontend still `invoke`s string names).

### Events (both)

Emitted: `encode-progress`, `encode-complete`, `encoder-fallback`, `encode-error`, `magnet-ready`, `torrent-video-ready`, `torrent-progress`.

Current extra: `p2p-gossip` (decrypted libp2p envelopes).

Peer/chat still flow on signalling + data channels, not the Tauri event bus.

---

## 6. Branch comparison (what actually changed)

### 6.1 Architecture intent

| | `main` | `codex/public-torrent-testing` |
|--|--------|--------------------------------|
| Default discovery | WebTorrent WSS trackers | Same (plus libp2p stack ready) |
| Fallback discovery | cloudflared + Axum `/ws` | Same |
| Host media HTTP | `/host-video` on 8787 | **Gone**; Tauri IPC + loopback librqbit |
| Native player | HTML5 video | **mpv** (WID embed under WebView) |
| Public torrent | Load magnet/.torrent into same seeder | Dedicated stream manager, file picker, stats overlay |
| Share code | 40-char hex info-hash | Hex still used by tracker `create_room`; **new** 16-char Crockford code for libp2p/crypto |
| E2E crypto | None on DataChannels | SessionCipher (TS + Rust) for libp2p gossip / designed for DCs |
| Room size | 6 | 12 (admission), conference senders 10 |

### 6.2 New Rust modules

- `engine/share_code.rs` — generate/parse Crockford code; derive info-hash, HKDF session key, gossip topic, libp2p seed  
- `engine/session_cipher.rs` — AES-256-GCM envelopes  
- `engine/libp2p_node.rs` — Swarm + behaviours + IPFS bootstrap  
- `engine/libp2p_gossip.rs` — typed gossip kinds (presence, sync, chat, video-ready, webrtc-*, …)  
- `engine/libp2p_supervisor.rs` — single-task actor (`!Send` swarm)  
- `engine/torrent_stream.rs` — shared librqbit session + loopback HTTP API  
- `commands/p2p.rs`, `commands/media_chunk.rs`

Signaller comment on current: signalling-only; **no localhost media HTTP**.

### 6.3 New / changed frontend

- `MpvHost.tsx` / `MpvOverlay.tsx` / `mpvClient.ts` — geometry-synced native player  
- `p2pClient.ts` — event pump for `p2p-gossip`  
- Home: torrent file list, magnet input, signalling mode, share code  
- Join/Session: mpv + public-swarm stats  
- `trackerSignalling.ts`: binary-string info-hash (WebTorrent-correct) — the `7cd3afd` fix  
- CSP / connect-src widened for `wss`/`https`/`http` loopback (mpv + trackers)

### 6.4 What did **not** change

- Receiver-web still tunnel-origin `/ws` + WebTorrent/MSE  
- Mobile still URL-based WS join (small STUN import only)  
- FFmpeg encode pipeline, cloudflared tunnel helper  
- No accounts, no StreamSync backend  
- `webrtc` crate still unused  

---

## 7. End-to-end scenarios

### 7.1 Host a local file (`main`)

Drop video → `probe_file` → `prepare_video_for_streaming` (remux/transcode) → `start_seeding_original` → `create_room` (tracker or tunnel) → host `<video src=/host-video>` → guests WebTorrent or DataChannel MSE.

### 7.2 Host a local file (current)

Same encode/seed path for tracker/tunnel rooms. Native UI prefers **mpv** on the file. DataChannel fallback uses `read_video_chunk`. Optional `p2p_publish_file` seeds via `TorrentStreamManager` for the libp2p/public-swarm path.

### 7.3 Public magnet / `.torrent` (current milestone)

`p2p_open_torrent_file` or `p2p_open_magnet` → one `TorrentStreamManager` → mpv opens Range-aware loopback URL → `video-ready` carries magnet + `torrentFileId` → native receivers `p2p_open_magnet` and re-seed → browsers try WebTorrent, else host DataChannel bridge.

### 7.4 Desktop join

Tracker: paste share/info-hash → `TrackerSignallingMesh` → join-request → WebRTC.  
Tunnel: paste trycloudflare URL → `ws` on that host.  
Current: if magnet present, mpv + librqbit instead of MSE.

### 7.5 Browser / mobile

Unchanged in spirit: browser needs the **hosted receiver origin** (tunnel). Mobile expects a room URL and a simpler offer path — **not** tracker-mode or libp2p.

---

## 8. Security and privacy (as implemented)

| Claim | Reality |
|-------|---------|
| No StreamSync accounts / telemetry | True in code |
| Video never hits Cloudflare | True for tracker mode and BitTorrent; tunnel mode only carries signalling (+ static SPA), not movie bytes, except DataChannel fallback still host-originated |
| DHT | Private seeds: README says DHT off by default historically; current public-torrent path **uses** Mainline DHT / public trackers by design |
| ICE | STUN reveals NAT-mapped IPs to session peers |
| Share code | Possession = find swarm + decrypt (BitTorrent threat model). 80-bit Crockford code is the secret |
| Public torrents | Info-hash, names, IPs, pieces are public — documented boundary |
| CSP | Relaxed (`unsafe-eval`, broad `connect-src`) to allow trackers, mpv loopback, WASM/WebTorrent |

---

## 9. Gaps and dual-stack debt

1. **Two share-code formats:** tracker rooms still use 40-char hex from `tracker_signal::generate_info_hash_hex`; libp2p uses 16-char Crockford + HKDF. Join UX must not treat them as interchangeable.  
2. **Two torrent engines:** `engine/torrent.rs` (legacy session) and `engine/torrent_stream.rs` (shared manager). Both can be live.  
3. **libp2p vs tracker signalling:** Home still creates tracker/tunnel rooms; `p2p_start_session` is a parallel API.  
4. **Host-relay / SessionCipher on DataChannels:** types and limits exist; mesh files are missing; live WebRTC DCs are still plaintext.  
5. **README / webrtc crate:** document webrtc-rs and `/host-video`; crate unused; `/host-video` removed on this branch.  
6. **receiver-web / mobile** not on tracker or public-swarm native path.  
7. **`nostr-tools`** unused.  
8. **Shared `TAURI_COMMANDS`** stale vs `lib.rs`.  
9. **Signaller `MAX_PEERS_PER_ROOM = 6`** in Rust vs shared TS `12` — admission caps can disagree.  
10. Public-mode follow-ups (from `PUBLIC_TORRENT_ARCHITECTURE.md`): cancel/cache controls, host-upload measurement, WebRTC BitTorrent bridge so browsers redistribute.

---

## 10. Dependency inventory (authoritative)

### Root

- `turbo` ^1.13.0  
- packageManager `pnpm@9.0.0`

### `apps/desktop` (JS)

- `@streamsync/shared` workspace  
- `@tauri-apps/api` ^2, plugins dialog/fs/shell ^2  
- react / react-dom ^18.3, zustand ^4.5, clsx, qrcode  
- **current:** `tauri-plugin-libmpv-api` ^0.3.2  
- Vite 5.2, TypeScript 5.4, Tailwind 3.4, `@tauri-apps/cli` ^2

### `apps/desktop/src-tauri` (Rust) — current `Cargo.toml`

tauri 2, tauri-plugin-{shell,fs,dialog} 2, tokio 1, axum 0.7, tower / tower-http, webrtc 0.12 (**unused**), librqbit 8 (+ http-api on current), serde, anyhow, thiserror, uuid, base64, url, reqwest 0.12, tokio-tungstenite 0.24, tracing, hex, urlencoding, **current:** sha1/sha2/hkdf/aes-gcm/rand, **libp2p 0.54**, **tauri-plugin-libmpv 0.3**

### `apps/receiver-web`

react 18.3, webtorrent ^2.4, zustand, **nostr-tools ^2.23.3 (unused)**, vite-plugin-node-polyfills

### `apps/receiver-mobile`

react-native 0.74, react-native-webrtc 118, react-native-video 6, react-native-webview 13, React Navigation 6

---

## 11. Verdict

**`main`** is a working **tracker-first watch party**: Tauri + FFmpeg + librqbit + TS WebRTC, with cloudflared as compatibility signalling, HTML5 playback, and `/host-video` for range serving.

**`codex/public-torrent-testing`** keeps that live path and adds a **second architecture**: mpv + loopback librqbit HTTP for native public-torrent streaming, Tauri range IPC (so tracker-mode browsers can still pull from the host), and a full **libp2p + share-code + AES-GCM** signalling/content layer that is implemented in Rust/TS but not yet the only way Home creates a room.

Treat current as **main + public torrent/mpv/IPC + libp2p scaffold**, not as a complete cutover off trackers and cloudflared.
