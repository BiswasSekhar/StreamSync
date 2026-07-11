/**
 * Maximum number of peers per room including the host.
 *
 * Content rides a BitTorrent swarm (librqbit): once a guest has a piece, its
 * neighbours pull from it, so host uplink scales ~log(N)·file_size rather than
 * N·file_size. That lifts the old uplink-bound cap of 6; 12 (1 host + 11
 * viewers) is now a UX admission limit, not a bandwidth one.
 */
export const MAX_PEERS_PER_ROOM = 12;

/** Maximum number of viewers (excludes the host). */
export const MAX_VIEWERS_PER_ROOM = MAX_PEERS_PER_ROOM - 1;

/**
 * Maximum simultaneous camera/mic senders in the WebRTC conferencing mesh.
 * Mesh topology is N·(N-1) PeerConnections, so A/V is capped below the room
 * size; additional participants stay view-only (file stream + chat). See the
 * conferencing section of the architecture plan.
 */
export const MAX_CONFERENCE_SENDERS = 10;

// ----------------------------------------------------------------------------
// Host-relay mesh limits (see relayMesh.ts / guestMesh.ts)
// ----------------------------------------------------------------------------

/**
 * Hard cap on how many guest-pairs the host will simultaneously relay for.
 * Each relayed pair adds upload pressure on the host's link, so we cap
 * conservatively. Sixth+ peer needing relay sees a clean error and is
 * offered the Compatibility Mode tunnel toggle.
 */
export const MAX_RELAYED_PEERS = 2;

/**
 * `dc.bufferedAmount` threshold above which the host treats a relay-bound
 * channel as backpressured and stops accepting new frames for it.
 */
export const RELAY_BUFFER_HIGH_WATERMARK = 8 * 1024 * 1024;

/**
 * Time we give a fresh guest-to-guest ICE attempt before declaring it
 * failed and falling back to the host relay.
 */
export const ICE_PROBE_TIMEOUT_MS = 8_000;

/**
 * After this long with zero healthy trackers connected, the host UI
 * auto-suggests switching to Compatibility Mode (cloudflared tunnel).
 */
export const TRACKER_ZERO_GRACE_MS = 20_000;
