use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

/// Available hardware encoders, ordered by speed
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub enum HwEncoder {
    Nvenc,         // NVIDIA
    Amf,           // AMD
    VideoToolbox,  // Apple
    Qsv,           // Intel
    Software,      // libx264 fallback
}

impl HwEncoder {
    pub fn codec_name(&self) -> &'static str {
        match self {
            HwEncoder::Nvenc => "h264_nvenc",
            HwEncoder::VideoToolbox => "h264_videotoolbox",
            HwEncoder::Qsv => "h264_qsv",
            HwEncoder::Amf => "h264_amf",
            HwEncoder::Software => "libx264",
        }
    }

    pub fn preset(&self) -> &'static str {
        match self {
            HwEncoder::Nvenc => "p4",
            HwEncoder::VideoToolbox => "default",
            HwEncoder::Qsv => "veryfast",
            HwEncoder::Amf => "speed",
            HwEncoder::Software => "veryfast",
        }
    }

    pub fn extra_args(&self) -> Vec<(&'static str, &'static str)> {
        match self {
            HwEncoder::Nvenc => vec![
                ("-rc", "vbr"),
                ("-b_ref_mode", "0"),
                ("-zerolatency", "1"),
            ],
            HwEncoder::VideoToolbox => vec![
                ("-allow_sw", "0"),
                ("-realtime", "1"),
            ],
            HwEncoder::Software => vec![
                ("-threads", "0"),
                ("-tune", "fastdecode"),
            ],
            _ => vec![],
        }
    }

    pub fn speed_factor(&self) -> f32 {
        match self {
            HwEncoder::Nvenc => 15.0,
            HwEncoder::VideoToolbox => 12.0,
            HwEncoder::Qsv => 8.0,
            HwEncoder::Amf => 10.0,
            HwEncoder::Software => 1.0,
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeProgress {
    pub percent: f64,
    pub fps: f64,
    pub eta_seconds: u64,
    pub encoder: String,
    pub output_size_bytes: u64,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub from: String,
    pub text: String,
    pub timestamp: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct SyncMessage {
    pub position: f64,
    pub playing: bool,
    pub timestamp: u64,
    pub sequence: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AppEvent {
    EncodeProgress(EncodeProgress),
    TorrentPieceReady {
        piece: u32,
        magnet_ready: bool,
    },
    MagnetReady {
        magnet: String,
    },
    TorrentProgress {
        download_speed_bps: u64,
        have_bytes: u64,
        total_bytes: u64,
        peer_count: u32,
    },
    PeerJoined {
        peer_id: String,
        display_name: String,
    },
    PeerLeft {
        peer_id: String,
    },
    ChatMessage(ChatMessage),
    EncodeComplete,
    EncoderFallback {
        encoder: String,
    },
    EncodeError {
        message: String,
    },
    Error {
        message: String,
    },
}

pub struct SessionState {
    pub id: String,
    pub mode: String,
    pub share_code: String,
    pub room_url: String,
    pub fallback_url: Option<String>,
    pub created_at: std::time::Instant,
    pub magnet_link: Option<String>,
}

pub struct EncoderState {
    pub available_hw: Vec<HwEncoder>,
    pub selected_hw: HwEncoder,
    pub progress: Option<EncodeProgress>,
    pub output_path: Option<std::path::PathBuf>,
    pub encode_complete: bool,
}

impl Default for EncoderState {
    fn default() -> Self {
        EncoderState {
            available_hw: vec![HwEncoder::Software],
            selected_hw: HwEncoder::Software,
            progress: None,
            output_path: None,
            encode_complete: false,
        }
    }
}

pub struct TorrentState {
    pub magnet_link: String,
    pub piece_count: u32,
    pub pieces_ready: u32,
    pub upload_speed: u64,
    pub download_speed: u64,
    pub peer_count: u32,
    /// true = seeding local file; false = downloading from external torrent
    pub is_seeder: bool,
    /// display name of the video file (set for external torrents)
    pub file_name: Option<String>,
}

#[derive(Clone)]
pub struct TorrentStreamSource {
    pub handle: Arc<librqbit::ManagedTorrent>,
    pub file_id: usize,
    pub content_type: String,
}

pub struct TunnelState {
    pub public_url: String,
    pub child_pid: Option<u32>,
}

pub struct PeerState {
    pub id: String,
    pub display_name: String,
    pub connected_at: std::time::Instant,
    pub video_position: f64,
    // Data channel sender stored as JSON string sender
    pub data_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

pub struct SignallerState {
    pub port: u16,
}

pub struct AppState {
    pub session: Mutex<Option<SessionState>>,
    pub encoder: Mutex<EncoderState>,
    pub torrent: Mutex<Option<TorrentState>>,
    pub signaller: Mutex<Option<SignallerState>>,
    pub tunnel: Mutex<Option<TunnelState>>,
    pub tunnel_child: Mutex<Option<tokio::process::Child>>,
    pub peers: Mutex<HashMap<String, PeerState>>,
    pub torrent_stream: Mutex<Option<TorrentStreamSource>>,
    pub event_tx: broadcast::Sender<AppEvent>,
    /// Broadcasts a `host-ended` notification. Signaller WS tasks
    /// subscribe on connect and close cleanly when they receive a
    /// matching room id (or an empty string for "all rooms").
    pub room_close_tx: broadcast::Sender<String>,
    pub sync_sequence: std::sync::atomic::AtomicU64,
}

impl AppState {
    pub fn new() -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(256);
        let (room_close_tx, _) = broadcast::channel(16);
        Arc::new(AppState {
            session: Mutex::new(None),
            encoder: Mutex::new(EncoderState::default()),
            torrent: Mutex::new(None),
            signaller: Mutex::new(None),
            tunnel: Mutex::new(None),
            tunnel_child: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            torrent_stream: Mutex::new(None),
            event_tx,
            room_close_tx,
            sync_sequence: std::sync::atomic::AtomicU64::new(0),
        })
    }

    pub fn emit(&self, event: AppEvent) {
        let _ = self.event_tx.send(event);
    }
}

pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
