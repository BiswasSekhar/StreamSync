use std::sync::Arc;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn get_magnet(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    Ok(crate::engine::torrent::get_magnet_link(&state).await)
}

#[tauri::command]
pub async fn get_torrent_stats(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<serde_json::Value>, String> {
    Ok(crate::engine::torrent::get_torrent_stats(&state).await)
}

#[tauri::command]
pub async fn load_magnet_link(
    magnet_link: String,
    state: tauri::State<'_, Arc<AppState>>,
    current_file: tauri::State<'_, crate::engine::signaller::CurrentFilePath>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let download_dir = app_handle
        .path()
        .download_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("StreamSync");

    let state_clone = Arc::clone(&state);
    let current_file_clone = Arc::clone(current_file.inner());

    tokio::spawn(async move {
        if let Err(e) = crate::engine::torrent::load_magnet(
            magnet_link,
            download_dir,
            state_clone,
            app_handle,
            current_file_clone,
        )
        .await
        {
            tracing::error!("Magnet link load error: {:?}", e);
        }
    });

    Ok(())
}
