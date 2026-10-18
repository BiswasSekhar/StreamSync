use std::sync::Arc;
use tauri::State;

use crate::state::{AppState, SessionState};
use crate::engine::tracker_signal::{self, SignallingMode};

const SIGNALLING_PORT: u16 = 8787;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoomResponse {
    pub session_id: String,
    pub share_code: String,
    pub tracker_info_hash: String,
    pub fallback_url: Option<String>,
    pub mode: String,
    pub tracker_urls: Vec<String>,
}

#[tauri::command]
pub async fn create_room(
    state: State<'_, Arc<AppState>>,
    _app_handle: tauri::AppHandle,
    mode: Option<String>,
) -> Result<CreateRoomResponse, String> {
    let selected_mode = mode
        .as_deref()
        .and_then(SignallingMode::parse)
        .unwrap_or(SignallingMode::Tracker);

    crate::engine::tunnel::stop_tunnel(&state).await;

    // The Crockford code is the only user-facing room identity. The tracker
    // hash is derived from it and remains an implementation detail used by
    // the WebTorrent signalling adapter.
    let share_code = crate::engine::share_code::generate_share_code();
    let info_hash = crate::engine::share_code::derive_info_hash(&share_code)
        .map_err(|e| format!("derive tracker identity: {e}"))?;
    let session_id = tracker_signal::make_session_id_from_info_hash(&info_hash);

    let (room_url, fallback_url, tracker_urls) = match selected_mode {
        SignallingMode::Tracker => {
            let room_url = format!("tracker://{}", info_hash);
            let trackers = tracker_signal::DEFAULT_TRACKERS
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>();
            (room_url, None, trackers)
        }
        SignallingMode::Tunnel => {
            let tunnel = crate::engine::tunnel::start_tunnel(SIGNALLING_PORT)
                .await
                .map_err(|e| e.to_string())?;
            let public_url = tunnel.public_url.clone();
            let room_url = format!(
                "{}/?room={}",
                public_url,
                urlencoding::encode(&share_code)
            );
            crate::engine::tunnel::set_running_tunnel(&state, tunnel).await;

            (room_url.clone(), Some(room_url), vec![])
        }
    };

    // Store session state
    {
        let mut sess = state.session.lock().await;
        *sess = Some(SessionState {
            id: session_id.clone(),
            mode: selected_mode.as_str().to_string(),
            share_code: share_code.clone(),
            room_url: room_url.clone(),
            fallback_url: fallback_url.clone(),
            created_at: std::time::Instant::now(),
            magnet_link: None,
        });
    }

    Ok(CreateRoomResponse {
        session_id,
        share_code,
        tracker_info_hash: info_hash,
        fallback_url,
        mode: selected_mode.as_str().to_string(),
        tracker_urls,
    })
}

#[tauri::command]
pub async fn close_room(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Tell every signaller WS task that the host is gone so they can
    // send `host-ended` and close cleanly. Empty payload = all rooms.
    let _ = state.room_close_tx.send(String::new());

    crate::engine::tunnel::stop_tunnel(&state).await;

    let p2p_handle = {
        let mut guard = state.p2p.lock().await;
        guard.take()
    };
    if let Some(handle) = p2p_handle {
        handle.shutdown().await;
    }

    let mut torrent_stream = state.torrent_stream.lock().await;
    *torrent_stream = None;
    let mut active_stream = state.active_stream.lock().await;
    *active_stream = None;
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
            "mode": s.mode,
            "shareCode": s.share_code,
            "roomUrl": s.room_url,
            "fallbackUrl": s.fallback_url,
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

