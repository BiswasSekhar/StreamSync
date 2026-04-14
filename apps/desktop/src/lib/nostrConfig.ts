// Relays known to accept ephemeral event kinds (20000-29999).
// SimplePool publishes to all simultaneously — more relays = more resilience.
// DO NOT add relay.primal.net or purplepag.es — they block kind 29999.
// DO NOT add nostr.wine — requires paid registration to write events.
export const SIGNAL_RELAYS = [
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://nostr-pub.wellorder.net",
  "wss://nostr.oxtr.dev",
  "wss://nostr.bitcoiner.social",
  "wss://relay.nostr.wirednet.jp",
  "wss://nostr.fmt.wiz.biz",
];
