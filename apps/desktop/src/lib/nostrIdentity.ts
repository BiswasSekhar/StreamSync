import { generateSecretKey, getPublicKey } from "nostr-tools";

type IdentityScope = "host" | "join";

interface NostrIdentity {
  secretKey: Uint8Array;
  pubkey: string;
}

const STORAGE_KEY_PREFIX = "streamsync_nostr_secret";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const value = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(value)) return null;
    bytes[i / 2] = value;
  }
  return bytes;
}

export function getSessionNostrIdentity(scope: IdentityScope): NostrIdentity {
  const fallbackSecret = generateSecretKey();

  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return {
      secretKey: fallbackSecret,
      pubkey: getPublicKey(fallbackSecret),
    };
  }

  const storageKey = `${STORAGE_KEY_PREFIX}:${scope}`;
  const stored = window.sessionStorage.getItem(storageKey);
  const parsed = stored ? hexToBytes(stored) : null;
  const secretKey = parsed && parsed.length === 32 ? parsed : fallbackSecret;

  if (!parsed || parsed.length !== 32) {
    window.sessionStorage.setItem(storageKey, bytesToHex(secretKey));
  }

  return {
    secretKey,
    pubkey: getPublicKey(secretKey),
  };
}
