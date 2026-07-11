//! Tauri commands for the libp2p signaling layer.
//!
//! Thin facade over [`crate::engine::libp2p_supervisor::SupervisorHandle`].
//! Each command sends a message on the actor's mpsc channel; the actor
//! task owns the swarm.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::engine::libp2p_gossip::GossipKind;
use crate::engine::libp2p_node::NodeRole;
use crate::engine::libp2p_supervisor::{self, DiagnosticsSnapshot, SupervisorHandle};
use crate::engine::session_cipher::SessionCipher;
use crate::engine::share_code::{
    derive_gossip_topic, derive_libp2p_seed, derive_session_key, parse_share_code,
};
use crate::engine::torrent_stream::{StreamableTorrent, TorrentStreamManager, TorrentVideoFile};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionResponse {
    pub peer_id: String,
    pub gossip_topic_hex: String,
    pub role: String,
}

#[tauri::command]
pub async fn p2p_start_session(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    share_code: String,
    is_host: bool,
) -> Result<StartSessionResponse, String> {
    let canonical = parse_share_code(&share_code).ok_or_else(|| "invalid share code".to_string())?;

    {
        let existing = state.p2p.lock().await;
        if existing.is_some() {
            return Err(
                "a p2p session is already running — call p2p_close_session first".into(),
            );
        }
    }

    let session_key = derive_session_key(&canonical).map_err(|e| e.to_string())?;
    let gossip_topic = derive_gossip_topic(&canonical).map_err(|e| e.to_string())?;
    let role = if is_host {
        NodeRole::Host
    } else {
        NodeRole::Guest
    };
    let seed = if is_host {
        Some(derive_libp2p_seed(&canonical).map_err(|e| e.to_string())?)
    } else {
        None
    };

    let cipher = Arc::new(SessionCipher::new(&session_key));
    let handle = libp2p_supervisor::spawn(app, role, seed, gossip_topic, cipher)
        .map_err(|e| e.to_string())?;

    let response = StartSessionResponse {
        peer_id: handle.local_peer_id.to_string(),
        gossip_topic_hex: handle.gossip_topic_hex.clone(),
        role: if is_host { "host".into() } else { "guest".into() },
    };

    *state.p2p.lock().await = Some(Arc::new(handle));
    Ok(response)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishEventArgs {
    pub kind: GossipKind,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishEventResponse {
    pub envelope_id: String,
}

#[tauri::command]
pub async fn p2p_publish_event(
    state: State<'_, Arc<AppState>>,
    args: PublishEventArgs,
) -> Result<PublishEventResponse, String> {
    let handle = current_handle(&state).await?;
    let envelope_id = handle
        .publish(args.kind, args.payload, args.target)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PublishEventResponse { envelope_id })
}

#[tauri::command]
pub async fn p2p_get_stats(
    state: State<'_, Arc<AppState>>,
) -> Result<DiagnosticsSnapshot, String> {
    let handle = current_handle(&state).await?;
    handle.diagnostics().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn p2p_close_session(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let handle = {
        let mut guard = state.p2p.lock().await;
        guard.take()
    };
    if let Some(handle) = handle {
        handle.shutdown().await;
    }
    Ok(())
}

async fn current_handle(state: &State<'_, Arc<AppState>>) -> Result<Arc<SupervisorHandle>, String> {
    let guard = state.p2p.lock().await;
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "no active p2p session — call p2p_start_session first".to_string())
}

// ─── Content layer (BitTorrent via librqbit) ──────────────────────────────────

/// Lazily build (or fetch) the shared torrent streaming manager.
async fn stream_manager(
    app: &tauri::AppHandle,
    state: &State<'_, Arc<AppState>>,
) -> Result<Arc<TorrentStreamManager>, String> {
    {
        let guard = state.torrent_stream_mgr.lock().await;
        if let Some(mgr) = guard.as_ref() {
            return Ok(mgr.clone());
        }
    }
    let download_dir = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("StreamSync")
        .join("p2p");
    let mgr = Arc::new(
        TorrentStreamManager::new(download_dir)
            .await
            .map_err(|e| e.to_string())?,
    );
    *state.torrent_stream_mgr.lock().await = Some(mgr.clone());
    Ok(mgr)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishFileResponse {
    pub info_hash: String,
    pub magnet: String,
    pub file_name: String,
    pub file_size: u64,
    pub duration_seconds: f64,
    pub mime_codec: String,
    /// Local file path — the host plays this directly (instant, fully seekable).
    pub local_path: String,
}

/// Host only. Seed the original file as-is (no transcode), probe metadata with
/// ffprobe, and broadcast a `video-ready` gossip event so guests can join.
#[tauri::command]
pub async fn p2p_publish_file(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    file_path: String,
) -> Result<PublishFileResponse, String> {
    let probe = crate::engine::ffmpeg::probe_video(&file_path)
        .await
        .map_err(|e| format!("probe failed: {e}"))?;

    let mgr = stream_manager(&app, &state).await?;
    let published = mgr
        .publish_file(&PathBuf::from(&file_path))
        .await
        .map_err(|e| e.to_string())?;

    *state.active_stream.lock().await = Some(published.clone());

    let payload = serde_json::json!({
        "magnet": published.magnet,
        "fileName": published.file_name,
        "fileSize": published.file_size,
        "durationSeconds": probe.duration_seconds,
        "mimeCodec": probe.codec_hint,
    });
    if let Some(handle) = state.p2p.lock().await.as_ref() {
        let _ = handle.publish(GossipKind::VideoReady, payload, None).await;
    }

    Ok(PublishFileResponse {
        info_hash: published.info_hash_hex,
        magnet: published.magnet,
        file_name: published.file_name,
        file_size: published.file_size,
        duration_seconds: probe.duration_seconds,
        mime_codec: probe.codec_hint,
        local_path: file_path,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMagnetResponse {
    pub info_hash: String,
    pub magnet: String,
    pub file_name: String,
    pub file_size: u64,
    pub selected_file_id: usize,
    pub video_files: Vec<TorrentVideoFile>,
    /// librqbit localhost stream URL — what mpv opens.
    pub stream_url: String,
}

impl From<&StreamableTorrent> for OpenMagnetResponse {
    fn from(torrent: &StreamableTorrent) -> Self {
        Self {
            info_hash: torrent.info_hash_hex.clone(),
            magnet: torrent.magnet.clone(),
            file_name: torrent.file_name.clone(),
            file_size: torrent.file_size,
            selected_file_id: torrent.file_id,
            video_files: torrent.video_files.clone(),
            stream_url: torrent.stream_url.clone(),
        }
    }
}

/// Host path for an existing public `.torrent` file. Unlike the legacy
/// downloader, this returns a seekable localhost stream immediately after
/// metadata initialization, so mpv can drive librqbit's piece priorities.
#[tauri::command]
pub async fn p2p_open_torrent_file(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    torrent_path: String,
) -> Result<OpenMagnetResponse, String> {
    let mgr = stream_manager(&app, &state).await?;
    let download_dir = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("StreamSync")
        .join("public")
        .join(uuid::Uuid::new_v4().to_string());

    let opened = mgr
        .open_torrent_file(&PathBuf::from(&torrent_path), download_dir)
        .await
        .map_err(|e| e.to_string())?;

    *state.active_stream.lock().await = Some(opened.clone());

    Ok(OpenMagnetResponse::from(&opened))
}

/// Either a guest joining the host's magnet, or anyone opening a public magnet.
/// Loads it into the shared session and (optionally) re-broadcasts
/// `magnet-ready` so co-watchers converge on the same swarm.
#[tauri::command]
pub async fn p2p_open_magnet(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    magnet: String,
    broadcast: bool,
) -> Result<OpenMagnetResponse, String> {
    let mgr = stream_manager(&app, &state).await?;
    let download_dir = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("StreamSync")
        .join("p2p")
        .join(uuid::Uuid::new_v4().to_string());

    let opened = mgr
        .open_magnet(&magnet, download_dir)
        .await
        .map_err(|e| e.to_string())?;

    *state.active_stream.lock().await = Some(opened.clone());

    if broadcast {
        if let Some(handle) = state.p2p.lock().await.as_ref() {
            let payload = serde_json::json!({
                "magnet": opened.magnet,
                "name": opened.file_name,
            });
            let _ = handle.publish(GossipKind::MagnetReady, payload, None).await;
        }
    }

    Ok(OpenMagnetResponse::from(&opened))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTorrentStats {
    pub download_speed_bps: u64,
    pub upload_speed_bps: u64,
    pub have_bytes: u64,
    pub total_bytes: u64,
    pub peer_count: u32,
}

#[tauri::command]
pub async fn p2p_get_active_torrent_stats(
    state: State<'_, Arc<AppState>>,
) -> Result<ActiveTorrentStats, String> {
    let active = state
        .active_stream
        .lock()
        .await
        .clone()
        .ok_or_else(|| "no active public torrent".to_string())?;
    let stats = active.handle.stats();
    let Some(live) = stats.live else {
        return Ok(ActiveTorrentStats {
            download_speed_bps: 0,
            upload_speed_bps: 0,
            have_bytes: 0,
            total_bytes: active.total_size,
            peer_count: 0,
        });
    };
    Ok(ActiveTorrentStats {
        download_speed_bps: (live.download_speed.mbps * 1_000_000.0 / 8.0) as u64,
        upload_speed_bps: (live.upload_speed.mbps * 1_000_000.0 / 8.0) as u64,
        have_bytes: live
            .snapshot
            .downloaded_and_checked_bytes
            .min(active.total_size),
        total_bytes: active.total_size,
        peer_count: live.snapshot.peer_stats.live as u32,
    })
}

#[tauri::command]
pub async fn p2p_select_torrent_video(
    state: State<'_, Arc<AppState>>,
    file_id: usize,
) -> Result<OpenMagnetResponse, String> {
    let manager = state
        .torrent_stream_mgr
        .lock()
        .await
        .clone()
        .ok_or_else(|| "torrent stream manager is not running".to_string())?;
    let active = state
        .active_stream
        .lock()
        .await
        .clone()
        .ok_or_else(|| "no active public torrent".to_string())?;
    let selected = manager
        .select_video(&active, file_id)
        .map_err(|error| error.to_string())?;
    *state.active_stream.lock().await = Some(selected.clone());
    Ok(OpenMagnetResponse::from(&selected))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathResponse {
    pub info_hash: String,
    pub file_name: String,
    /// What mpv opens: the librqbit localhost stream URL.
    pub stream_url: String,
}

/// Return the active torrent's stream URL (guests/public magnets). The host
/// uses the `local_path` from `p2p_publish_file` instead.
#[tauri::command]
pub async fn p2p_torrent_local_path(
    state: State<'_, Arc<AppState>>,
) -> Result<LocalPathResponse, String> {
    let guard = state.active_stream.lock().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| "no active torrent — publish or open a magnet first".to_string())?;
    Ok(LocalPathResponse {
        info_hash: s.info_hash_hex.clone(),
        file_name: s.file_name.clone(),
        stream_url: s.stream_url.clone(),
    })
}
