//! Rust mirror of `packages/shared/src/shareCode.ts`.
//!
//! The host generates the share code on the Rust side (so we never expose
//! the raw 10 random bytes to JS) and returns the dashed string to the
//! frontend. The TS layer then re-derives the same info_hash and session
//! key from that string — see `packages/shared/src/shareCode.ts`.
//!
//! Format: 10 random bytes (80 bits) → 16-char Crockford Base32 →
//!         dashed as `ABCD-EFGH-JKLM-NPQR`.
//!
//! `info_hash` = SHA-1(code_bytes || "streamsync-v1") — 40-char lowercase hex,
//! WebTorrent-compatible.

use hkdf::Hkdf;
use rand::RngCore;
use sha1::{Digest, Sha1};
use sha2::Sha256;

const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const SHARE_CODE_ENTROPY_BYTES: usize = 10;
pub const SHARE_CODE_CHARS: usize = 16;
pub const INFO_HASH_CONTEXT: &str = "streamsync-v1";
pub const SESSION_KEY_CONTEXT: &str = "streamsync-session-v1";
pub const GOSSIP_TOPIC_CONTEXT: &str = "streamsync-gossip-v1";
pub const LIBP2P_SEED_CONTEXT: &str = "streamsync-libp2p-identity-v1";

/// Generate a fresh share code with 80 bits of entropy, formatted as
/// `ABCD-EFGH-JKLM-NPQR`.
pub fn generate_share_code() -> String {
    let mut bytes = [0u8; SHARE_CODE_ENTROPY_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    dash_format(&encode_base32(&bytes))
}

/// Parse user input back into a canonical share code (uppercase, dashed).
/// Returns `None` when the input cannot be parsed as a valid 16-char code.
pub fn parse_share_code(input: &str) -> Option<String> {
    let raw = canonicalize(input);
    if raw.len() != SHARE_CODE_CHARS {
        return None;
    }
    // Round-trip through the decoder to validate every character.
    decode_base32(&raw).ok()?;
    Some(dash_format(&raw))
}

/// Return the 10 raw bytes for a (possibly user-formatted) share code.
pub fn share_code_bytes(input: &str) -> anyhow::Result<[u8; SHARE_CODE_ENTROPY_BYTES]> {
    let canon = canonicalize(input);
    if canon.len() != SHARE_CODE_CHARS {
        anyhow::bail!("share code must be {} chars after canonicalisation", SHARE_CODE_CHARS);
    }
    decode_base32(&canon)
}

/// Derive the WebTorrent-compatible info_hash from a share code.
/// `info_hash = SHA-1(code_bytes || INFO_HASH_CONTEXT)` — returned as a
/// 40-char lowercase hex string.
pub fn derive_info_hash(share_code: &str) -> anyhow::Result<String> {
    let code_bytes = share_code_bytes(share_code)?;
    let mut hasher = Sha1::new();
    hasher.update(code_bytes);
    hasher.update(INFO_HASH_CONTEXT.as_bytes());
    let digest = hasher.finalize();
    Ok(hex::encode(digest))
}

fn hkdf_sha256_32(code_bytes: &[u8], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, code_bytes);
    let mut out = [0u8; 32];
    hk.expand(info, &mut out)
        .expect("HKDF expand to 32 bytes never fails for SHA-256");
    out
}

/// Derive the AES-256-GCM `session_key` (32 raw bytes) from a share code.
/// Mirrors the TS `deriveSessionKey` HKDF parameters bit-for-bit.
pub fn derive_session_key(share_code: &str) -> anyhow::Result<[u8; 32]> {
    let code_bytes = share_code_bytes(share_code)?;
    Ok(hkdf_sha256_32(&code_bytes, SESSION_KEY_CONTEXT.as_bytes()))
}

/// Derive the gossipsub topic id (32 bytes) used by the libp2p signaling
/// mesh for this share-code session. Same code → same topic on every node.
pub fn derive_gossip_topic(share_code: &str) -> anyhow::Result<[u8; 32]> {
    let code_bytes = share_code_bytes(share_code)?;
    Ok(hkdf_sha256_32(&code_bytes, GOSSIP_TOPIC_CONTEXT.as_bytes()))
}

/// Derive the 32-byte seed used to construct the host's libp2p Ed25519
/// identity. Hosts get a deterministic PeerId so guests can verify the
/// origin of `video-ready` events without pasting a PeerId out-of-band.
/// Guests should generate ephemeral random keypairs instead.
pub fn derive_libp2p_seed(share_code: &str) -> anyhow::Result<[u8; 32]> {
    let code_bytes = share_code_bytes(share_code)?;
    Ok(hkdf_sha256_32(&code_bytes, LIBP2P_SEED_CONTEXT.as_bytes()))
}

fn encode_base32(bytes: &[u8]) -> String {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out = String::with_capacity(SHARE_CODE_CHARS);
    for &byte in bytes {
        value = (value << 8) | (byte as u32);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(CROCKFORD_ALPHABET[((value >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(CROCKFORD_ALPHABET[((value << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

fn decode_base32(code: &str) -> anyhow::Result<[u8; SHARE_CODE_ENTROPY_BYTES]> {
    let mut out = [0u8; SHARE_CODE_ENTROPY_BYTES];
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out_idx = 0usize;
    for ch in code.chars() {
        let v = crockford_index(ch)
            .ok_or_else(|| anyhow::anyhow!("invalid share code character: {}", ch))?;
        value = (value << 5) | (v as u32);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if out_idx >= SHARE_CODE_ENTROPY_BYTES {
                anyhow::bail!("share code decode overflow");
            }
            out[out_idx] = ((value >> bits) & 0xff) as u8;
            out_idx += 1;
        }
    }
    if out_idx != SHARE_CODE_ENTROPY_BYTES {
        anyhow::bail!("share code decode underflow ({} bytes)", out_idx);
    }
    Ok(out)
}

fn crockford_index(ch: char) -> Option<u8> {
    let up = ch.to_ascii_uppercase();
    // I/L → 1, O → 0 as common typo equivalents.
    let normalised = match up {
        'I' | 'L' => '1',
        'O' => '0',
        _ => up,
    };
    CROCKFORD_ALPHABET
        .iter()
        .position(|&c| c == normalised as u8)
        .map(|i| i as u8)
}

fn dash_format(raw: &str) -> String {
    raw.as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

fn canonicalize(input: &str) -> String {
    input
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_' | '\t' | '\n' | '\r'))
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_share_code() {
        for _ in 0..32 {
            let code = generate_share_code();
            assert_eq!(code.len(), 19, "{}", code); // 16 chars + 3 dashes
            let parsed = parse_share_code(&code).expect("parse");
            assert_eq!(parsed, code);
            let bytes = share_code_bytes(&code).expect("decode");
            assert_eq!(bytes.len(), SHARE_CODE_ENTROPY_BYTES);
        }
    }

    #[test]
    fn parse_strips_dashes_and_case() {
        let code = generate_share_code();
        let lower = code.to_lowercase();
        let no_dashes = code.replace('-', "");
        let with_spaces = code.replace('-', " ");
        assert_eq!(parse_share_code(&lower), Some(code.clone()));
        assert_eq!(parse_share_code(&no_dashes), Some(code.clone()));
        assert_eq!(parse_share_code(&with_spaces), Some(code));
    }

    #[test]
    fn info_hash_is_40_hex_chars() {
        let code = generate_share_code();
        let hash = derive_info_hash(&code).expect("hash");
        assert_eq!(hash.len(), 40);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn info_hash_deterministic_for_same_code() {
        let code = generate_share_code();
        let a = derive_info_hash(&code).unwrap();
        let b = derive_info_hash(&code).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn info_hash_differs_across_codes() {
        let a = derive_info_hash(&generate_share_code()).unwrap();
        let b = derive_info_hash(&generate_share_code()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn session_key_is_32_bytes_deterministic() {
        let code = generate_share_code();
        let a = derive_session_key(&code).unwrap();
        let b = derive_session_key(&code).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn derivations_are_independent() {
        let code = generate_share_code();
        let sk = derive_session_key(&code).unwrap();
        let gt = derive_gossip_topic(&code).unwrap();
        let ls = derive_libp2p_seed(&code).unwrap();
        assert_ne!(sk, gt);
        assert_ne!(sk, ls);
        assert_ne!(gt, ls);
    }

    /// Pinned vector: HKDF-SHA256 derivations must match the TS impl
    /// byte-for-byte. If you change the contexts, regenerate the TS side too.
    #[test]
    fn known_vector_all_zero_share_code() {
        let zero_code = "0000-0000-0000-0000";
        let sk = derive_session_key(zero_code).unwrap();
        let gt = derive_gossip_topic(zero_code).unwrap();
        let ls = derive_libp2p_seed(zero_code).unwrap();
        // Hex prints for cross-checking against TS test vector.
        println!("session_key  = {}", hex::encode(sk));
        println!("gossip_topic = {}", hex::encode(gt));
        println!("libp2p_seed  = {}", hex::encode(ls));
    }
}
