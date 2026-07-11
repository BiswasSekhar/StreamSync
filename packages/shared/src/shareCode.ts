/**
 * Share-code utilities for StreamSync's serverless P2P mode.
 *
 * A share code is a human-friendly 16-character Base32 string (80 bits of
 * entropy) shown as four dashed groups: `ABCD-EFGH-JKLM-NPQR`.
 *
 * From the share code we derive both:
 *   - `info_hash`  = SHA-1(code || "streamsync-v1")   — used to find the
 *     swarm on a WebTorrent tracker. Public; leaks presence but not content.
 *   - `session_key` = HKDF-SHA256(code, "streamsync-session-v1", 32 bytes)
 *     — AES-256-GCM key for E2E encrypting every DataChannel payload.
 *
 * Anyone with the share code can both find the swarm and decrypt the traffic;
 * anyone without it can do neither. This is the BitTorrent threat model done
 * correctly.
 */

// Crockford Base32 alphabet (no I, L, O, U) for human readability.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_INDEX = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
    m.set(CROCKFORD_ALPHABET[i]!, i);
  }
  // Common typo equivalences: I/L → 1, O → 0
  m.set("I", 1);
  m.set("L", 1);
  m.set("O", 0);
  return m;
})();

export const SHARE_CODE_ENTROPY_BYTES = 10; // 80 bits
export const SHARE_CODE_CHARS = 16;
export const INFO_HASH_CONTEXT = "streamsync-v1";
export const SESSION_KEY_CONTEXT = "streamsync-session-v1";
export const GOSSIP_TOPIC_CONTEXT = "streamsync-gossip-v1";
export const LIBP2P_SEED_CONTEXT = "streamsync-libp2p-identity-v1";

/** Encode 10 raw bytes (80 bits) as a 16-char Crockford Base32 string. */
function encodeBase32(bytes: Uint8Array): string {
  if (bytes.length !== SHARE_CODE_ENTROPY_BYTES) {
    throw new Error(`expected ${SHARE_CODE_ENTROPY_BYTES} bytes, got ${bytes.length}`);
  }
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Decode a 16-char Crockford Base32 string back to 10 raw bytes. */
function decodeBase32(code: string): Uint8Array {
  if (code.length !== SHARE_CODE_CHARS) {
    throw new Error(`expected ${SHARE_CODE_CHARS} chars, got ${code.length}`);
  }
  const out = new Uint8Array(SHARE_CODE_ENTROPY_BYTES);
  let bits = 0;
  let value = 0;
  let outIdx = 0;
  for (const ch of code) {
    const v = CROCKFORD_INDEX.get(ch);
    if (v === undefined) {
      throw new Error(`invalid share code character: ${ch}`);
    }
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx++] = (value >>> bits) & 0xff;
    }
  }
  if (outIdx !== SHARE_CODE_ENTROPY_BYTES) {
    throw new Error("share code decode underflow");
  }
  return out;
}

/** Format a 16-char raw code as `ABCD-EFGH-JKLM-NPQR`. */
function dashFormat(raw: string): string {
  return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}

/** Strip dashes / spaces / underscores and uppercase. */
function canonicalize(input: string): string {
  return input.replace(/[\s\-_]/g, "").toUpperCase();
}

/** Generate a fresh share code with 80 bits of entropy. */
export function generateShareCode(): string {
  const bytes = new Uint8Array(SHARE_CODE_ENTROPY_BYTES);
  crypto.getRandomValues(bytes);
  return dashFormat(encodeBase32(bytes));
}

/**
 * Parse user input back into a canonical share code (dashed, uppercase).
 * Accepts dashes, spaces, underscores, and lowercase. Maps I/L→1, O→0.
 * Returns null when the input cannot be parsed.
 */
export function parseShareCode(input: string): string | null {
  if (!input) return null;
  const raw = canonicalize(input);
  if (raw.length !== SHARE_CODE_CHARS) return null;
  try {
    // Validate by round-tripping through the decoder.
    decodeBase32(raw);
  } catch {
    return null;
  }
  return dashFormat(raw);
}

/** Return the 10 raw bytes for a (possibly user-formatted) share code. */
export function shareCodeBytes(input: string): Uint8Array {
  const parsed = parseShareCode(input);
  if (!parsed) throw new Error("invalid share code");
  return decodeBase32(canonicalize(parsed));
}

/**
 * Derive the swarm info_hash from a share code:
 *   info_hash = SHA-1(code_bytes || INFO_HASH_CONTEXT)
 * Returns a 40-char lowercase hex string compatible with WebTorrent.
 */
export async function deriveInfoHash(input: string): Promise<string> {
  const codeBytes = shareCodeBytes(input);
  const ctx = new TextEncoder().encode(INFO_HASH_CONTEXT);
  const joined = new Uint8Array(codeBytes.length + ctx.length);
  joined.set(codeBytes, 0);
  joined.set(ctx, codeBytes.length);
  const digest = await crypto.subtle.digest("SHA-1", joined as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Derive the AES-256-GCM session key from a share code via HKDF-SHA256.
 * Returned `CryptoKey` is non-extractable and usable for encrypt/decrypt.
 */
export async function deriveSessionKey(input: string): Promise<CryptoKey> {
  const codeBytes = shareCodeBytes(input);
  const ikm = await crypto.subtle.importKey(
    "raw",
    codeBytes as BufferSource,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(SESSION_KEY_CONTEXT),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Raw 32-byte HKDF-SHA256 expansion. Mirrors the Rust `hkdf_sha256_32`
 * helper in `engine/share_code.rs` so both sides produce byte-identical
 * derivations for the same `(share_code, context)` pair.
 */
async function hkdfSha256Raw(codeBytes: Uint8Array, info: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    codeBytes as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    ikm,
    32 * 8,
  );
  return new Uint8Array(bits);
}

/** 32-byte session key as raw bytes (matches Rust `derive_session_key`). */
export async function deriveSessionKeyBytes(input: string): Promise<Uint8Array> {
  return hkdfSha256Raw(shareCodeBytes(input), SESSION_KEY_CONTEXT);
}

/** 32-byte gossipsub topic id (matches Rust `derive_gossip_topic`). */
export async function deriveGossipTopic(input: string): Promise<Uint8Array> {
  return hkdfSha256Raw(shareCodeBytes(input), GOSSIP_TOPIC_CONTEXT);
}

/** 32-byte libp2p Ed25519 identity seed (matches Rust `derive_libp2p_seed`). */
export async function deriveLibp2pSeed(input: string): Promise<Uint8Array> {
  return hkdfSha256Raw(shareCodeBytes(input), LIBP2P_SEED_CONTEXT);
}

/**
 * Cross-language parity vectors. These MUST equal the Rust outputs
 * printed by `engine::share_code::tests::known_vector_all_zero_share_code`
 * (run `cargo test -- --nocapture known_vector_all_zero_share_code`).
 *
 * If the Rust side outputs different bytes, one of the HKDF contexts
 * drifted. Fix immediately — peers built against the new context will
 * be invisible to peers built against the old one.
 *
 * Share code: "0000-0000-0000-0000" (10 zero bytes of entropy).
 */
export const PARITY_VECTORS_ZERO_SHARE_CODE = {
  shareCode: "0000-0000-0000-0000",
  sessionKeyHex:
    "9f7c46c1745a31bcb5d15a145714174d9ea660e3a41758c37e0e8c3655958b8d",
  gossipTopicHex:
    "080ebe146ffd30cea4bc1ba0a4e80905932990ca2ee7a27196c80f23e32ce584",
  libp2pSeedHex:
    "e0c75e4a4ec216a937abbe5e8d59cb5f07b76863c974a4f616d8e7fd08dafc80",
} as const;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
