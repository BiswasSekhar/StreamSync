use std::sync::Arc;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn get_tunnel_url(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let ts = state.tunnel.lock().await;
    Ok(ts.as_ref().map(|t| t.public_url.clone()))
}

#[tauri::command]
pub async fn check_cloudflared() -> Result<bool, String> {
    Ok(crate::engine::tunnel::get_cloudflared_path().is_ok())
}
