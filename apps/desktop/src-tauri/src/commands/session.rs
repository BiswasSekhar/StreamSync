use std::sync::Arc;
use tauri::State;

use crate::state::{AppState, SessionState};

const SIGNALLING_PORT: u16 = 8787;

#[tauri::command]
pub async fn create_room(
    state: State<'_, Arc<AppState>>,
    _app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string().split('-').next().unwrap().to_uppercase();

    crate::engine::tunnel::stop_tunnel(&state).await;
    crate::engine::tunnel::kill_existing_cloudflared();

    let tunnel = crate::engine::tunnel::start_tunnel(SIGNALLING_PORT)
        .await
        .map_err(|e| e.to_string())?;
    let url_or_code = format!("{}/?room={}", tunnel.public_url, session_id);
    crate::engine::tunnel::set_running_tunnel(&state, tunnel).await;

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
    // Tell every signaller WS task that the host is gone so they can
    // send `host-ended` and close cleanly. Empty payload = all rooms.
    let _ = state.room_close_tx.send(String::new());

    crate::engine::tunnel::stop_tunnel(&state).await;
    let mut torrent_stream = state.torrent_stream.lock().await;
    *torrent_stream = None;
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

