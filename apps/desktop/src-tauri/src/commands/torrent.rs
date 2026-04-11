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
