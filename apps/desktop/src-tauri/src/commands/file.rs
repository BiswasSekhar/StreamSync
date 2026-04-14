use std::sync::Arc;
use tauri::State;
use tauri::Manager as _;

use crate::engine::ffmpeg::{probe_video, extract_subtitle, VideoProbeResult, start_remux_pipeline, start_encode_pipeline};
use crate::state::AppState;
use crate::engine::signaller::CurrentFilePath;

#[tauri::command]
pub async fn probe_file(
    path: String,
    _state: State<'_, Arc<AppState>>,
) -> Result<VideoProbeResult, String> {
    probe_video(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn extract_subtitle_command(
    path: String,
    stream_index: usize,
) -> Result<String, String> {
    extract_subtitle(&path, stream_index).await.map_err(|e| e.to_string())
}

/// Load a .torrent file and start downloading it from the swarm.
/// Emits `magnet-ready` immediately, then `torrent-video-ready` once the
/// first video piece lands on disk so the /host-video endpoint can stream it.
#[tauri::command]
pub async fn load_torrent_file(
    path: String,
    state: State<'_, Arc<AppState>>,
    current_file: State<'_, CurrentFilePath>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let torrent_path = std::path::PathBuf::from(&path);

    {
        let mut guard = current_file.write().await;
        *guard = None;
    }

    // Resolve download directory: prefer system Downloads, fall back to temp
    let download_dir = app_handle
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("StreamSync")
        .join("torrent-source")
        .join(uuid::Uuid::new_v4().to_string());

    let state_clone = Arc::clone(&state);
    let current_file_clone = Arc::clone(current_file.inner());

    tokio::spawn(async move {
        if let Err(e) = crate::engine::torrent::load_external_torrent(
            torrent_path,
            download_dir,
            state_clone,
            app_handle,
            current_file_clone,
        )
        .await
        {
            tracing::error!("External torrent load error: {:?}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn start_seeding_original(
    path: String,
    state: State<'_, Arc<AppState>>,
    current_file: State<'_, CurrentFilePath>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // Update shared file path so /host-video can serve it
    {
        let mut guard = current_file.write().await;
        *guard = Some(path.clone());
    }

    let state_clone = Arc::clone(&state);
    let file_path = std::path::PathBuf::from(path);

    tokio::spawn(async move {
        if let Err(e) = crate::engine::torrent::start_seeding(file_path, state_clone, app_handle).await {
            tracing::error!("Torrent seeding error: {:?}", e);
        }
    });

    Ok(())
}

/// Prepare a video file for DataChannel streaming.
/// Routes to the correct pipeline based on the probe result:
///  - No transcode & no remux: serve the original file with a fast fMP4 fragmentation pass
///  - Needs remux (H.264/HEVC in non-MP4 container): FFmpeg -c copy to fMP4 (seconds)
///  - Needs transcode: full hardware-accelerated encode (minutes)
/// Returns immediately; emits `encode-complete` when the file is ready to serve.
#[tauri::command]
pub async fn prepare_video_for_streaming(
    path: String,
    state: State<'_, Arc<AppState>>,
    current_file: State<'_, CurrentFilePath>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let probe = probe_video(&path).await.map_err(|e| e.to_string())?;

    let state_clone = Arc::clone(&state);
    let cf_clone = Arc::clone(current_file.inner());
    let path_clone = path.clone();

    if probe.needs_transcode {
        // Full re-encode path — pick best available hardware encoder
        let hw = {
            let enc = state.encoder.lock().await;
            enc.selected_hw.clone()
        };
        tokio::spawn(async move {
            if let Err(e) = start_encode_pipeline(path_clone, hw, state_clone, app_handle, cf_clone).await {
                tracing::error!("Encode pipeline error: {:?}", e);
            }
        });
    } else {
        // Remux path (or fast fragmentation pass for already-MP4 files)
        // Point the server at the original immediately so the UI can proceed
        {
            let mut guard = current_file.write().await;
            *guard = Some(path.clone());
        }
        tokio::spawn(async move {
            if let Err(e) = start_remux_pipeline(path_clone, state_clone, app_handle, cf_clone).await {
                tracing::error!("Remux pipeline error: {:?}", e);
            }
        });
    }

    Ok(())
}
