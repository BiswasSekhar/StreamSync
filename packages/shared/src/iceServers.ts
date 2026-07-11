/**
 * Expanded STUN pool for WebRTC NAT traversal.
 *
 * StreamSync runs serverless — no TURN by default. When direct ICE fails
 * between two guests, the host relays for them (see `relayMesh.ts`). To
 * keep that fallback path lightly used, we maximize direct-success
 * probability by querying a diverse set of public STUN servers.
 *
 * Add or remove servers here only; do NOT inline STUN URLs at call sites.
 */

export const EXPANDED_STUN_POOL: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.nextcloud.com:443" },
  { urls: "stun:stun.stunprotocol.org:3478" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "stun:stun.ekiga.net:3478" },
];

/**
 * Default RTCConfiguration consumed by every RTCPeerConnection in the app.
 * `iceCandidatePoolSize` warms the gathering loop for faster handshakes.
 */
export const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: EXPANDED_STUN_POOL,
  iceCandidatePoolSize: 4,
};
