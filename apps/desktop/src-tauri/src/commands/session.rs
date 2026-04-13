use std::sync::Arc;
use tauri::State;

use crate::state::{AppState, SessionState};

#[tauri::command]
pub async fn create_room(
    state: State<'_, Arc<AppState>>,
    _app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string().split('-').next().unwrap().to_uppercase();
    let url_or_code = session_id.clone();

    // Store session state
    {
        let mut sess = state.session.lock().await;
        *sess = Some(SessionState {
            id: session_id.clone(),
            room_url: url_or_code.clone(),
            created_at: std::time::Instant::now(),
            magnet_link: None,
        });
    }

    Ok(url_or_code)
}

#[tauri::command]
pub async fn close_room(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut sess = state.session.lock().await;
    *sess = None;
    let mut peers = state.peers.lock().await;
    peers.clear();
    Ok(())
}

#[tauri::command]
pub async fn get_session_status(
    state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    let sess = state.session.lock().await;
    let enc = state.encoder.lock().await;
    let torrent = state.torrent.lock().await;
    let peers = state.peers.lock().await;

    Ok(serde_json::json!({
        "session": sess.as_ref().map(|s| serde_json::json!({
            "id": s.id,
            "roomUrl": s.room_url,
            "magnetLink": s.magnet_link,
        })),
        "encodeProgress": enc.progress,
        "encodeComplete": enc.encode_complete,
        "selectedEncoder": format!("{:?}", enc.selected_hw),
        "torrent": torrent.as_ref().map(|t| serde_json::json!({
            "magnetLink": t.magnet_link,
            "peerCount": t.peer_count,
            "uploadSpeedBps": t.upload_speed,
        })),
        "peerCount": peers.len(),
        "peers": peers.values().map(|p| serde_json::json!({
            "id": p.id,
            "displayName": p.display_name,
        })).collect::<Vec<_>>(),
    }))
}


