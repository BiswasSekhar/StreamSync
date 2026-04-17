/**
 * Maximum number of peers per room including the host.
 * At 6 we have 1 host + 5 viewers, which keeps host uplink bandwidth
 * manageable for long video sessions.
 */
export const MAX_PEERS_PER_ROOM = 6;

/** Maximum number of viewers (excludes the host). */
export const MAX_VIEWERS_PER_ROOM = MAX_PEERS_PER_ROOM - 1;
