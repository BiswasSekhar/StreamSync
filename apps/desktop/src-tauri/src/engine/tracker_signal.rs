use anyhow::{anyhow, Context};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

pub const DEFAULT_TRACKERS: [&str; 4] = [
    "wss://tracker.webtorrent.dev",
    "wss://tracker.btorrent.xyz",
    "wss://tracker.files.fm:7073/announce",
    "wss://tracker.openwebtorrent.com",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SignallingMode {
    Tracker,
    Tunnel,
}

impl SignallingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SignallingMode::Tracker => "tracker",
            SignallingMode::Tunnel => "tunnel",
        }
    }

    pub fn parse(input: &str) -> Option<Self> {
        match input.trim().to_ascii_lowercase().as_str() {
            "tracker" => Some(SignallingMode::Tracker),
            "tunnel" => Some(SignallingMode::Tunnel),
            _ => None,
        }
    }
}

pub fn generate_info_hash_hex() -> String {
    let mut bytes = [0u8; 20];
    let a = *uuid::Uuid::new_v4().as_bytes();
    let b = *uuid::Uuid::new_v4().as_bytes();
    bytes[..16].copy_from_slice(&a);
    bytes[16..].copy_from_slice(&b[..4]);
    hex::encode(bytes)
}

pub fn generate_peer_id_hex() -> String {
    let mut bytes = [0u8; 20];
    let a = *uuid::Uuid::new_v4().as_bytes();
    let b = *uuid::Uuid::new_v4().as_bytes();
    bytes[..16].copy_from_slice(&a);
    bytes[16..].copy_from_slice(&b[..4]);
    hex::encode(bytes)
}

pub fn make_session_id_from_info_hash(info_hash_hex: &str) -> String {
    info_hash_hex
        .chars()
        .take(8)
        .collect::<String>()
        .to_ascii_uppercase()
}

pub fn normalize_share_code(input: &str) -> Option<String> {
    let cleaned = input
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect::<String>()
        .to_ascii_lowercase();

    if cleaned.len() == 40 {
        Some(cleaned)
    } else {
        None
    }
}

pub fn format_share_code(info_hash_hex: &str) -> String {
    let cleaned = normalize_share_code(info_hash_hex).unwrap_or_else(|| info_hash_hex.to_string());
    cleaned
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .collect::<Vec<_>>()
        .join("-")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerAnnounceRequest<'a> {
    pub action: &'static str,
    pub info_hash: &'a str,
    pub peer_id: &'a str,
    pub numwant: u32,
    pub offers: Vec<Value>,
}

/// Minimal tracker announce helper used by the Phase B migration.
///
/// This is intentionally isolated and currently best-effort: it sends an
/// announce payload and returns the first text frame that contains either an
/// `answer` or `offer` envelope.
pub async fn announce_once(
    tracker_url: &str,
    info_hash_hex: &str,
    peer_id_hex: &str,
    offers: Vec<Value>,
) -> anyhow::Result<Option<Value>> {
    let (mut ws, _) = connect_async(tracker_url)
        .await
        .with_context(|| format!("failed to connect tracker {}", tracker_url))?;

    let payload = TrackerAnnounceRequest {
        action: "announce",
        info_hash: info_hash_hex,
        peer_id: peer_id_hex,
        numwant: 1,
        offers,
    };

    ws.send(Message::Text(serde_json::to_string(&payload)?))
        .await
        .context("failed to send tracker announce")?;

    let read_timeout = tokio::time::Duration::from_secs(8);
    let result = tokio::time::timeout(read_timeout, async {
        while let Some(msg) = ws.next().await {
            let msg = msg.context("tracker stream error")?;
            match msg {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text)
                        .with_context(|| format!("invalid tracker json: {}", text))?;
                    if value.get("answer").is_some() || value.get("offer").is_some() {
                        return Ok::<Option<Value>, anyhow::Error>(Some(value));
                    }
                }
                Message::Binary(bin) => {
                    if let Ok(text) = std::str::from_utf8(&bin) {
                        if let Ok(value) = serde_json::from_str::<Value>(text) {
                            if value.get("answer").is_some() || value.get("offer").is_some() {
                                return Ok::<Option<Value>, anyhow::Error>(Some(value));
                            }
                        }
                    }
                }
                Message::Ping(payload) => {
                    let _ = ws.send(Message::Pong(payload)).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        Ok::<Option<Value>, anyhow::Error>(None)
    })
    .await
    .map_err(|_| anyhow!("tracker announce timed out after {}s", read_timeout.as_secs()))??;

    let _ = ws.close(None).await;
    Ok(result)
}
