# StreamSync production-readiness audit and redesign plan

**Audit date:** 2026-09-19  
**Scope:** desktop host, web receiver, mobile receiver, shared protocol package, Tauri/Rust backend, torrent and WebRTC paths, packaging, and current UI.

## Executive outcome

StreamSync is currently a promising prototype, not one coherent production system. It contains three partially overlapping products:

1. A tracker-based WebRTC signalling path with a host-side DataChannel byte server.
2. A Cloudflare Quick Tunnel compatibility path carrying WebSocket signalling.
3. A newer Rust/libp2p/librqbit architecture that is mostly scaffolded and is not the authority used by the normal `create_room` flow.

That split explains the connection failures and the user-visible confusion. A guest can successfully discover a room but still have no compatible content path, or can receive WebRTC signalling while the native torrent path is not actually participating in the session.

The production direction should be:

- one session controller and one versioned protocol;
- one automatic connection ladder instead of a Tracker/Tunnel mode toggle;
- private content distribution for private rooms, public torrent distribution only when the user explicitly chooses public mode;
- WebRTC for browser media and compatibility, libp2p/QUIC or a private piece protocol for native peers;
- a deliberate host/guest control-room UI rather than several overlapping demos;
- a receiver-first Android release before attempting Android hosting.

Do not promise that five browser guests consume only one file-sized upload from the host. The current browser DataChannel fallback sends the requested bytes separately to every guest. A native swarm can spread pieces and reduce host upload, but it requires native peers or a browser-to-browser WebRTC torrent bridge.

## Verification performed

- Rust backend `cargo check`: passes; there is an unreachable-code warning in `engine/ffmpeg.rs`.
- Rust backend `cargo test`: 27 tests pass, including the new range-validation tests.
- Desktop frontend `tsc && vite build`: passes.
- Web receiver `tsc && vite build`: passes.
- Shared package build: passes.
- Root release build initially failed because Rust `tauri` resolved to `2.11.1` while `@tauri-apps/api` resolved to `2.10.1`; this was fixed by pinning the Tauri JS API/CLI and Rust core to `2.11.1`. The final build produced MSI and NSIS installers.
- Visual browser check: the current home screen renders, but the first-run legal wall, contradictory tunnel copy, and exposed signalling mode choice make the product feel like a prototype. The unguarded Tauri drag-listener promises found during that check are now guarded for browser QA.

The existing documents `STREAMSYNC_ARCHITECTURE_AUDIT_AND_WORKPLAN.md`, `PUBLIC_TORRENT_ARCHITECTURE.md`, `HOST_ORIGIN_SERVERLESS.md`, and `STACK_ANALYSIS_MAIN_VS_CURRENT.md` contain useful prior analysis. This report consolidates the current code state and supersedes the older assumptions where they conflict with the active implementation.

## Current architecture map

### Active desktop host path

`commands/session.rs#create_room` creates either a random 40-character tracker identifier or a UUID-prefixed Cloudflare room. It does not start the Rust libp2p session, does not create the Crockford share-code identity, and does not make the shared torrent manager the authority for the room.

The active host then uses `HostWebRTC`:

- WebSocket or WebTorrent tracker signalling;
- one `RTCPeerConnection` per guest;
- ordered media DataChannel requests for browser-compatible byte ranges;
- optional host/guest camera tracks;
- host-side relay of remote camera streams.

### Native content path

`engine/torrent_stream.rs` contains a newer shared librqbit session, but the older `engine/torrent.rs` still exists and exposes overlapping commands. The newer path enables public DHT, UPnP port forwarding, and a list of public trackers. That is acceptable for explicitly public torrents, but it is not a private room protocol.

### libp2p path

`engine/libp2p_node.rs` composes TCP, QUIC, relay client, Gossipsub, Kademlia, mDNS, AutoNAT, DCUtR, and ping. It is not connected to the normal room lifecycle. It also subscribes to a share-code-derived topic without implementing a real rendezvous/provider lookup. Gossipsub is not a peer-discovery mechanism by itself.

### Web receiver

The receiver joins the host WebSocket flow, tries a browser WebTorrent public swarm when a magnet is present, then falls back to host DataChannel range reads. The browser bundle is loaded from an unpinned CDN script even though a local WebTorrent bundle exists in the desktop app.

### Mobile receiver

The React Native app is a receiver prototype. It has no checked-in native Android/iOS projects, accepts a URL but not the canonical share code, sends a legacy `join` message instead of the current admission flow, expects `magnet` while the host sends `video-ready`, and tries to pass a WebView-scoped blob URL to a native video player.

## Findings by priority

### P0 — release and security blockers

#### 1. The release build is not reproducible

The root build fails on the Tauri JS/Rust minor-version mismatch. Pin the Tauri JS packages, CLI, Rust crates, and lockfile to one tested minor version, then add a clean-machine build to CI.

#### 2. Media range handling can underflow or allocate attacker-controlled memory

`read_video_chunk` validates `start >= file_size` only for one active-stream branch. The librqbit and local-file branches calculate `clamped_end - start + 1` without first rejecting an out-of-bounds start. A malformed or malicious guest request can therefore underflow, cast a large value to `usize`, and attempt a large allocation or fail unpredictably.

Required fix:

- reject `start >= total_size` in every branch;
- use checked arithmetic;
- enforce a hard maximum range, for example 2 MiB;
- enforce a per-peer in-flight byte budget;
- validate returned byte length and `Content-Range`;
- use one shared HTTP client with timeouts for the torrent HTTP adapter;
- add Rust unit tests for zero-length, last-byte, out-of-range, overflow, and oversized requests.

#### 3. The WebSocket signaller is an unauthenticated room router

The server binds `0.0.0.0:8787`, enables permissive CORS, parses arbitrary JSON, has no frame-size limit, has no rate limiter, uses unbounded outgoing channels, and treats the room identifier as the only admission secret. Chat fields, sender identity, room transitions, and target routing are not strongly validated. A socket can also send `join` repeatedly without a clean leave from its old room.

Required fix:

- replace `serde_json::Value` with a versioned enum/schema;
- cap WebSocket frames and chat messages;
- cap each connection's send queue and disconnect slow consumers;
- authenticate the host with a session public key and admission token;
- sign or MAC join, offer, answer, ICE, sync, and chat envelopes;
- enforce one room membership per socket;
- remove dead peers on every close/error path;
- rate-limit signalling and chat separately;
- bind only to the intended interface in local mode;
- make CORS an explicit allow-list for the hosted web receiver.

#### 4. Tauri permissions and CSP are too broad

The default capability grants recursive read/write/remove/rename/copy access across home, downloads, videos, documents, and the app directory. The CSP permits unsafe inline/eval and arbitrary `http`, `ws`, `https`, and `wss` connections. This is much broader than a media picker, local playback, and the selected signalling endpoints require.

Required fix:

- reduce the frontend file API to the exact file-picker and app-cache operations;
- keep arbitrary filesystem reads in Rust commands that validate paths and intent;
- remove recursive write/delete permissions unless a concrete feature needs them;
- remove `unsafe-eval`; remove `unsafe-inline` after styles/scripts are migrated;
- enumerate allowed signalling origins and media schemes;
- document why each capability exists and test the packaged app with a capability audit.

#### 5. Tunnel shutdown can kill unrelated processes

The Windows path uses `taskkill /F /IM cloudflared.exe`, which is process-name-wide rather than scoped to the child spawned by StreamSync. Stop only the owned child process and record its PID/handle. The tunnel should become an optional last-resort adapter, not the default architecture.

#### 6. Session shutdown does not close every network owner

`close_room` clears state handles but does not provide a single cancellation boundary for the libp2p supervisor, librqbit session, ffmpeg/ffprobe workers, watchers, or all WebRTC peers. A closed room can therefore leave background networking, DHT activity, file handles, and tasks alive.

Create one `SessionController` cancellation token. Every worker, torrent session, tunnel child, WebSocket room, WebRTC peer, and media preparation process must be owned by it and stop on the same transition.

### P1 — correctness, connection, and performance blockers

#### 7. There are two different room identities and two different capacity limits

The active tracker path uses a random 40-character hex info hash. The shared package and Rust share-code module define a 16-character Crockford code with derived identities, but the normal room path does not use it. The signaller caps rooms at 6 while the shared UI limit is 12. The user sees a system that may advertise one identity and enforce another limit.

Freeze a single `SessionDescriptor` and a single capacity constant. The canonical user-facing code should be grouped Crockford text, for example `ABCD-EFGH-JKLM-NPQR`; URLs and QR codes should carry the same descriptor, not a separate tracker-only code.

#### 8. The active host WebRTC topology is expensive and races during renegotiation

For every host peer connection, the host adds the tracks from every other guest. A new remote camera track is then added to every other peer. This becomes host fan-out and renegotiation work that grows roughly quadratically with camera senders. The code uses a local renegotiation boolean but not a complete perfect-negotiation/glare state machine.

Default production policy:

- host camera is the normal camera feature;
- guest cameras are opt-in and limited to a small sender cap;
- use `replaceTrack` on pre-created transceivers;
- use perfect-negotiation roles, offer queues, and ICE restart backoff;
- do not retransmit every camera to every participant in rooms larger than the tested sender cap;
- if full multi-camera rooms are required, use a real SFU architecture instead of making the host browser an accidental SFU.

#### 9. Browser chunk ordering is not fully safe

The host handles DataChannel requests with asynchronous IPC reads. Multiple reads can complete out of order. The desktop receiver has an envelope path, but the web receiver still has a raw metadata/payload pairing path and the MSE pump appends chunks as they arrive, not by byte offset. That can append bytes in the wrong order or pair metadata with the wrong binary payload.

Use one binary frame format everywhere:

```text
version | request id | chunk id | offset | payload length | payload
```

Keep a per-peer request queue or reorder map keyed by chunk id. Append to MSE strictly by offset. Reject duplicate, missing, oversized, and unexpected ranges. Use one shared implementation in the package rather than separate desktop/web parsers.

#### 10. Camera permissions and track ownership are duplicated

`JoinSession` obtains a camera stream and then calls `JoinWebRTC.openCamera`, which obtains a second stream. Turning the UI camera off stops the page-owned stream but does not reliably stop the RTC-owned stream or remove its senders. Switching cameras changes the preview but not necessarily the live sender.

Use one `MediaSession` object that owns exactly one local stream. It should explicitly request permission after admission, use `replaceTrack` for device changes, stop all tracks on disable/leave, and expose one state machine to the UI.

#### 11. Connection recovery is incomplete and STUN-only

The main desktop config has public STUN servers but no TURN. The join path handles `failed` by notifying the UI rather than attempting a bounded ICE restart/reconnect. The browser receiver has no complete WebSocket recovery/admission state machine. STUN is not sufficient for symmetric NATs.

Use a reachability ladder with telemetry:

1. LAN direct address / mDNS or QR-delivered local endpoint.
2. Native libp2p QUIC/TCP direct connection.
3. WebRTC ICE with STUN for discovery.
4. Self-hosted or community Circuit Relay v2 / TURN fallback.
5. Optional Cloudflare-style HTTPS/WSS ingress only for browsers that need it.

Every attempt should report `discovering`, `direct`, `hole-punching`, `relayed`, `degraded`, or `failed`, with a reason and retry budget. The UI should show the current path without exposing a transport choice that users cannot understand.

#### 12. Private rooms currently leak into public torrent infrastructure

The new torrent stream manager appends public trackers and enables DHT/UPnP. Public torrent metadata, info hashes, file names, peer addresses, and swarm activity are not compatible with a private watch-party promise. Split content into explicit `public` and `private` modes. Private mode must not publish to public trackers or the public DHT.

#### 13. Media preparation can advertise the wrong file

Remux/transcode runs asynchronously, while the session can be created and `video-ready` can be sent using the original path, size, and codec metadata. Temporary output names are based on the source stem and can collide. FFmpeg processes are not consistently cancelled with the room.

Make media preparation a state transition: probe -> prepare -> atomic publish -> final probe -> announce. Use a per-session temp directory, unique output name, cancellation token, and final metadata from the prepared artifact. The host player and all guests must use the same published artifact identity.

#### 14. Mobile signalling and content protocols do not match the desktop protocol

The mobile receiver sends only `join`, does not complete current admission, expects `magnet`, and does not handle the desktop `video-ready` shape. Camera is requested automatically on offer. The WebView torrent blob URL cannot be assumed to work in `react-native-video` because the blob is scoped to the WebView.

Stop extending this path piecemeal. First make mobile a native receiver of the same versioned control and range protocol. Remove the WebView torrent experiment from the production path.

### P2 — architecture and maintenance debt

- `engine/torrent.rs` and `engine/torrent_stream.rs` are overlapping torrent implementations. Keep one after migration tests pass.
- Nostr dependencies/scaffolding and the missing service-worker path are not part of the active product. Remove them or isolate them behind an explicitly tracked proposal.
- The web receiver loads WebTorrent from an unpinned CDN. Vendor/pin the asset or remove the dependency from the fallback path.
- `ChatPanel`, `EncodeProgress`, `FacecamGrid`, `PeerList`, and the legacy HTML video path are not part of the active desktop session. Delete after a reference/test sweep.
- The Home and Session pages contain large duplicated inline style/control blocks. Extract shared primitives and tokens.
- Settings controls for encoder, camera, microphone, DHT, and TURN do not consistently affect runtime state.
- Host session effect dependencies include `displayName`, so a name change can tear down an active host connection.
- Shared comments claim swarm scaling and a 12-peer limit while the active path still uses host DataChannel copies and a six-peer server cap. Documentation and metrics must describe the actual path.

## Target architecture

```text
                    +----------------------+
                    |  SessionController   |
                    |  auth, roster, state |
                    +----------+-----------+
                               |
       +-----------------------+-----------------------+
       |                       |                       |
+------v------+        +-------v--------+       +------v-------+
| Discovery / |        | ContentSource  |       | MediaSession |
| signalling |        | private/public |       | WebRTC AV    |
+------+------+        +-------+--------+       +------+-------+
       |                       |                       |
  LAN / rendezvous /      piece exchange /        host camera,
  libp2p relay             DataChannel fallback    chat, sync
```

### Session identity and admission

Use one session descriptor containing:

- protocol version;
- canonical room id derived from the share code;
- host public key and signed host descriptor;
- expiry and admission policy;
- content manifest id and privacy mode;
- transport candidates and relay hints.

The share code is an invite secret, not the sole identity proof. A guest presents a nonce-bound admission request; the host signs an admission token that is valid only for the room, peer key, and short time window. All later control messages carry the session id, sender key, counter, and authenticated envelope.

### Signalling transport abstraction

Create one interface with adapters, not separate app-level protocols:

```text
SignallingTransport
  connect(SessionDescriptor)
  send(ControlEnvelope)
  events(): PeerDiscovered | Signal | Closed | Error
  close()
```

Recommended adapters:

- `Lan`: mDNS/local endpoint or a QR-provided address;
- `Rendezvous`: small WebSocket service for browser discovery/signalling only;
- `Libp2p`: native discovery and signed control messages;
- `Relay`: Circuit Relay v2 or TURN-like fallback;
- `Tunnel`: optional browser compatibility adapter, disabled unless required.

Do not run libp2p, a tracker, Nostr, and Cloudflare as four competing sources of truth. Discovery can have multiple adapters; the room state machine must not.

### Content distribution

#### Private room

Use a private manifest with piece hashes and a room-scoped content key. Native peers exchange blocks over libp2p request/response or a private torrent swarm that is not announced to the public DHT/trackers. The host is the first seeder, then peers seed verified pieces.

Browsers and constrained mobile clients use an authenticated DataChannel block request fallback. To approach one-file-sized host upload for browser groups, add a WebRTC-to-WebRTC browser swarm bridge; otherwise report the real host upload cost as `number of fallback consumers x bytes served`.

#### Public torrent

Keep public WebTorrent/librqbit as an explicit public mode. Show the user that metadata and peer visibility are public. It is not the private watch-party default.

### Connection alternatives

| Option | Best use | Limitation | Decision |
|---|---|---|---|
| libp2p + QUIC + DHT + Circuit Relay v2 | Native desktop/mobile peer discovery and piece exchange | Browsers cannot directly use native TCP/QUIC; needs browser signalling/ICE path | Recommended native foundation |
| iroh | A smaller QUIC-oriented native connectivity layer with relay/hole-punching | Adds a second native networking stack while libp2p already exists | Evaluate later, do not mix into v1 |
| WebTorrent/WebRTC | Browser-to-browser piece sharing | A browser peer cannot directly connect to an ordinary TCP/uTP-only seed | Use for a browser bridge, not as the universal engine |
| Nostr | Optional rendezvous/signalling transport | Not a media or NAT traversal protocol; relay dependence remains | Remove from active code until a concrete use exists |
| Cloudflare Quick Tunnel | Browser-compatible last-resort ingress | Centralized availability, process lifecycle and privacy trade-offs | Optional compatibility fallback |

There is no completely free, fully decentralized guarantee for every NAT. Hole punching needs a rendezvous path and some networks require a relay. The honest design is to make relay ownership replaceable: ship a local/self-hostable relay option, use community infrastructure only when enabled, and show the path to the user.

## UI redesign specification

The visual direction should be a calm “private watch-room control surface”: near-black cinema canvas, warm paper text, one restrained mint network accent, and amber only for attention. Avoid the current mixture of indigo, neon green, rounded cards, emoji controls, and repeated inline styles.

Suggested tokens:

```text
canvas       #0B0D0F
panel        #14191E
panel-raised #1B2228
text         #E8E3D6
muted        #8F9AA1
signal       #7FE0C3
attention    #F2B35A
danger       #E16F61
border       rgba(232, 227, 214, .12)
```

### Home / host setup

Make the primary task one decision: **Choose media** -> **Create private room**. A secondary action joins a room. Remove the Tracker/Tunnel radio choice.

The setup view should show:

- selected file or magnet;
- preparation status and final playable format;
- room privacy: Private room / Public torrent;
- automatic connection status, not implementation jargon;
- a compact “Advanced network” disclosure for relay policy and diagnostics.

The first-run legal agreement should be a concise summary with a scrollable full text and clear settings link. It should not make the product's first impression a large disclaimer wall. Legal wording still needs an actual review.

### Host session

Use a three-zone layout:

- center: video and playback controls;
- right: tabs for Guests, Connection, and Chat;
- bottom/compact rail: invite code, copy/QR, room status, and host controls.

The connection badge should say “Direct”, “LAN”, “Relay”, or “Reconnecting”, with a details popover. Do not expose “Tracker Primary” or “Tunnel Fallback” as user-level choices.

Camera tiles should be a bounded dock with one layout policy, not draggable arbitrary cards. Camera and microphone require explicit per-user action after joining. Every icon button needs an accessible name and visible keyboard focus.

### Guest session

Use a short stateful entry flow:

1. enter code or scan QR;
2. choose display name;
3. join approval / connection progress;
4. media permission prompt only when the user enables camera/mic;
5. cinema view with a small chat/participant drawer.

Make buffering, reconnecting, and “relay in use” visible but calm. The guest should never need to understand torrents, WebRTC offers, or tunnels to watch a file.

### Component cleanup

Create shared components:

```text
SessionShell
WatchSurface
ConnectionBadge
PeerRail
ChatDock
InvitePanel
MediaControls
PermissionSheet
ToastRegion
```

Move all colors, spacing, radii, typography, focus states, and reduced-motion rules into tokens. Replace page-level inline styles with the component system. Delete legacy components only after the active route and receiver tests no longer reference them.

## Implementation sequence

### Phase 0 — freeze the contract

1. Fix and pin Tauri versions; make the root build pass.
2. Choose one canonical share code and one room-capacity constant.
3. Define `protocol-v1` schemas and shared size limits.
4. Add protocol/range/cipher unit tests and a session lifecycle test.
5. Add a runtime feature matrix: desktop host, desktop guest, browser guest, Android guest.

### Phase 1 — harden the existing path

1. Fix range validation, max sizes, response validation, and backpressure.
2. Harden WebSocket framing, auth, routing, rate limits, and close cleanup.
3. Restrict Tauri capabilities/CSP.
4. Replace global tunnel killing with owned-child lifecycle.
5. Add one cancellation boundary for room, torrent, ffmpeg, and WebRTC resources.

### Phase 2 — make connectivity real

1. Implement `SignallingTransport` and make the current WebSocket path one adapter.
2. Add LAN discovery and QR/local endpoint sharing.
3. Wire libp2p into room creation and implement a real rendezvous/provider lookup.
4. Add AutoNAT, relay reservation, DCUtR, and a self-hostable relay configuration.
5. Add WebRTC TURN/relay fallback and ICE restart telemetry.
6. Keep Cloudflare as a compatibility adapter only.

### Phase 3 — replace the content split

1. Select one torrent/block engine.
2. Separate private-room content from public torrent content.
3. Implement piece verification, cancellation, seeding policy, and clean shutdown.
4. Implement the authenticated browser chunk bridge with ordered/reordered frames.
5. Measure host upload for native swarm, browser bridge, and pure host fallback.

### Phase 4 — repair WebRTC, camera, and chat

1. Introduce `MediaSession` with one stream owner and `replaceTrack`.
2. Implement perfect negotiation and bounded ICE restart.
3. Set a tested camera-sender policy; do not build an accidental N-squared SFU.
4. Validate chat/sync schemas, cap text, local-echo messages, deduplicate ids, and authenticate senders.
5. Add permission and disconnect/reconnect UX.

### Phase 5 — ship the redesigned UI

1. Build the token layer and shared session shell.
2. Redesign Home, host session, guest session, and settings around the state machine.
3. Add responsive/touch behavior, focus states, reduced motion, empty/error states, and screen-reader labels.
4. Remove duplicated inline UI and unused legacy components.

### Phase 6 — Android receiver, then host

1. Keep the React Native receiver separate until the protocol is stable.
2. Implement native private block/range caching; do not use WebView blob URLs as the player source.
3. Add the canonical code/QR join flow, reconnect, permission UX, chat, and sync.
4. Test Android on Wi-Fi, cellular NAT, background/foreground, permission denial, and low storage.
5. Only then decide whether Android hosting is worth adding. Hosting needs native file access, a long-lived networking service, battery policy, and a relay/discovery story; it should not be promised in the first mobile release.

## Test and release gates

### Correctness

- One host + desktop guest + browser guest + Android guest can join the same private room.
- A room can be closed, reopened, and rejoined without old sockets, DHT, torrent, or ffmpeg tasks surviving.
- Join, leave, reconnect, duplicate join, room-full, host-ended, and permission-denied states are deterministic.
- Media ranges are bounded, ordered, verified, and seekable.

### Security

- Unauthenticated sockets cannot inject signalling or chat into an active room.
- Room code does not grant unlimited lifetime access; admission tokens expire and are bound to a peer key.
- Private content never announces to public trackers/DHT.
- Packaged Tauri capabilities and CSP are least-privilege.
- Fuzz tests cover control messages, range headers, chunk envelopes, and share codes.

### Performance

- Measure host upload, peer upload, time-to-first-frame, rebuffer rate, and memory for 1/3/5/10 guests.
- Test direct LAN, home NAT, symmetric NAT/hotspot, office firewall, IPv4-only, IPv6, relay, and reconnect scenarios.
- Run a multi-hour soak with repeated seek, pause/resume, chat, camera toggles, and guest churn.
- Verify that the host's upload curve improves when native peers seed pieces; report fallback browser behavior separately.

### Packaging

- Fresh-machine desktop release build passes.
- FFmpeg/ffprobe and any selected relay/runtime assets are bundled and resolved without PATH assumptions.
- Android has a reproducible native build with checked-in configuration.
- Web receiver does not depend on an unpinned CDN for a critical path.

## Recommended immediate next work

The first implementation batch should be small and measurable:

1. pin Tauri versions and make `pnpm build` green;
2. fix media range underflow/size caps;
3. harden and version the signaller;
4. unify the share code and room limit;
5. add a session cancellation owner;
6. remove the Home mode toggle and replace it with a connection-status rail;
7. implement one camera owner and one chunk framing path;
8. add a five-peer upload/reconnect test harness before claiming decentralized bandwidth savings.

Only after that batch should the old torrent engine, Nostr scaffolding, unused UI components, and tunnel-first copy be deleted. This keeps the cleanup reversible while the new protocol proves itself.
