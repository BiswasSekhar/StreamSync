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
    current_file: CurrentFilePath,
    app_state: Arc<AppState>,
}

pub async fn create_signalling_server(
    port: u16,
    web_dist: Option<String>,
    current_file: CurrentFilePath,
    app_state: Arc<AppState>,
) -> anyhow::Result<()> {
    let rooms: RoomMap = Arc::new(Mutex::new(HashMap::new()));
    let state = SignallerState { rooms, current_file, app_state };

    let mut router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/host-video", get(video_stream_handler))
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

// ========================================================================
// Video streaming with proper range requests (no full-file-in-RAM)
// ========================================================================

const STREAM_CHUNK_SIZE: u64 = 2 * 1024 * 1024;

/// Parse an HTTP `Range: bytes=start-end` header against a known total size.
/// Accepts both closed (`bytes=N-M`) and open-ended (`bytes=N-`) forms.
/// Returns `(start, end_inclusive, is_range)`; defaults to the full range
/// when the header is missing or malformed.
fn parse_range(range_header: &str, total: u64) -> (u64, u64, bool) {
    if total == 0 {
        return (0, 0, false);
    }
    let Some(spec) = range_header.strip_prefix("bytes=") else {
        return (0, total - 1, false);
    };
    let mut parts = spec.splitn(2, '-');
    let start = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let end = parts
        .next()
        .and_then(|s| if s.is_empty() { None } else { s.parse::<u64>().ok() })
        .unwrap_or_else(|| (start + STREAM_CHUNK_SIZE).saturating_sub(1))
        .min(total - 1);
    if start > end {
        return (0, total - 1, false);
    }
    (start, end, true)
}

async fn video_stream_handler(
    State(state): State<SignallerState>,
    headers: HeaderMap,
) -> Response {
    if let Some(stream_source) = state.app_state.torrent_stream.lock().await.clone() {
        return torrent_video_stream_response(stream_source, headers).await;
    }

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
            tracing::error!("Video file not found: {} - {}", file_path, e);
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

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let (start, end, is_range) = parse_range(range_header, file_size);

    let chunk_size = end - start + 1;

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
        response_headers.insert(header::CONTENT_LENGTH, chunk_size.to_string().parse().unwrap());
        (StatusCode::OK, response_headers, body).into_response()
    }
}

async fn torrent_video_stream_response(
    source: crate::state::TorrentStreamSource,
    headers: HeaderMap,
) -> Response {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut stream = match source.handle.stream(source.file_id) {
        Ok(stream) => stream,
        Err(error) => {
            tracing::error!("Failed to open torrent stream: {}", error);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Cannot open torrent stream").into_response();
        }
    };

    let total_len = stream.len();
    if total_len == 0 {
        return (StatusCode::NOT_FOUND, "Empty torrent stream").into_response();
    }

    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::CONTENT_TYPE, source.content_type.parse().unwrap());
    response_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let (start, end, is_range) = parse_range(range_header, total_len);
    let chunk_size = end - start + 1;

    if is_range {
        if let Err(error) = stream.seek(std::io::SeekFrom::Start(start)).await {
            tracing::error!("Failed to seek torrent stream: {}", error);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Seek failed").into_response();
        }
        response_headers.insert(header::CONTENT_LENGTH, chunk_size.to_string().parse().unwrap());
        response_headers.insert(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end, total_len).parse().unwrap(),
        );
        let limited = stream.take(chunk_size);
        let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(limited, 65_536));
        (StatusCode::PARTIAL_CONTENT, response_headers, body).into_response()
    } else {
        response_headers.insert(header::CONTENT_LENGTH, total_len.to_string().parse().unwrap());
        let body = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(stream, 65_536));
        (StatusCode::OK, response_headers, body).into_response()
    }
}
