# Public Torrent Architecture

Status: first implementation milestone

## Scope

Public mode streams an existing public `.torrent` or magnet. Torrent metadata,
file names, content, swarm participation, and peer network addresses must be
treated as public. Watch-party admission, chat, playback synchronization, and
camera signaling remain a separate control plane.

## Native media path

1. The host opens a `.torrent` with `p2p_open_torrent_file` or a magnet with
   `p2p_open_magnet`.
2. One shared `TorrentStreamManager` owns the librqbit session and a loopback
   HTTP API bound to `127.0.0.1` on an ephemeral port.
3. The selected primary video is exposed through librqbit's Range-aware stream
   URL. mpv opens that URL, so reads and seeks reprioritize torrent pieces.
4. The host sends the public magnet in the existing `video-ready` control
   message.
5. Native receivers call `p2p_open_magnet`, open their own loopback stream in
   mpv, and upload acquired pieces back to the public swarm.
6. Multi-video torrents expose their video inventory to the host. The selected
   torrent file ID is carried in `video-ready`, ensuring every native receiver
   opens the same episode or movie.

The UI polls the active librqbit handle for checked bytes, total torrent bytes,
peer count, download speed, and upload speed. These values describe the whole
torrent session; playback reads continue to prioritize the selected video.

The loopback HTTP endpoint is process-local IPC. It is not exposed to other
machines and is not a StreamSync central server.

## Browser compatibility path

Browser WebTorrent peers cannot normally connect to librqbit's TCP/uTP peers.
A browser first attempts WebTorrent when a WebRTC-capable public seed exists.
If none exists, it requests media ranges over its host WebRTC DataChannel. The
host reads those ranges from the same librqbit stream through
`read_video_chunk`.

This fallback is compatible but not bandwidth-decentralized: every browser
fallback receiver consumes host upload. The native app is therefore required
for the full public-swarm behavior until a WebRTC BitTorrent bridge is added.

## Public metadata boundary

Potentially visible to trackers, DHT participants, or connected peers:

- info hash, torrent name, file paths and sizes;
- trackers, web seeds, piece layout and hashes;
- peer IP address, port, peer ID and client capabilities;
- piece availability, requests, progress and timing;
- the public media bytes themselves.

StreamSync must not add a room secret, participant name, device name, absolute
local path, stable installation ID, or chat data to torrent metadata.

## Next public-mode milestones

- Add session cancellation and per-torrent cache retention controls.
- Measure aggregate host upload with four native receivers.
- Add a WebRTC-capable BitTorrent bridge for browser peer redistribution.
