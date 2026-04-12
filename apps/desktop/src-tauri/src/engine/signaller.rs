use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use tokio::sync::{mpsc, Mutex, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

#[derive(Clone)]
struct PeerSender {
    id: String,
    tx: mpsc::UnboundedSender<Message>,
}

type RoomMap = Arc<Mutex<HashMap<String, Vec<PeerSender>>>>;
pub type CurrentFilePath = Arc<RwLock<Option<String>>>;

#[derive(Clone)]
struct SignallerState {
    rooms: RoomMap,
    current_file: CurrentFilePath,
}

pub async fn create_signalling_server(
    port: u16,
    web_dist: Option<String>,
    current_file: CurrentFilePath,
) -> anyhow::Result<()> {
    let rooms: RoomMap = Arc::new(Mutex::new(HashMap::new()));
    let state = SignallerState { rooms, current_file };

    let mut router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/host-video", get(video_stream_handler))
        .with_state(state)
        .layer(CorsLayer::permissive());

    // Serve receiver-web dist if path provided
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

// ========================================================================
// Video streaming with proper range requests (no full-file-in-RAM)
// ========================================================================

/// Max chunk size for streaming responses (2MB)
const STREAM_CHUNK_SIZE: u64 = 2 * 1024 * 1024;

async fn video_stream_handler(
    State(state): State<SignallerState>,
    headers: HeaderMap,
) -> Response {
    let file_path = {
        let guard = state.current_file.read().await;
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => {
                return (StatusCode::NOT_FOUND, "No video loaded").into_response();
            }
        }
    };

    let path = std::path::PathBuf::from(&file_path);
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("Video file not found: {} — {}", file_path, e);
            return (StatusCode::NOT_FOUND, "File not found").into_response();
        }
    };
    let file_size = metadata.len();

    if file_size == 0 {
        return (StatusCode::NOT_FOUND, "Empty file").into_response();
    }

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let content_type = match ext.to_lowercase().as_str() {
        "mkv" => "video/x-matroska",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "ts" => "video/mp2t",
        _ => "video/mp4",
    };

    // Parse Range header
    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).unwrap_or("");

    let (start, end, is_range) = if range_header.starts_with("bytes=") {
        let range_spec = &range_header[6..];
        let parts: Vec<&str> = range_spec.splitn(2, '-').collect();
        let start = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let end = parts.get(1)
            .and_then(|s| if s.is_empty() { None } else { s.parse::<u64>().ok() })
            .unwrap_or_else(|| (start + STREAM_CHUNK_SIZE).min(file_size) - 1)
            .min(file_size - 1);
        (start, end, true)
    } else {
        (0, file_size.saturating_sub(1), false)
    };

    let chunk_size = end - start + 1;

    // Open file and seek
    use tokio::io::AsyncSeekExt;
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("Cannot open video file: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Cannot open file").into_response();
        }
    };

    if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
        tracing::error!("Seek failed: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Seek failed").into_response();
    }

    // Stream the chunk using ReaderStream (doesn't load everything into RAM)
    use tokio::io::AsyncReadExt;
    let limited = file.take(chunk_size);
    let stream = tokio_util::io::ReaderStream::new(limited);
    let body = Body::from_stream(stream);

    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    response_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());

    if is_range {
        response_headers.insert(header::CONTENT_LENGTH, chunk_size.to_string().parse().unwrap());
        response_headers.insert(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end, file_size).parse().unwrap(),
        );
        (StatusCode::PARTIAL_CONTENT, response_headers, body).into_response()
    } else {
        // If it's a full GET request, we technically should serve the whole file, but we stream the chunk
        // However, WebTorrent usually only sends Range requests.
        response_headers.insert(header::CONTENT_LENGTH, chunk_size.to_string().parse().unwrap());
        (StatusCode::OK, response_headers, body).into_response()
    }
}

// ========================================================================
// WebSocket signalling
// ========================================================================

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SignallerState>,
    Query(_params): Query<HashMap<String, String>>,
) -> Response {
    ws.on_upgrade(move |socket| handle_ws(socket, state.rooms))
}

async fn handle_ws(socket: WebSocket, rooms: RoomMap) {
    let peer_id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let mut current_room: Option<String> = None;

    let (mut ws_sink, mut ws_stream) = socket.split();

    // Forward outgoing messages to WebSocket
    let _peer_id_clone = peer_id.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_stream.next().await {
        match msg {
            Message::Text(text) => {
                let signal: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!("Invalid signal message: {}", e);
                        continue;
                    }
                };

                match signal["type"].as_str() {
                    Some("join") => {
                        let room_id = match signal["room"].as_str() {
                            Some(id) => id.to_string(),
                            None => continue,
                        };
                        let display_name = signal["displayName"]
                            .as_str()
                            .unwrap_or("Guest")
                            .to_string();

                        current_room = Some(room_id.clone());

                        let mut rooms_lock = rooms.lock().await;
                        let room = rooms_lock.entry(room_id.clone()).or_default();

                        // Max 9 peers (1 host + 8 receivers)
                        if room.len() >= 9 {
                            let _ = tx.send(Message::Text(
                                r#"{"type":"room-full"}"#.to_string(),
                            ));
                            continue;
                        }

                        // Notify ALL existing peers about new joiner
                        let join_notify = serde_json::json!({
                            "type": "peer-joined",
                            "peerId": peer_id,
                            "displayName": display_name,
                        });
                        for existing_peer in room.iter() {
                            let _ = existing_peer.tx.send(Message::Text(join_notify.to_string()));
                        }

                        // Tell the new joiner about existing peers
                        let existing_list: Vec<serde_json::Value> = room.iter().map(|p| {
                            serde_json::json!({ "peerId": p.id })
                        }).collect();
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

                        tracing::info!("Peer {} joined room {} (total: {})", peer_id, room_id, room.len());
                    }

                    Some("offer") | Some("answer") | Some("ice-candidate") => {
                        let signal_type = signal["type"].as_str().unwrap_or("?").to_string();
                        // Relay to target peer
                        let target_id = match signal["peerId"].as_str() {
                            Some(id) => id.to_string(),
                            None => {
                                tracing::warn!("Signal {} from {} missing peerId", signal_type, peer_id);
                                continue;
                            }
                        };

                        tracing::info!("Relaying {} from {} → {}", signal_type, peer_id, target_id);

                        if let Some(room_id) = &current_room {
                            let rooms_lock = rooms.lock().await;
                            if let Some(room) = rooms_lock.get(room_id) {
                                if let Some(peer) = room.iter().find(|p| p.id == target_id) {
                                    let mut relayed = signal.clone();
                                    relayed["peerId"] = peer_id.clone().into();
                                    let _ = peer.tx.send(Message::Text(relayed.to_string()));
                                    tracing::info!("Relayed {} to peer {}", signal_type, target_id);
                                } else {
                                    let peer_ids: Vec<&str> = room.iter().map(|p| p.id.as_str()).collect();
                                    tracing::warn!("Target peer {} not found in room {} (peers: {:?})", target_id, room_id, peer_ids);
                                }
                            } else {
                                tracing::warn!("Room {} not found for relay", room_id);
                            }
                        } else {
                            tracing::warn!("Peer {} not in any room, can't relay {}", peer_id, signal_type);
                        }
                    }

                    Some("chat") => {
                        // Broadcast chat to all other peers in the room
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
                        // Broadcast sync to all other peers in the room
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
                            "serverTime": unix_ms(),
                        });
                        let _ = tx.send(Message::Text(pong.to_string()));
                    }

                    _ => {
                        tracing::debug!("Unknown signal type from {}: {:?}", peer_id, signal["type"]);
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

    // Cleanup on disconnect
    tracing::info!("Peer {} disconnected", peer_id);
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

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
