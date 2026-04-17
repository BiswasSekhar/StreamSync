# StreamSync Architecture Audit and Work Plan

Date: 2026-04-17
Scope: Full repo scan with focus on Tauri backend and frontend runtime paths

## 1. Objective

This document maps how the current StreamSync codebase is connected end-to-end, what is implemented today, where contracts are mismatched, and what work plan is needed to reach the product goals:

- Open source, installable host and join experience
- Real media file streaming (not screen share only)
- WebRTC chat and camera
- Torrent and local file support
- Better privacy model (minimum tracking/dependency)
- Stable long sessions (target 7 to 10 hours)

## 2. Repository Areas Reviewed

Primary runtime scope reviewed:

- apps/desktop/src-tauri (Rust backend and Tauri commands)
- apps/desktop/src (desktop React host/join UI, state, WebRTC controllers)
- apps/receiver-web/src (browser receiver)
- apps/receiver-mobile/src (React Native receiver)
- packages/shared/src (shared types and utils)
- scripts and root manifests for build/runtime packaging

## 3. Current Architecture (As Implemented)

Important correction: the backend currently does not run WebRTC media peers in Rust. WebRTC peer connection logic is implemented in frontend TypeScript.

High-level flow:

1. Desktop app starts Tauri (Rust) and React UI.
2. Rust starts local Axum server on port 8787:
   - /ws for signalling relay
   - /host-video for ranged media streaming
   - optional static hosting of receiver-web dist
3. Host UI prepares media (probe/remux/transcode/torrent loading) via Tauri commands.
4. Host UI creates room by launching cloudflared and returns a trycloudflare URL with room query.
5. Receivers connect over WSS to /ws through tunnel.
6. Host and receiver frontend WebRTC managers negotiate peer connections and data channels.
7. Media reaches viewers via one of:
   - DataChannel chunk requests against host /host-video
   - Native torrent path (desktop receiver)
   - WebTorrent in browser path with DataChannel fallback

## 4. Technology Stack and Versions (Current)

## Workspace and Build

- Monorepo: pnpm workspace + turbo
- Root package manager: pnpm 9.0.0
- Orchestration: turbo 1.13.0

## Desktop Host App

- Frontend: React 18.3, TypeScript 5.4, Vite 5.2, Zustand
- App shell: Tauri 2.x
- Backend: Rust 1.78+, tokio, axum, tower-http
- Media: ffmpeg/ffprobe binaries resolved from bundle or system PATH
- Torrent: librqbit 8
- Tunnel: cloudflared sidecar process

## Receiver Web

- React 18.3 + TypeScript + Vite
- WebTorrent 2.4 loaded from CDN in index.html

## Receiver Mobile

- React Native 0.74
- react-native-webrtc 118
- react-native-video
- react-native-webview with embedded WebTorrent script

## Shared Package

- TypeScript-only shared types/utils

## 5. Component Connection Map

### 5.1 Tauri Backend Modules

- src/lib.rs:
  - bootstraps app, registers Tauri commands
  - starts Axum signaller server
  - runs hardware encoder detection at startup
- src/commands/file.rs:
  - probe_file
  - extract_subtitle_command
  - prepare_video_for_streaming
  - start_seeding_original
  - load_torrent_file
- src/commands/session.rs:
  - create_room
  - close_room
  - get_session_status
- src/commands/torrent.rs:
  - get_magnet
  - get_torrent_stats
  - load_magnet_link
- src/engine/signaller.rs:
  - /ws room relay
  - /host-video range serving for local/torrent stream
- src/engine/ffmpeg.rs:
  - binary resolution, probe, subtitle extract, remux, transcode, progress events
- src/engine/torrent.rs:
  - seeding local file, loading external torrent/magnet, stream source setup, progress emit
- src/engine/tunnel.rs:
  - cloudflared lifecycle and tunnel URL extraction

### 5.2 Desktop Frontend Runtime

- src/store/session.ts:
  - central app state machine
  - command invocation and event listeners
- src/lib/hostWebrtc.ts:
  - host signalling client and peer admission
  - creates offer/answer and data channels
  - serves chunk requests by fetching /host-video
- src/lib/joinWebrtc.ts:
  - joiner signalling client and approval flow
  - receives video-ready, sync/chat/media chunks
- src/pages/Session.tsx:
  - host live room UI
- src/pages/JoinSession.tsx:
  - desktop join playback transport and sync handling
- src/components/VideoPlayer.tsx:
  - host local playback source from /host-video

### 5.3 Web Receiver Runtime

- src/App.tsx:
  - name/join flow, status state, MSE pump, WebTorrent-first fallback strategy
- src/lib/webrtc.ts:
  - signalling + peer + datachannel implementation for browser

### 5.4 Mobile Receiver Runtime

- src/screens/SessionScreen.tsx:
  - websocket + react-native-webrtc answer path
  - hidden WebView torrent bridge playback
- src/lib/torrentWebView.ts:
  - embedded HTML + CDN WebTorrent client, posts stream URL/progress back to app

## 6. Runtime Contracts (Current)

### 6.1 Tauri Commands Exposed

Exposed by generate_handler:

- probe_file
- extract_subtitle_command
- prepare_video_for_streaming
- start_seeding_original
- load_torrent_file
- create_room
- close_room
- get_session_status
- get_magnet
- load_magnet_link
- get_torrent_stats

Not exposed but called by frontend store:

- detect_hardware (frontend calls invoke("detect_hardware"), but command is not registered)

### 6.2 Tauri Events Emitted by Backend

Implemented emits:

- encode-progress
- encode-complete
- encoder-fallback
- encode-error
- magnet-ready
- torrent-video-ready
- torrent-progress

Listened by frontend but not emitted by backend:

- tunnel-url
- tunnel-disconnected
- tunnel-error
- peer-joined
- peer-left
- chat-message

Note: peer/chat state currently flows via websocket messages in frontend WebRTC managers, not via Tauri event bus.

### 6.3 HTTP Endpoints

- GET /ws
  - websocket signalling relay
  - joins rooms, relays offer/answer/ice/chat/sync messages
- GET /host-video
  - local file stream with byte ranges
  - torrent stream source when torrent_stream is active

### 6.4 WS Signalling Message Families

Observed message types:

- join, room-joined, room-full
- peer-joined, peer-left
- join-request, join-approved, join-denied, host-ended
- offer, answer, ice-candidate, ice-candidates
- chat
- sync
- ping, pong

### 6.5 DataChannel Message Families

Control channel:

- video-ready with fileName, mimeCodec, fileSize, durationSeconds, optional magnetLink

Sync channel:

- sync snapshots and control actions (play/pause/seek)

Chat channel:

- JSON chat payloads

Media channel:

- WEBRTC_CHUNK_REQUEST with Range string
- WEBRTC_CHUNK_RESPONSE metadata then binary payload

## 7. End-to-End Flow by Scenario

### 7.1 Host Local File (Non-torrent)

1. User picks file in desktop home.
2. Frontend invokes probe_file.
3. On create room, frontend invokes prepare_video_for_streaming.
4. Rust runs remux or transcode pipeline; emits encode-progress and encode-complete.
5. Frontend invokes create_room; Rust starts cloudflared and returns public URL + room query.
6. Host enters session UI and HostWebRTC starts local ws://localhost:8787/ws.
7. Receiver joins via tunnel URL, sends join-request.
8. Host admits receiver and creates RTCPeerConnection.
9. Receiver requests media chunks over data channel; host fetches byte range from /host-video and returns binary.
10. Receiver MSE appends chunks and playback sync/chat starts.

### 7.2 Host .torrent Input

1. User drops .torrent in desktop home.
2. Frontend invokes load_torrent_file.
3. Rust starts librqbit external torrent session and sets torrent_stream source for selected primary video file.
4. Backend emits magnet-ready and eventually torrent-video-ready.
5. Host creates room and sends video-ready with magnetLink.
6. Receiver chooses transport:
   - desktop join: invokes load_magnet_link and plays from local /host-video path once file appears
   - web receiver: tries WebTorrent first, then falls back to DataChannel MSE after timeout
   - mobile receiver: currently expects a different control message format

### 7.3 Desktop Join Flow

- Uses full room URL, derives websocket endpoint from tunnel URL.
- Implements admission retry loop until host approves.
- Supports host camera stream, chat, sync, and native magnet loading.

### 7.4 Web Join Flow

- Runs in browser from host-served receiver-web app.
- Connects to same domain /ws.
- Uses WebTorrent when magnet exists, otherwise DataChannel MSE.
- Has built-in timeout fallback to DataChannel.

### 7.5 Mobile Join Flow (Current)

- Uses direct websocket join and react-native-webrtc answer path.
- Expects control message type magnet, not video-ready with magnetLink.
- Does not implement explicit join-request admission sequence.
- This currently diverges from host protocol and can block interoperability.

## 8. Key Findings and Limitations

## P0 Critical Contract/Behavior Gaps

1. README architecture drift
- README claims Rust webrtc-rs peer path and engine/webrtc.rs module.
- Current implementation has no Rust WebRTC usage in runtime modules.

2. Missing command contract
- Frontend invokes detect_hardware but backend does not expose it.

3. Capacity mismatch
- signaller room cap: 9 peers
- host frontend cap: 5 viewers
- stale error text mentions max 8

4. Mobile protocol mismatch
- host sends control type video-ready with optional magnetLink
- mobile listens for control type magnet
- mobile does not follow host join-request approval flow

5. No TURN relay path in active runtime
- STUN-only configuration in host/join/web/mobile peer setup.
- This reduces success in restrictive NAT/firewall networks and hurts long-session reliability.

## P1 High Impact Reliability/Product Gaps

1. Cloudflare Quick Tunnel production risk
- trycloudflare is documented as testing/development only, no SLA, hard concurrent request limits.
- Current create_room depends on trycloudflare every session.

2. Torrent range parsing asymmetry
- /host-video local file path handles bytes=start-end.
- torrent stream path only handles bytes=start- form.
- Can break fallback DataChannel transport for torrent-backed web receiver.

3. Browser WebTorrent compatibility constraints
- Browser WebTorrent peers require WebRTC-capable swarm peers and tracker compatibility.
- Host uses librqbit seeding (BitTorrent), so web path often falls back to DataChannel.

4. DHT privacy inconsistency
- DHT disabled in some torrent load paths but not all (magnet path keeps default DHT behavior).

5. Infinite monitor tasks without cancellation
- torrent monitor loops are spawned and run indefinitely.
- close_room clears state but does not terminate these loops.
- Over many room restarts this can cause stale updates and resource leak patterns.

## P2 Medium Gaps and Cleanup

1. Tunnel event listener mismatch in frontend store
- store listens for tunnel-url/tunnel-disconnected/tunnel-error that backend does not emit.

2. Settings UI not fully wired
- encoder/camera/microphone/privacy toggles mostly UI-local and not connected to backend/session policy.

3. Nostr signaling files appear unused
- nostrConfig and nostrIdentity exist but are not integrated into current signalling flow.

4. Service worker path appears legacy
- desktop public/sw.js intercepts /webrtc-media but runtime chunk path uses direct media data channel and /host-video.

5. Packaging/resource risks
- tauri resources list includes ffmpeg.exe and ffprobe.exe only.
- cloudflared is downloaded into resources but not declared in tauri resources list.
- receiver-web dist inclusion in packaged app is not explicit in tauri bundle resources.

## 9. Privacy and Network Reality (Current)

What is true today:

- Signalling and HTTP ingress are tunnelled through Cloudflare.
- Media payload is mostly peer/datachannel or host local HTTP over tunnel path.
- P2P WebRTC still exposes ICE candidate network information patterns depending on browser/network.

Implications:

- "No central server" is not fully true while relying on cloudflared quick tunnels.
- "No tracking" claims should be softened unless explicit telemetry, logs, and third-party metadata exposure are documented and controlled.

## 10. Current Technology and Limitation Summary

Current technology:

- Tauri desktop host, Rust service layer, React frontend orchestration
- Axum websocket + ranged video endpoint
- FFmpeg remux/transcode pipelines with hardware detection
- librqbit for torrent session/seeding/downloading
- cloudflared quick tunnel for public ingress
- WebRTC data/media channels managed in TypeScript frontends

Main limitations now:

- Protocol parity gaps across desktop/web/mobile clients
- STUN-only connectivity model for WebRTC (no robust TURN fallback)
- Quick Tunnel dependency with no production SLA
- Packaging ambiguity for cloudflared and receiver-web assets
- Long-running session lifecycle cleanup is incomplete

## 11. Complete Work Plan (Prioritized)

## Phase 0: Contract Freeze and Architecture Alignment

Goal: remove ambiguity and align docs to real implementation.

Tasks:

- Update README architecture to reflect actual Rust + TS split.
- Define single shared protocol schema in packages/shared for:
  - websocket message types
  - datachannel message types
  - tauri command and event contracts
- Remove or mark legacy paths (unused service worker and unused nostr scaffolding) until reintroduced intentionally.

Acceptance criteria:

- README and code contracts match 1:1.
- No frontend invoke/listen calls reference missing backend contracts.

## Phase 1: P0 Interop and Stability Fixes

Goal: make all three receivers consistently join and play.

Tasks:

- Implement or remove detect_hardware command call path.
- Unify room capacity limits in one source of truth.
- Align mobile protocol to current host flow:
  - join-request / join-approved
  - video-ready with magnetLink support
- Add compatibility shim so host can optionally send legacy magnet control for mobile transition period.
- Fix torrent range parsing to handle full bytes=start-end consistently.

Acceptance criteria:

- Desktop join, web join, and mobile join all pass same session smoke test.
- No protocol mismatch errors in logs for a 60-minute mixed-client session.

## Phase 2: Network Reliability Hardening

Goal: increase connection success and resilience under real NAT/firewall conditions.

Tasks:

- Add configurable TURN support in all peers (desktop host/join/web/mobile).
- Add ICE policy controls and reconnect/ICE-restart strategy.
- Add websocket reconnect with backoff and room resume semantics.
- Add heartbeat supervision with explicit stale-peer cleanup.

Acceptance criteria:

- Successful connections in restrictive network test matrix (home NAT, hotspot, office wifi).
- Reconnect recovery without app restart for short network blips.

## Phase 3: Transport and Playback Reliability

Goal: reduce stalls and improve quality for long watch sessions.

Tasks:

- Define deterministic transport policy:
  - direct stream for local source
  - native torrent for desktop/mobile when magnet available
  - browser fallback policy with explicit thresholds
- Improve chunk scheduler and backpressure behavior for media data channel.
- Add guardrails for end-to-end sync drift with bounded correction policy.
- Ensure subtitle extraction/selection and codec fallback are deterministic.

Acceptance criteria:

- 3-hour soak test per transport path without fatal playback stalls.
- Sync drift remains within defined threshold during normal operation.

## Phase 4: Privacy Modes and Trust Model

Goal: make privacy claims explicit and user-selectable.

Tasks:

- Add privacy mode profiles:
  - strict P2P (no relay when possible)
  - reliability mode (TURN allowed)
- Unify DHT policy across all torrent entry points.
- Add in-app disclosure for network exposure model and tunnel dependency.
- Add optional self-hosted signalling/tunnel mode documentation.

Acceptance criteria:

- Users can choose mode and understand tradeoffs.
- Behavior matches mode policy in logs and runtime.

## Phase 5: Packaging and Release Readiness

Goal: repeatable production build for desktop host and web receiver.

Tasks:

- Fix tauri bundle resources for cross-platform binary inclusion:
  - cloudflared
  - ffmpeg/ffprobe per target OS/arch
- Ensure receiver-web dist is included in packaged app resources and discoverable at runtime.
- Add build pipeline checks to fail early when required resources are missing.

Acceptance criteria:

- Fresh machine install can create room without manual binary setup.
- Receiver web page loads from packaged app tunnel URL.

## Phase 6: 7 to 10 Hour Session Hardening

Goal: achieve explicit long-session reliability target.

Tasks:

- Add cancellation tokens for background monitor tasks and close-room cleanup.
- Add memory/handle leak checks and per-room lifecycle accounting.
- Add soak test harness with scripted play/pause/seek/chat/camera churn.
- Add telemetry hooks for local diagnostics (opt-in, no remote collection by default).

Acceptance criteria:

- 10-hour soak test pass on target platforms.
- No unbounded task growth or stale session cross-talk after repeated room cycles.

## 12. Suggested Test Matrix

Minimum matrix:

- Host desktop + desktop join
- Host desktop + web join (Chrome, Safari)
- Host desktop + mobile join (iOS, Android)
- NAT variants and mixed network types
- Source types:
  - local MP4/H264
  - MKV/HEVC requiring remux/transcode path
  - .torrent source and magnet source
- Long-run sessions:
  - 3h baseline
  - 7h target
  - 10h stretch

## 13. External References Used for Constraint Validation

- Cloudflare Quick Tunnels docs (testing/development only, no SLA, documented limitations):
  - https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- MDN WebRTC protocols (ICE, STUN, TURN necessity under NAT conditions):
  - https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols
- WebTorrent FAQ (browser peers require WebRTC-capable torrent peers):
  - https://github.com/webtorrent/webtorrent/blob/master/docs/faq.md
- HEVC browser support variability:
  - https://caniuse.com/hevc

## 14. Recommended Immediate Next Milestone

Execute Phase 1 first as a short stabilization sprint.

Reason:

- It removes hard interop blockers.
- It enables reliable cross-client testing.
- It provides the base needed for deeper reliability and privacy hardening work.

Proposed Phase 1 sprint output:

- Unified protocol types in packages/shared
- Mobile compatibility restored
- Missing command/event contract resolved
- Range handling fixed for torrent stream
- Capacity limits unified and tested
