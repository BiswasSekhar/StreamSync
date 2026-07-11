use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
    routing::get,
    Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use tokio::sync::{mpsc, Mutex, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use crate::state::AppState;

#[derive(Clone)]
struct PeerSender {
    id: String,
    tx: mpsc::UnboundedSender<Message>,
}

type RoomMap = Arc<Mutex<HashMap<String, Vec<PeerSender>>>>;

/// Max peers per room (host + viewers). Mirrors
/// `MAX_PEERS_PER_ROOM` in packages/shared/src/limits.ts.
const MAX_PEERS_PER_ROOM: usize = 6;

pub type CurrentFilePath = Arc<RwLock<Option<String>>>;

#[derive(Clone)]
struct SignallerState {
    rooms: RoomMap,
    app_state: Arc<AppState>,
}

pub async fn create_signalling_server(
    port: u16,
    web_dist: Option<String>,
    _current_file: CurrentFilePath,
    app_state: Arc<AppState>,
) -> anyhow::Result<()> {
    let rooms: RoomMap = Arc::new(Mutex::new(HashMap::new()));
    let state = SignallerState { rooms, app_state };

    // The signaller now only carries WebSocket signalling for the
    // Compatibility-Mode cloudflared tunnel. Media chunks are read via
    // the `read_video_chunk` Tauri command and shipped over the per-peer
    // WebRTC mediaDc — no HTTP, no localhost dependency.
    let mut router = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
        .layer(CorsLayer::permissive());

    if let Some(dist_path) = web_dist {
        if std::path::Path::new(&dist_path).exists() {
            router = router.nest_service("/", ServeDir::new(dist_path));
        }
    }

    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Signalling server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SignallerState>,
    Query(_params): Query<HashMap<String, String>>,
) -> Response {
    let rooms = state.rooms.clone();
    let close_rx = state.app_state.room_close_tx.subscribe();
    ws.on_upgrade(move |socket| handle_ws(socket, rooms, close_rx))
}

async fn handle_ws(
    socket: WebSocket,
    rooms: RoomMap,
    mut close_rx: tokio::sync::broadcast::Receiver<String>,
) {
    let peer_id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let mut current_room: Option<String> = None;

    let (mut ws_sink, mut ws_stream) = socket.split();

    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    loop {
        let msg = tokio::select! {
            msg = ws_stream.next() => match msg {
                Some(Ok(m)) => m,
                _ => break,
            },
            notice = close_rx.recv() => match notice {
                Ok(target_room) => {
                    let matches = target_room.is_empty()
                        || current_room.as_deref() == Some(target_room.as_str());
                    if matches {
                        let _ = tx.send(Message::Text(r#"{"type":"host-ended"}"#.to_string()));
                        let _ = tx.send(Message::Close(None));
                    }
                    continue;
                }
                // Lagged or channel closed: stay connected, clients can
                // still detect disconnect on their own.
                Err(_) => continue,
            },
        };

        match msg {
            Message::Text(text) => {
                let signal: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                match signal["type"].as_str() {
                    Some("join") => {
                        let room_id = match signal["room"].as_str() {
                            Some(id) => id.to_string(),
                            None => continue,
                        };
                        let display_name = signal["displayName"].as_str().unwrap_or("Guest").to_string();

                        current_room = Some(room_id.clone());

                        let mut rooms_lock = rooms.lock().await;
                        let room = rooms_lock.entry(room_id.clone()).or_default();

                        if room.len() >= MAX_PEERS_PER_ROOM {
                            let _ = tx.send(Message::Text(r#"{"type":"room-full"}"#.to_string()));
                            continue;
                        }

                        let join_notify = serde_json::json!({
                            "type": "peer-joined",
                            "peerId": peer_id,
                            "displayName": display_name,
                        });
                        for existing_peer in room.iter() {
                            let _ = existing_peer.tx.send(Message::Text(join_notify.to_string()));
                        }

                        let existing_list: Vec<serde_json::Value> = room
                            .iter()
                            .map(|p| serde_json::json!({ "peerId": p.id }))
                            .collect();
                        let room_info = serde_json::json!({
                            "type": "room-joined",
                            "roomId": room_id,
                            "peerId": peer_id,
                            "existingPeers": existing_list,
                        });
                        let _ = tx.send(Message::Text(room_info.to_string()));

                        room.push(PeerSender {
                            id: peer_id.clone(),
                            tx: tx.clone(),
                        });
                    }

                    Some("chat") => {
                        if let Some(room_id) = &current_room {
                            let rooms_lock = rooms.lock().await;
                            if let Some(room) = rooms_lock.get(room_id) {
                                let chat_msg = serde_json::json!({
                                    "type": "chat",
                                    "from": signal["from"].as_str().unwrap_or("Guest"),
                                    "text": signal["text"].as_str().unwrap_or(""),
                                    "timestamp": signal["timestamp"],
                                    "id": signal["id"].as_str().unwrap_or(""),
                                });
                                for peer in room.iter() {
                                    if peer.id != peer_id {
                                        let _ = peer.tx.send(Message::Text(chat_msg.to_string()));
                                    }
                                }
                            }
                        }
                    }

                    Some("sync") => {
                        if let Some(room_id) = &current_room {
                            let rooms_lock = rooms.lock().await;
                            if let Some(room) = rooms_lock.get(room_id) {
                                for peer in room.iter() {
                                    if peer.id != peer_id {
                                        let _ = peer.tx.send(Message::Text(text.clone()));
                                    }
                                }
                            }
                        }
                    }

                    Some("ping") => {
                        let pong = serde_json::json!({
                            "type": "pong",
                            "timestamp": signal["timestamp"],
                            "serverTime": crate::state::unix_ms(),
                        });
                        let _ = tx.send(Message::Text(pong.to_string()));
                    }

                    _ => {
                        let target_id = match signal["peerId"].as_str() {
                            Some(id) => id.to_string(),
                            None => continue,
                        };
                        if let Some(room_id) = &current_room {
                            let rooms_lock = rooms.lock().await;
                            if let Some(room) = rooms_lock.get(room_id) {
                                if let Some(peer) = room.iter().find(|p| p.id == target_id) {
                                    let mut relayed = signal.clone();
                                    relayed["peerId"] = peer_id.clone().into();
                                    let _ = peer.tx.send(Message::Text(relayed.to_string()));
                                }
                            }
                        }
                    }
                }
            }
            Message::Close(_) => break,
            Message::Ping(data) => {
                let _ = tx.send(Message::Pong(data));
            }
            _ => {}
        }
    }

    if let Some(room_id) = current_room {
        let mut rooms_lock = rooms.lock().await;
        if let Some(room) = rooms_lock.get_mut(&room_id) {
            room.retain(|p| p.id != peer_id);
            let left_msg = serde_json::json!({
                "type": "peer-left",
                "peerId": peer_id,
            })
            .to_string();
            for peer in room.iter() {
                let _ = peer.tx.send(Message::Text(left_msg.clone()));
            }
            if room.is_empty() {
                rooms_lock.remove(&room_id);
            }
        }
    }
}

// `/host-video` and its `video_stream_handler`/`torrent_video_stream_response`
// helpers were removed when StreamSync switched to serverless P2P. Remote
// guests could never reach `localhost:8787` so the endpoint was a no-op for
// tracker-mode sessions. Media bytes now flow exclusively via the
// `read_video_chunk` Tauri command into the per-peer WebRTC mediaDc — see
// `apps/desktop/src-tauri/src/commands/media_chunk.rs` and the
// `hostWebrtc.ts` chunk handler.
