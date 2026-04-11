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
use tokio::sync::{mpsc, Mutex};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

#[derive(Clone)]
struct PeerSender {
    id: String,
    tx: mpsc::UnboundedSender<Message>,
}

type RoomMap = Arc<Mutex<HashMap<String, Vec<PeerSender>>>>;

#[derive(Clone)]
struct SignallerState {
    rooms: RoomMap,
}

pub async fn create_signalling_server(port: u16, web_dist: Option<String>) -> anyhow::Result<()> {
    let rooms: RoomMap = Arc::new(Mutex::new(HashMap::new()));
    let state = SignallerState { rooms };

    let mut router = Router::new()
        .route("/ws", get(ws_handler))
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
            // Notify remaining peers
            let left_msg = serde_json::json!({
                "type": "peer-left",
                "peerId": peer_id,
            })
            .to_string();
            for peer in room.iter() {
                let _ = peer.tx.send(Message::Text(left_msg.clone()));
            }
            // Remove empty rooms
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
