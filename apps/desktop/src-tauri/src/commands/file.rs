use std::sync::Arc;
use tauri::State;

use crate::engine::ffmpeg::{probe_video, extract_subtitle, VideoProbeResult};
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
