// Relays known to accept ephemeral event kinds (20000-29999).
// SimplePool publishes to all simultaneously — more relays = more resilience.
// DO NOT add relay.primal.net or purplepag.es — they block kind 29999.
export const SIGNAL_RELAYS = [
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://nostr.wine",
  "wss://nostr-pub.wellorder.net",
  "wss://relayable.org",
  "wss://nostr.oxtr.dev",
  "wss://relay.nostr.band",
];
