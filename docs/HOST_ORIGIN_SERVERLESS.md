# Host-origin serverless method

Date: 2026-08-15  
Status: design — how to fix the current dual-stack without standing up a StreamSync cloud  
Related: `docs/STACK_ANALYSIS_MAIN_VS_CURRENT.md`

## 1. What is actually broken

The product goal is: **no StreamSync servers; the host PC is the session server.**

The codebase currently implements **two different products** behind one UI:

| Product A — “find each other on the internet” | Product B — “host is a website” |
|-----------------------------------------------|----------------------------------|
| WebTorrent trackers + random hex info-hash | Axum `:8787` + cloudflared URL |
| libp2p gossip (Crockford share code, unused by Home) | `/ws` signalling, historically `/host-video` |
| BitTorrent for movie bytes | DataChannel ranges from the host |
| Desktop-only join | Browser/mobile join |

That split is the root of the live bugs, not missing libraries:

1. **Two share secrets** (40-char hex vs 16-char Crockford) — joiners cannot have one paste box that always works.
2. **Two torrent engines** — lifecycle leaks and stats lie.
3. **Two signalling stacks** — Home still `create_room(tracker|tunnel)`; libp2p never becomes the room.
4. **Browser/mobile only speak Product B** (origin WebSocket). Tracker rooms cannot invite a phone or a browser without Cloudflare.
5. **STUN-only WebRTC** — when ICE fails, the host does not yet act as the relay even though `relay.ts` was designed for that.
6. **Cloudflare Quick Tunnel as “the server”** — trycloudflare is not the host; it is a third-party ingress with no SLA. That contradicts “your machine is the server.”
7. **Admission caps disagree** (shared 12 vs Axum 6).
8. **WebTorrent in the browser cannot talk to librqbit TCP peers**, so browsers fall back to sucking the host’s uplink — which is fine *if* we admit the host is the origin for browsers.

You do not need a new protocol family. You need **one authority (the host process)** and **a reachability ladder** so guests can find that host without StreamSync operating machines.

## 2. Physical constraint (do not design around this)

A share code is ~80 bits. It cannot contain a public IP + port. Across the open internet, **some introduction helper is mandatory**: STUN, DHT, BitTorrent trackers, or a tunnel. That is still serverless **if StreamSync does not run those helpers and does not see movie bytes.**

“Host acts as server” means:

- The **session authority** is the host process: admission, sync clock, first seeder, DataChannel origin, optional guest-to-guest relay.
- Third parties are **introduction only** (or last-resort TCP ingress). They must not be the application server.

Cloudflare Quick Tunnel today is application ingress (SPA + `/ws`). That is why it feels like “we have a server we don’t own.”

## 3. The method: Host-Origin Session (HOS)

One session, one secret, one host process, three roles for that process.

```
Share code  ABCD-EFGH-JKLM-NPQR
     │
     ├─ derive info_hash     → find the host (trackers / DHT)
     ├─ derive session_key   → encrypt all control + DC payloads
     ├─ derive gossip topic  → libp2p mesh (LAN + hole-punch)
     └─ derive host PeerId   → guests can verify “this is the host”
                    │
                    ▼
            HOST PROCESS (the server)
     ┌──────────────────────────────────────┐
     │  Admission + signalling (authority)  │
     │  First seeder (librqbit)             │
     │  Origin for browser byte ranges      │
     │  Relay for guest-guest if ICE fails  │
     └──────────────────────────────────────┘
                    ▲
     LAN mDNS / UPnP / ICE / (optional tunnel)
```

### Role 1 — Session server (always on)

Keep Axum **bound to localhost + LAN**, not “the public website.”

- `/ws` — signalling for anyone who can already reach the host (LAN, mapped port, or a WebRTC datachannel that has been upgraded to a control socket).
- Static `receiver-web` — only for clients that have a **direct HTTP path** to the host (LAN, or a reachability helper).
- **No public `/host-video`.** Byte ranges stay on Tauri `read_video_chunk` → host `mediaDc`. That already matches the current branch and is the correct host-as-origin media API.

The host UI is not a peer among equals. It is the room owner: join-request, capacity, `host-ended`, sync authority.

### Role 2 — First seeder (content)

One torrent engine only: `TorrentStreamManager`.

- Local file: host creates torrent, seeds, plays with mpv from disk.
- Public magnet: host joins the public swarm, mpv reads loopback Range HTTP (process-local IPC, not a public server).
- Native guests: join the same swarm (decentralized after the first pieces).
- Browser guests: **do not pretend they are TCP BitTorrent peers.** They pull ranges from the **host DataChannel** (host-as-server). Optional later: WebRTC BitTorrent bridge so browsers re-seed.

This fixes the “browser always falls back and melts the host” confusion: for browsers, host-origin **is** the method. Swarm scaling is a native-guest bonus, not a browser requirement.

### Role 3 — Connectivity relay (only when needed)

No commercial TURN. The host **is** TURN for this room:

1. Guest tries direct ICE to host (STUN).
2. Guest tries LAN (mDNS / libp2p).
3. If guest-to-host DataChannel is up, the host forwards guest-to-guest frames (`relay.ts` — implement the missing mesh).
4. Symmetric NAT to the host itself: last resort is **TCP/WS ingress** (UPnP port map, or cloudflared as a *dumb pipe*, not a second protocol).

`MAX_RELAYED_PEERS` stays a host-uplink guardrail.

## 4. Reachability ladder (one join, no mode toggle)

Home today asks the user to pick **tracker vs tunnel**. That is the wrong UX. Reachability is automatic:

| Step | How the guest finds the host | When it works |
|------|------------------------------|---------------|
| 0 | Same machine / `ws://localhost:8787` | Host preview |
| 1 | mDNS / LAN IP in QR (optional) | Same Wi-Fi |
| 2 | libp2p DCUtR + UPnP/NAT-PMP on host listen ports | Many home NATs |
| 3 | WebTorrent tracker announce of **host contact**, not of a fake swarm | Today’s tracker path, but payload = “connect to this host” |
| 4 | Kademlia (libp2p bootstrap / Mainline) | When trackers are down |
| 5 | Cloudflared **ingress to the same `/ws`**, same share code | CGNAT, school/corp firewall |

The guest always pastes **one Crockford code**. The client walks 0→5 until the host answers `room-joined`. Tunnel is step 5, not a different room type.

Tracker packets should carry a **host descriptor** (libp2p multiaddrs, optional ICE ufrag, protocol version), encrypted with `session_key`, not a parallel ad-hoc JSON dialect.

## 5. Single share-code contract

Delete user-visible hex info-hashes.

```
code        = 16 Crockford chars (80 bits)
info_hash   = SHA-1(code_bytes || "streamsync-v1")     // tracker / WebTorrent
session_key = HKDF-SHA256(code, "streamsync-session-v1")
topic       = HKDF(..., "streamsync-gossip-v1")
host_id     = libp2p Ed25519 from HKDF(..., "streamsync-libp2p-identity-v1")
```

This code already exists in `share_code.rs` / `shareCode.ts`. `create_room` must call **that** generator, then start:

1. `TorrentStreamManager` if media is ready  
2. libp2p supervisor with host seed  
3. Tracker announce using derived `info_hash`  
4. Axum (already running)  
5. UPnP map for QUIC/TCP/8787 when possible  
6. Tunnel **only if** 1–5 cannot accept an inbound guest within `TRACKER_ZERO_GRACE_MS` **or** the first joiner is a browser with no desktop helper  

`create_room` today generates a **random** info-hash in tracker mode and a **UUID** in tunnel mode. That is the bug to remove.

## 6. One signalling API for every client

All clients (desktop join, receiver-web, mobile) use the same messages already in `packages/shared/src/signalling.ts` + `control.ts`. Transport is a detail:

```
SignallingTransport {
  send(msg)
  onMessage(msg)
}
```

Adapters:

- `LanWsTransport` — `ws://<host>:8787/ws`
- `TrackerTransport` — existing `TrackerSignallingMesh` (binary info-hash)
- `Libp2pTransport` — `p2pClient` gossip kinds mapped onto the same `SignallingMessage` union
- `TunnelWsTransport` — `wss://<trycloudflare>/ws` (step 5 only)

WebRTC `HostWebRTC` / `JoinWebRTC` / `ReceiverWebRTC` talk only to `SignallingTransport`. That is how web/mobile start working in tracker rooms without Cloudflare: a tiny **bootstrap page is not required** if a desktop joiner is on the LAN; for a remote browser, step 5 or a **one-shot QR that includes a temporary multiaddr** is still needed because a raw browser cannot speak libp2p-quic or UDP BitTorrent.

Honest browser rule:

- **Remote browser without tunnel cannot initiate** to a NATed host. Either (a) host has a mapped/public addr and serves `receiver-web` on it, or (b) step-5 tunnel, or (c) user opens the desktop app. Do not promise “paste code in Chrome on LTE” without (a) or (b).

## 7. How this fixes each current issue

| Issue | HOS fix |
|-------|---------|
| Dual share codes | Only Crockford; derive tracker hash |
| Dual torrent engines | Delete usage of legacy `engine/torrent.rs` session from commands; one manager |
| libp2p unused by Home | `create_room` always `p2p_start_session` |
| `/host-video` vs tracker | Keep IPC `read_video_chunk`; host DC is the browser origin |
| STUN-only | Implement host relay (`relay.ts`) after host DC is up |
| Cloudflare as the product | Demote to ladder step 5; same share code, same `/ws` |
| Web/mobile protocol lag | Shared transport + `video-ready` / join-request everywhere |
| Cap 6 vs 12 | One constant compiled into Axum + TS |
| Plaintext DCs | `SessionCipher` on every DC once `session_key` exists |
| Unused webrtc-rs / nostr | Remove from manifests; do not build a third discovery plane |
| README drift | Document host-origin + introduction helpers |

## 8. What not to build

- A StreamSync signalling cloud, TURN farm, or “room service.”
- Browser-native libp2p as a v1 requirement (heavy, still needs bootstrap nodes).
- Replacing BitTorrent with host HTTP for **native** guests (you would throw away swarm offload).
- Keeping tracker-mode and tunnel-mode as user-facing products.
- Using gossipsub as the movie pipe (it is for control; bytes stay torrent or DC).

## 9. Build order (method → implementation)

**M0 — Freeze the contract (days)**  
One share-code helper used by `create_room`. One `MAX_PEERS`. Shared `TAURI_COMMANDS` includes p2p + chunk. README matches.

**M1 — Host is always the room (1 week)**  
`create_room` starts libp2p + tracker announce from the same code. Remove mode toggle from Home. Desktop join walks ladder 0–4.

**M2 — Host-origin media is the only fallback (already partly done)**  
All `mediaDc` paths use `read_video_chunk`. Kill leftover `/host-video` assumptions. Unify torrent into `TorrentStreamManager`.

**M3 — Host as TURN for this room**  
Implement `HostRelayCoordinator` / `GuestMesh`. Encrypt DCs. This is what makes “no TURN vendor” true.

**M4 — Browser honesty**  
receiver-web: if opened via LAN IP or step-5 URL, same join-request protocol. If opened with only a share code and no host HTTP, show “open StreamSync desktop or wait for host to publish a reachability URL.” Optional: host auto-starts tunnel **only to serve the SPA**, still same code.

**M5 — Mobile parity**  
Same signalling messages as desktop; magnet via `video-ready`; WebView torrent optional, DC fallback required.

**M6 — Public torrent** stays a **content source**, not a second session type. Admission never rides the public swarm.

## 10. Success criteria

A session is correct when:

1. Host copies one dashed code; no “tracker vs tunnel” choice.
2. A second desktop on the same LAN joins with no internet trackers (mDNS).
3. A second desktop across home NATs joins via STUN/DCUtR or tracker introduction; movie plays in mpv from librqbit.
4. A browser on the same LAN opens `http://<host-lan>:8787/?room=CODE` and plays via DataChannel (host-origin).
5. If every introduction helper is blocked, the app may start cloudflared **without changing the code or protocol**.
6. No StreamSync-operated server appears in the path. Movie bytes never enter Cloudflare except if you later mistakenly proxy `/host-video` (do not).
7. Closing the host ends the room for everyone (`host-ended`).

That is the method: **the host machine is the application server; the internet only helps guests find it.**
