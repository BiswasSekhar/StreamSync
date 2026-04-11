use std::collections::HashMap;
use std::sync::Arc;

use axum::{
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

/// Serve the host's current video file with HTTP range request support.
/// This lets the in-app video player seek without loading the whole file into RAM.
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
        Err(_) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };
    let file_size = metadata.len();

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
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).unwrap_or("");

    let (start, end) = if range.starts_with("bytes=") {
        let parts: Vec<&str> = range[6..].splitn(2, '-').collect();
        let start = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let end = parts.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(file_size - 1);
        (start, end.min(file_size - 1))
    } else {
        (0, file_size - 1)
    };

    let chunk_size = end - start + 1;
    let is_range_request = !range.is_empty();

    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Cannot open file").into_response(),
    };

    if let Err(_) = file.seek(std::io::SeekFrom::Start(start)).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Seek failed").into_response();
    }

    let mut buf = vec![0u8; chunk_size as usize];
    if let Err(_) = file.read_exact(&mut buf).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Read failed").into_response();
    }

    let status = if is_range_request {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };

    let mut response_headers = axum::http::HeaderMap::new();
    response_headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    response_headers.insert(header::CONTENT_LENGTH, chunk_size.to_string().parse().unwrap());
    response_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    response_headers.insert(
        header::CONTENT_RANGE,
        format!("bytes {}-{}/{}", start, end, file_size).parse().unwrap(),
    );
    // Allow the Tauri webview to load this
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());

    (status, response_headers, buf).into_response()
}

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

                        // Notify host (first peer) about new joiner
                        if let Some(host) = room.first() {
                            let notify = serde_json::json!({
                                "type": "peer-joined",
                                "peerId": peer_id,
                                "displayName": display_name,
                            });
                            let _ = host.tx.send(Message::Text(notify.to_string()));
                        }

                        room.push(PeerSender {
                            id: peer_id.clone(),
                            tx: tx.clone(),
                        });

                        tracing::info!("Peer {} joined room {}", peer_id, room_id);
                    }

                    Some("offer") | Some("answer") | Some("ice-candidate") => {
                        // Relay to target peer
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
