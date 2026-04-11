use std::sync::Arc;
use tauri::State;

use crate::engine::ffmpeg::{probe_video, VideoProbeResult};
use crate::state::AppState;

#[tauri::command]
pub async fn probe_file(
    path: String,
    _state: State<'_, Arc<AppState>>,
) -> Result<VideoProbeResult, String> {
    probe_video(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_seeding_original(
    path: String,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let state_clone = Arc::clone(&state);
    let file_path = std::path::PathBuf::from(path);

    tokio::spawn(async move {
        if let Err(e) = crate::engine::torrent::start_seeding(file_path, state_clone, app_handle).await {
            tracing::error!("Torrent seeding error: {:?}", e);
        }
    });

    Ok(())
}
