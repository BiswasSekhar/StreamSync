use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
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
    display_name: String,
    tx: mpsc::Sender<Message>,
}

type RoomMap = Arc<Mutex<HashMap<String, Vec<PeerSender>>>>;

/// Max peers per room (host + viewers). Mirrors
/// `MAX_PEERS_PER_ROOM` in packages/shared/src/limits.ts.
const MAX_PEERS_PER_ROOM: usize = 12;
const MAX_WS_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_ROOM_ID_CHARS: usize = 64;
const MAX_DISPLAY_NAME_CHARS: usize = 30;
const MAX_CHAT_CHARS: usize = 4 * 1024;
const MAX_SIGNAL_TEXT_CHARS: usize = 60 * 1024;

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
) -> Response {
    let rooms = state.rooms.clone();
    let close_rx = state.app_state.room_close_tx.subscribe();
    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_ws(socket, rooms, close_rx))
}

fn enqueue(tx: &mpsc::Sender<Message>, message: Message) -> bool {
    tx.try_send(message).is_ok()
}

fn bounded_string(value: Option<&serde_json::Value>, max_chars: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty() || value.chars().count() > max_chars || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_string())
}

fn bounded_signal_text(value: Option<&serde_json::Value>, max_chars: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    // SDP legitimately contains CR/LF separators; reject only NUL, which is
    // never valid in a signalling payload and makes log/ parser handling risky.
    if value.is_empty() || value.chars().count() > max_chars || value.contains('\0') {
        return None;
    }
    Some(value.to_string())
}

fn relayable_signal(signal: &serde_json::Value) -> bool {
    let Some(signal_type) = signal.get("type").and_then(serde_json::Value::as_str) else {
        return false;
    };

    match signal_type {
        "join-request" => bounded_string(signal.get("displayName"), MAX_DISPLAY_NAME_CHARS).is_some(),
        "join-approved" | "join-denied" | "host-ended" | "leave" => true,
        "offer" | "answer" => bounded_signal_text(signal.get("sdp"), MAX_SIGNAL_TEXT_CHARS).is_some(),
        "ice-candidate" => signal.get("candidate").is_some_and(serde_json::Value::is_object),
        "ice-candidates" => signal
            .get("candidates")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|candidates| candidates.len() <= 256),
        _ => false,
    }
}

fn remove_peer_from_room(
    rooms: &mut HashMap<String, Vec<PeerSender>>,
    room_id: &str,
    peer_id: &str,
) -> Vec<mpsc::Sender<Message>> {
    let Some(room) = rooms.get_mut(room_id) else {
        return Vec::new();
    };

    room.retain(|peer| peer.id != peer_id);
    let recipients = room.iter().map(|peer| peer.tx.clone()).collect::<Vec<_>>();
    if room.is_empty() {
        rooms.remove(room_id);
    }
    recipients
}

fn notify_peer_left(recipients: &[mpsc::Sender<Message>], peer_id: &str) {
    let message = Message::Text(
        serde_json::json!({
            "type": "peer-left",
            "peerId": peer_id,
        })
        .to_string()
        .into(),
    );
    for tx in recipients {
        let _ = enqueue(tx, message.clone());
    }
}

async fn handle_ws(
    socket: WebSocket,
    rooms: RoomMap,
    mut close_rx: tokio::sync::broadcast::Receiver<String>,
) {
    let peer_id = uuid::Uuid::new_v4().to_string();
    // A bounded queue prevents a slow browser from turning signalling into an
    // unbounded allocation. Messages are best-effort; the peer reconnects if
    // it cannot keep up with control traffic.
    let (tx, mut rx) = mpsc::channel::<Message>(64);
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
                        let _ = enqueue(&tx, Message::Text(r#"{"type":"host-ended"}"#.to_string().into()));
                        let _ = enqueue(&tx, Message::Close(None));
                        break;
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
                if text.len() > MAX_WS_MESSAGE_BYTES {
                    break;
                }

                let signal: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                match signal["type"].as_str() {
                    Some("join") => {
                        let Some(room_id) = bounded_string(signal.get("room"), MAX_ROOM_ID_CHARS) else {
                            let _ = enqueue(&tx, Message::Text(r#"{"type":"invalid-room"}"#.to_string().into()));
                            continue;
                        };
                        let display_name = bounded_string(signal.get("displayName"), MAX_DISPLAY_NAME_CHARS)
                            .unwrap_or_else(|| "Guest".to_string());

                        let mut rooms_lock = rooms.lock().await;
                        if current_room.as_deref() == Some(room_id.as_str()) {
                            let existing_list = rooms_lock
                                .get(&room_id)
                                .into_iter()
                                .flat_map(|room| room.iter())
                                .filter(|peer| peer.id != peer_id)
                                .map(|peer| {
                                    serde_json::json!({
                                        "peerId": peer.id,
                                        "displayName": peer.display_name,
                                    })
                                })
                                .collect::<Vec<_>>();
                            let room_info = serde_json::json!({
                                "type": "room-joined",
                                "roomId": room_id,
                                "peerId": peer_id,
                                "existingPeers": existing_list,
                            });
                            let _ = enqueue(&tx, Message::Text(room_info.to_string().into()));
                            continue;
                        }

                        if rooms_lock
                            .get(&room_id)
                            .is_some_and(|room| room.len() >= MAX_PEERS_PER_ROOM)
                        {
                            let _ = enqueue(&tx, Message::Text(r#"{"type":"room-full"}"#.to_string().into()));
                            continue;
                        }

                        if let Some(previous_room) = current_room.take() {
                            let recipients = remove_peer_from_room(&mut rooms_lock, &previous_room, &peer_id);
                            notify_peer_left(&recipients, &peer_id);
                        }

                        let room = rooms_lock.entry(room_id.clone()).or_default();

                        let join_notify = serde_json::json!({
                            "type": "peer-joined",
                            "peerId": peer_id,
                            "displayName": display_name,
                        });
                        for existing_peer in room.iter() {
                            let _ = enqueue(&existing_peer.tx, Message::Text(join_notify.to_string().into()));
                        }

                        let existing_list: Vec<serde_json::Value> = room
                            .iter()
                            .map(|p| serde_json::json!({
                                "peerId": p.id,
                                "displayName": p.display_name,
                            }))
                            .collect();
                        let room_info = serde_json::json!({
                            "type": "room-joined",
                            "roomId": room_id,
                            "peerId": peer_id,
                            "existingPeers": existing_list,
                        });
                        let _ = enqueue(&tx, Message::Text(room_info.to_string().into()));

                        room.push(PeerSender {
                            id: peer_id.clone(),
                            display_name,
                            tx: tx.clone(),
                        });
                        current_room = Some(room_id);
                    }

                    Some("chat") => {
                        let Some(text_value) = bounded_string(signal.get("text"), MAX_CHAT_CHARS) else {
                            continue;
                        };
                        let message_id = bounded_string(signal.get("id"), 128)
                            .unwrap_or_else(|| format!("{}-{}", peer_id, crate::state::unix_ms()));
                        let timestamp = signal
                            .get("timestamp")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or_else(crate::state::unix_ms);
                        if let Some(room_id) = &current_room {
                            let rooms_lock = rooms.lock().await;
                            if let Some(room) = rooms_lock.get(room_id) {
                                let from = room
                                    .iter()
                                    .find(|peer| peer.id == peer_id)
                                    .map(|peer| peer.display_name.as_str())
                                    .unwrap_or("Guest");
                                let chat_msg = serde_json::json!({
                                    "type": "chat",
                                    "from": from,
                                    "text": text_value,
                                    "timestamp": timestamp,
                                    "id": message_id,
                                });
                                for peer in room.iter() {
                                    if peer.id != peer_id {
                                        let _ = enqueue(&peer.tx, Message::Text(chat_msg.to_string().into()));
                                    }
                                }
                            }
                        }
                    }

                    Some("sync") => {
                        if signal.get("position").and_then(serde_json::Value::as_f64).is_none()
                            || signal.get("playing").and_then(serde_json::Value::as_bool).is_none()
                            || signal.get("timestamp").and_then(serde_json::Value::as_u64).is_none()
                            || signal.get("sequence").and_then(serde_json::Value::as_u64).is_none()
                        {
                            continue;
                        }
                        if let Some(room_id) = &current_room {
                            let rooms_lock = rooms.lock().await;
                            if let Some(room) = rooms_lock.get(room_id) {
                                let mut relayed = signal.clone();
                                relayed["peerId"] = peer_id.clone().into();
                                for peer in room.iter() {
                                    if peer.id != peer_id {
                                        let _ = enqueue(&peer.tx, Message::Text(relayed.to_string().into()));
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
                        let _ = enqueue(&tx, Message::Text(pong.to_string().into()));
                    }

                    Some("host-ended") => {
                        if let Some(room_id) = &current_room {
                            let rooms_lock = rooms.lock().await;
                            if let Some(room) = rooms_lock.get(room_id) {
                                let mut relayed = signal.clone();
                                relayed["peerId"] = peer_id.clone().into();
                                for peer in room.iter() {
                                    if peer.id != peer_id {
                                        let _ = enqueue(
                                            &peer.tx,
                                            Message::Text(relayed.to_string().into()),
                                        );
                                    }
                                }
                            }
                        }
                    }

                    Some("leave") => {
                        if let Some(room_id) = current_room.take() {
                            let mut rooms_lock = rooms.lock().await;
                            let recipients = remove_peer_from_room(&mut rooms_lock, &room_id, &peer_id);
                            notify_peer_left(&recipients, &peer_id);
                        }
                    }

                    Some(_) if relayable_signal(&signal) => {
                        let Some(target_id) = bounded_string(signal.get("peerId"), 64) else {
                            continue;
                        };
                        if let Some(room_id) = &current_room {
                            let rooms_lock = rooms.lock().await;
                            if let Some(room) = rooms_lock.get(room_id) {
                                if let Some(peer) = room.iter().find(|p| p.id == target_id && p.id != peer_id) {
                                    let mut relayed = signal.clone();
                                    relayed["peerId"] = peer_id.clone().into();
                                    let _ = enqueue(&peer.tx, Message::Text(relayed.to_string().into()));
                                }
                            }
                        }
                    }
                    Some(_) | None => {}
                }
            }
            Message::Close(_) => break,
            Message::Ping(data) => {
                let _ = enqueue(&tx, Message::Pong(data));
            }
            _ => {}
        }
    }

    if let Some(room_id) = current_room {
        let mut rooms_lock = rooms.lock().await;
        let recipients = remove_peer_from_room(&mut rooms_lock, &room_id, &peer_id);
        notify_peer_left(&recipients, &peer_id);
    }
}

// `/host-video` and its `video_stream_handler`/`torrent_video_stream_response`
// helpers were removed when StreamSync switched to serverless P2P. Remote
// guests could never reach `localhost:8787` so the endpoint was a no-op for
// tracker-mode sessions. Media bytes now flow exclusively via the
// `read_video_chunk` Tauri command into the per-peer WebRTC mediaDc — see
// `apps/desktop/src-tauri/src/commands/media_chunk.rs` and the
// `hostWebrtc.ts` chunk handler.
