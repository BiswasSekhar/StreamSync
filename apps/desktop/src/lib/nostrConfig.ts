// Relays that explicitly support ephemeral event kinds (20000-29999).
// relay.primal.net and purplepag.es block kind 29999 — do NOT use them.
export const SIGNAL_RELAYS = [
  "wss://relay.nostr.band",   // reliable, all NIPs including ephemeral
  "wss://nos.lol",             // good throughput
  "wss://relay.damus.io",      // original relay, supports ephemeral
];
