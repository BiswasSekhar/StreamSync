//! Gossipsub message encoding/decoding for the libp2p signaling layer.
//!
//! Each broadcast payload is a [`GossipEnvelope`] serialized to JSON
//! and then sealed with [`super::session_cipher::SessionCipher`] (AES-256-GCM).
//! The cipher key comes from `share_code::derive_session_key`, so every
//! peer holding the share code can decrypt; nobody else can.
//!
//! ## Authenticity
//!
//! gossipsub's `MessageAuthenticity::Signed` already wraps each frame
//! with the sender's libp2p Ed25519 signature, so we can trust the
//! `source` peer-id on every received gossipsub event. The envelope's
//! `sender_peer_id` field is informational only — the dispatcher always
//! cross-checks against the gossipsub `source`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::session_cipher::SessionCipher;

/// Tag for the kind of payload carried by an envelope. Mirrors the TS
/// schema in `packages/shared/src/p2p-events.ts` (Phase 3+).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GossipKind {
    Presence,
    Sync,
    Chat,
    VideoReady,
    MagnetReady,
    JoinRequest,
    JoinDecision,
    HostEnded,
    /// WebRTC SDP offer (camera/mic conferencing signaling).
    WebrtcOffer,
    /// WebRTC SDP answer.
    WebrtcAnswer,
    /// WebRTC ICE candidate batch.
    WebrtcIce,
}

/// One application-level event carried over gossipsub.
///
/// The `payload` is opaque JSON the frontend deserializes per-kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GossipEnvelope {
    pub kind: GossipKind,
    /// libp2p PeerId of the original publisher, as a multibase string.
    /// Receivers MUST cross-check this against gossipsub's signed source.
    pub sender_peer_id: String,
    /// Optional target peer for directed signaling (e.g. webrtc-offer).
    /// `None` = broadcast.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_peer_id: Option<String>,
    /// Unique id — useful for deduplication if a frame ricochets through
    /// multiple gossipsub hops.
    pub id: String,
    /// Local wall-clock ms at publication.
    pub timestamp_ms: u64,
    pub payload: serde_json::Value,
}

impl GossipEnvelope {
    pub fn new(
        kind: GossipKind,
        sender_peer_id: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        let sender = sender_peer_id.into();
        Self {
            kind,
            sender_peer_id: sender.clone(),
            target_peer_id: None,
            id: make_envelope_id(&sender),
            timestamp_ms: super::super::state::unix_ms(),
            payload,
        }
    }

    pub fn with_target(mut self, target: impl Into<String>) -> Self {
        self.target_peer_id = Some(target.into());
        self
    }

    /// Encrypt to wire bytes using the share-code-derived cipher.
    pub fn seal(&self, cipher: &SessionCipher) -> Result<Vec<u8>> {
        let json = serde_json::to_vec(self).context("envelope serialize failed")?;
        cipher.encrypt(&json)
    }

    /// Decrypt + parse a wire frame.
    pub fn open(cipher: &SessionCipher, frame: &[u8]) -> Result<Self> {
        let plain = cipher.decrypt(frame)?;
        serde_json::from_slice(&plain).context("envelope deserialize failed")
    }
}

fn make_envelope_id(sender: &str) -> String {
    use rand::Rng;
    let now = super::super::state::unix_ms();
    let r: u64 = rand::thread_rng().gen();
    // Truncate sender to keep id under 64 chars.
    let short = sender.chars().take(12).collect::<String>();
    format!("{short}-{now:x}-{r:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::session_cipher::SessionCipher;

    fn key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = (i + 1) as u8;
        }
        k
    }

    #[test]
    fn round_trip_envelope() {
        let cipher = SessionCipher::new(&key());
        let env = GossipEnvelope::new(
            GossipKind::Chat,
            "12D3KooWAlice",
            serde_json::json!({ "text": "hi" }),
        );
        let wire = env.seal(&cipher).unwrap();
        let other = SessionCipher::new(&key());
        let decoded = GossipEnvelope::open(&other, &wire).unwrap();
        assert_eq!(decoded.kind, GossipKind::Chat);
        assert_eq!(decoded.payload["text"], "hi");
    }

    #[test]
    fn directed_envelope_carries_target() {
        let cipher = SessionCipher::new(&key());
        let env = GossipEnvelope::new(
            GossipKind::WebrtcOffer,
            "host",
            serde_json::json!({ "sdp": "v=0..." }),
        )
        .with_target("guest42");
        let wire = env.seal(&cipher).unwrap();
        let decoded = GossipEnvelope::open(&cipher, &wire).unwrap();
        assert_eq!(decoded.target_peer_id.as_deref(), Some("guest42"));
    }

    #[test]
    fn wrong_key_fails() {
        let alice = SessionCipher::new(&key());
        let mut wrong_key = key();
        wrong_key[0] ^= 0xff;
        let bob = SessionCipher::new(&wrong_key);
        let env = GossipEnvelope::new(GossipKind::Presence, "x", serde_json::json!({}));
        let wire = env.seal(&alice).unwrap();
        assert!(GossipEnvelope::open(&bob, &wire).is_err());
    }
}
