use std::sync::Arc;
use tauri::State;

use crate::state::{AppState, SessionState};

const SIGNALLING_PORT: u16 = 8787;

#[tauri::command]
pub async fn create_room(
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    // Kill any existing tunnel first
    crate::engine::tunnel::stop_tunnel(&state).await;
    // Kill any stale cloudflared from crashed sessions
    crate::engine::tunnel::kill_existing_cloudflared();

    // Start tunnel with reconnect
    let state_clone = Arc::clone(&state);
    let app_clone = app_handle.clone();
    tokio::spawn(crate::engine::tunnel::start_tunnel_with_reconnect(
        SIGNALLING_PORT,
        state_clone,
        app_clone,
    ));

    // Wait for tunnel URL (up to 45s)
    let mut retries = 0u32;
    let url = loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        let ts = state.tunnel.lock().await;
        if let Some(ref t) = *ts {
            break format!("{}/?room={}", t.public_url, session_id);
        }
        retries += 1;
        if retries > 90 {
            return Err("Timeout waiting for cloudflared tunnel".into());
        }
    };

    // Store session state
    {
        let mut sess = state.session.lock().await;
        *sess = Some(SessionState {
            id: session_id,
            room_url: url.clone(),
            created_at: std::time::Instant::now(),
            magnet_link: None,
        });
    }

    Ok(url)
}

#[tauri::command]
pub async fn close_room(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Stop the tunnel process
    crate::engine::tunnel::stop_tunnel(&state).await;

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
    let tunnel = state.tunnel.lock().await;

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
        "tunnelUrl": tunnel.as_ref().map(|t| &t.public_url),
    }))
}

#[tauri::command]
pub async fn send_host_sync(
    position: f64,
    playing: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::engine::webrtc::broadcast_sync(&state, position, playing)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn broadcast_chat(
    message: serde_json::Value,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let chat_msg: crate::state::ChatMessage = serde_json::from_value(message)
        .map_err(|e| e.to_string())?;
    crate::engine::webrtc::broadcast_chat(&state, &chat_msg)
        .await
        .map_err(|e| e.to_string())
}
