use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum StreamSyncError {
    #[error("No video file provided")]
    NoFile,

    #[error("Unsupported video format: {codec}")]
    UnsupportedCodec { codec: String },

    #[error("FFmpeg encode failed: {reason}")]
    EncodeFailed { reason: String },

    #[error("No hardware encoder available, using software")]
    SoftwareFallback,

    #[error("Torrent creation failed: {reason}")]
    TorrentFailed { reason: String },

    #[error("Tunnel failed to start: {reason}")]
    TunnelFailed { reason: String },

    #[error("Tunnel disconnected unexpectedly")]
    TunnelDisconnected,

    #[error("WebRTC peer connection failed for peer {peer_id}")]
    PeerConnectionFailed { peer_id: String },

    #[error("Room is full (max 8 receivers)")]
    RoomFull,

    #[error("IO error: {0}")]
    Io(String),

    #[error("Anyhow error: {0}")]
    Anyhow(String),

    #[error("JSON error: {0}")]
    Json(String),
}

impl From<std::io::Error> for StreamSyncError {
    fn from(e: std::io::Error) -> Self {
        StreamSyncError::Io(e.to_string())
    }
}

impl From<anyhow::Error> for StreamSyncError {
    fn from(e: anyhow::Error) -> Self {
        StreamSyncError::Anyhow(e.to_string())
    }
}

impl From<serde_json::Error> for StreamSyncError {
    fn from(e: serde_json::Error) -> Self {
        StreamSyncError::Json(e.to_string())
    }
}

// Allow using StreamSyncError as a Tauri command return value
impl From<StreamSyncError> for String {
    fn from(e: StreamSyncError) -> Self {
        e.to_string()
    }
}
