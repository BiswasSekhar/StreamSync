//! Rust mirror of `packages/shared/src/crypto.ts`.
//!
//! Encrypted envelope used to E2E-protect every gossip payload (and
//! eventually any other channel keyed off the share code). The wire
//! format is byte-identical to the TS impl so a frame produced on one
//! side decrypts cleanly on the other.
//!
//! Frame layout:
//!
//! ```text
//! [1 byte  version=1]
//! [4 bytes salt]            ← random per cipher instance
//! [8 bytes counter big-endian] ← monotonic per-send
//! [N bytes ciphertext]
//! [16 bytes auth tag]        ← included inside ciphertext for AES-GCM
//! ```
//!
//! Nonce = `salt || counter` (12 bytes — AES-GCM standard).
//!
//! ## Replay protection
//!
//! Decryption tracks the highest counter seen per remote salt and
//! rejects equal-or-lower counters. For gossipsub broadcast, the same
//! sender's frames must produce monotonically increasing counters; if
//! we later add a sender-keyed variant the existing TS impl must be
//! updated in lockstep (see plan risk #6).

use std::collections::HashMap;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use rand::RngCore;

pub const SESSION_CIPHER_VERSION: u8 = 1;
pub const NONCE_SALT_BYTES: usize = 4;
pub const NONCE_COUNTER_BYTES: usize = 8;
pub const NONCE_BYTES: usize = NONCE_SALT_BYTES + NONCE_COUNTER_BYTES;
pub const AUTH_TAG_BYTES: usize = 16;
pub const FRAME_HEADER_BYTES: usize = 1 + NONCE_SALT_BYTES + NONCE_COUNTER_BYTES;

/// Symmetric AES-256-GCM cipher with per-instance salt + monotonic
/// counter. Cheap to clone the `Arc` form via `Arc::new(SessionCipher::new(...))`.
pub struct SessionCipher {
    cipher: Aes256Gcm,
    salt: [u8; NONCE_SALT_BYTES],
    counter: Mutex<u64>,
    seen: Mutex<HashMap<[u8; NONCE_SALT_BYTES], u64>>,
}

impl SessionCipher {
    /// Construct from 32 raw key bytes (e.g. `share_code::derive_session_key`).
    /// The salt is randomized fresh per instance — re-instantiating gives a
    /// new sender identity from the peer's replay tracker's perspective.
    pub fn new(key_bytes: &[u8; 32]) -> Self {
        let key = Key::<Aes256Gcm>::from_slice(key_bytes);
        let cipher = Aes256Gcm::new(key);
        let mut salt = [0u8; NONCE_SALT_BYTES];
        rand::thread_rng().fill_bytes(&mut salt);
        Self {
            cipher,
            salt,
            counter: Mutex::new(0),
            seen: Mutex::new(HashMap::new()),
        }
    }

    pub fn salt(&self) -> [u8; NONCE_SALT_BYTES] {
        self.salt
    }

    /// Encrypt a plaintext frame. Returns the binary envelope.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let counter = {
            let mut guard = self.counter.lock().expect("counter mutex poisoned");
            let next = *guard;
            *guard = guard
                .checked_add(1)
                .ok_or_else(|| anyhow!("session cipher counter overflow"))?;
            next
        };

        let nonce_bytes = build_nonce(&self.salt, counter);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = self
            .cipher
            .encrypt(nonce, Payload { msg: plaintext, aad: &[] })
            .map_err(|e| anyhow!("AES-GCM encrypt failed: {e}"))?;

        let mut out = Vec::with_capacity(FRAME_HEADER_BYTES + ct.len());
        out.push(SESSION_CIPHER_VERSION);
        out.extend_from_slice(&self.salt);
        out.extend_from_slice(&counter.to_be_bytes());
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// Decrypt an inbound envelope. Returns the raw plaintext bytes.
    /// Tracks the highest counter per remote salt and rejects replays.
    pub fn decrypt(&self, envelope: &[u8]) -> Result<Vec<u8>> {
        if envelope.len() < FRAME_HEADER_BYTES + AUTH_TAG_BYTES {
            bail!("envelope too small ({} bytes)", envelope.len());
        }
        if envelope[0] != SESSION_CIPHER_VERSION {
            bail!("unsupported cipher version: {}", envelope[0]);
        }
        let mut remote_salt = [0u8; NONCE_SALT_BYTES];
        remote_salt.copy_from_slice(&envelope[1..1 + NONCE_SALT_BYTES]);
        let counter = u64::from_be_bytes(
            envelope[1 + NONCE_SALT_BYTES..FRAME_HEADER_BYTES]
                .try_into()
                .expect("8 bytes by slice length"),
        );

        {
            let seen = self.seen.lock().expect("seen mutex poisoned");
            if let Some(&last) = seen.get(&remote_salt) {
                if counter <= last {
                    bail!(
                        "replay: counter {} <= last {} (salt {})",
                        counter,
                        last,
                        hex::encode(remote_salt)
                    );
                }
            }
        }

        let nonce_bytes = build_nonce(&remote_salt, counter);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let pt = self
            .cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &envelope[FRAME_HEADER_BYTES..],
                    aad: &[],
                },
            )
            .map_err(|e| anyhow!("AES-GCM decrypt failed: {e}"))?;

        self.seen
            .lock()
            .expect("seen mutex poisoned")
            .insert(remote_salt, counter);

        Ok(pt)
    }

    /// Decrypt and deserialize a JSON frame.
    pub fn decrypt_json<T: serde::de::DeserializeOwned>(&self, envelope: &[u8]) -> Result<T> {
        let bytes = self.decrypt(envelope)?;
        serde_json::from_slice(&bytes).context("envelope payload was not valid JSON")
    }
}

fn build_nonce(salt: &[u8; NONCE_SALT_BYTES], counter: u64) -> [u8; NONCE_BYTES] {
    let mut nonce = [0u8; NONCE_BYTES];
    nonce[..NONCE_SALT_BYTES].copy_from_slice(salt);
    nonce[NONCE_SALT_BYTES..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8;
        }
        k
    }

    #[test]
    fn round_trip() {
        let cipher = SessionCipher::new(&fixed_key());
        let frame = cipher.encrypt(b"hello world").unwrap();
        let pt = cipher.decrypt(&frame).unwrap();
        assert_eq!(pt, b"hello world");
    }

    #[test]
    fn two_ciphers_can_decrypt_each_others_frames() {
        // Same key → frames sent by one are accepted by the other.
        let alice = SessionCipher::new(&fixed_key());
        let bob = SessionCipher::new(&fixed_key());
        let frame = alice.encrypt(b"from alice").unwrap();
        let pt = bob.decrypt(&frame).unwrap();
        assert_eq!(pt, b"from alice");
    }

    #[test]
    fn rejects_replay() {
        let alice = SessionCipher::new(&fixed_key());
        let bob = SessionCipher::new(&fixed_key());
        let frame = alice.encrypt(b"once").unwrap();
        bob.decrypt(&frame).unwrap();
        assert!(bob.decrypt(&frame).is_err(), "replay must be rejected");
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let alice = SessionCipher::new(&fixed_key());
        let bob = SessionCipher::new(&fixed_key());
        let mut frame = alice.encrypt(b"important").unwrap();
        // Flip a bit in the ciphertext portion.
        let last = frame.len() - AUTH_TAG_BYTES - 1;
        frame[last] ^= 0x01;
        assert!(bob.decrypt(&frame).is_err());
    }

    #[test]
    fn rejects_wrong_version() {
        let alice = SessionCipher::new(&fixed_key());
        let bob = SessionCipher::new(&fixed_key());
        let mut frame = alice.encrypt(b"x").unwrap();
        frame[0] = 99;
        assert!(bob.decrypt(&frame).is_err());
    }

    #[test]
    fn counter_monotonic_and_unique() {
        let alice = SessionCipher::new(&fixed_key());
        let f1 = alice.encrypt(b"a").unwrap();
        let f2 = alice.encrypt(b"b").unwrap();
        // Counters differ → nonces differ → ciphertexts differ even for same key.
        assert_ne!(f1, f2);
    }
}
