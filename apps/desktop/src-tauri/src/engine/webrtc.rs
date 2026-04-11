use std::collections::HashMap;
use std::sync::Arc;
use anyhow::Context;
use tauri::Emitter;
use tokio::sync::Mutex;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::data_channel::RTCDataChannel;

use crate::state::{AppState, AppEvent, ChatMessage, unix_ms};
use crate::engine::tunnel::TurnCredentials;

pub struct WebRTCEngine {
    api: Arc<webrtc::api::API>,
}

impl WebRTCEngine {
    pub fn new() -> anyhow::Result<Self> {
        let mut m = MediaEngine::default();
        m.register_default_codecs()?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut m)?;

        let api = APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .build();

        Ok(Self {
            api: Arc::new(api),
        })
    }

    pub async fn create_peer_connection(
        &self,
        turn_credentials: Option<TurnCredentials>,
    ) -> anyhow::Result<Arc<RTCPeerConnection>> {
        let mut ice_servers = vec![
            RTCIceServer {
                urls: vec![
                    "stun:stun.l.google.com:19302".to_string(),
                    "stun:stun1.l.google.com:19302".to_string(),
                ],
                ..Default::default()
            },
        ];

        if let Some(turn) = turn_credentials {
            ice_servers.push(RTCIceServer {
                urls: vec![turn.url],
                username: turn.username,
                credential: turn.credential,
                ..Default::default()
            });
        }

        let config = RTCConfiguration {
            ice_servers,
            ..Default::default()
        };

        let pc = Arc::new(
            self.api
                .new_peer_connection(config)
                .await
                .context("Failed to create peer connection")?
        );

        Ok(pc)
    }
}

/// Create data channels on a peer connection (called on host side)
pub async fn setup_data_channels(
    pc: &Arc<RTCPeerConnection>,
) -> anyhow::Result<(Arc<RTCDataChannel>, Arc<RTCDataChannel>, Arc<RTCDataChannel>)> {
    // Sync channel — unreliable/unordered (newest wins, like UDP)
    let sync_dc = pc
        .create_data_channel(
            "sync",
            Some(RTCDataChannelInit {
                ordered: Some(false),
                max_retransmits: Some(0),
                ..Default::default()
            }),
        )
        .await
        .context("Failed to create sync data channel")?;

    // Chat channel — reliable/ordered
    let chat_dc = pc
        .create_data_channel(
            "chat",
            Some(RTCDataChannelInit {
                ordered: Some(true),
                ..Default::default()
            }),
        )
        .await
        .context("Failed to create chat data channel")?;

    // Control channel — reliable/ordered (magnet link delivery)
    let control_dc = pc
        .create_data_channel(
            "control",
            Some(RTCDataChannelInit {
                ordered: Some(true),
                ..Default::default()
            }),
        )
        .await
        .context("Failed to create control data channel")?;

    Ok((sync_dc, chat_dc, control_dc))
}

/// Handle a new peer joining: create peer connection, do offer/answer via signaller
pub async fn handle_peer_joined(
    peer_id: String,
    display_name: String,
    send_to_peer: Arc<dyn Fn(String) -> () + Send + Sync>,
    state: Arc<AppState>,
    app: tauri::AppHandle,
) -> anyhow::Result<()> {
    tracing::info!("Setting up WebRTC for peer {}", peer_id);

    let engine = WebRTCEngine::new()?;
    let turn = crate::engine::tunnel::get_turn_credentials().await;
    let pc = engine.create_peer_connection(turn).await?;

    let (_sync_dc, _chat_dc, control_dc) = setup_data_channels(&pc).await?;

    // Handle ICE candidates — send to peer via signaller relay
    let send_clone = Arc::clone(&send_to_peer);
    let peer_id_clone = peer_id.clone();
    pc.on_ice_candidate(Box::new(move |candidate| {
        let send = Arc::clone(&send_clone);
        let pid = peer_id_clone.clone();
        Box::pin(async move {
            if let Some(c) = candidate {
                if let Ok(json) = c.to_json() {
                    let msg = serde_json::json!({
                        "type": "ice-candidate",
                        "candidate": json,
                        "peerId": pid,
                    });
                    send(msg.to_string());
                }
            }
        })
    }));

    // Handle connection state changes
    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();
    let pid_clone = peer_id.clone();
    pc.on_peer_connection_state_change(Box::new(move |conn_state| {
        let state = Arc::clone(&state_clone);
        let app = app_clone.clone();
        let pid = pid_clone.clone();
        Box::pin(async move {
            tracing::info!("Peer {} connection state: {:?}", pid, conn_state);
            match conn_state {
                RTCPeerConnectionState::Connected => {
                    tracing::info!("Peer {} P2P connected!", pid);
                    // Send magnet link via control channel
                    if let Some(magnet) = crate::engine::torrent::get_magnet_link(&state).await {
                        let _msg = serde_json::json!({
                            "type": "magnet",
                            "magnet": magnet,
                        });
                        // Control channel send is handled via stored reference
                    }
                }
                RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed => {
                    tracing::warn!("Peer {} disconnected/failed", pid);
                    let mut peers = state.peers.lock().await;
                    peers.remove(&pid);
                    drop(peers);
                    state.emit(AppEvent::PeerLeft { peer_id: pid.clone() });
                    let _ = app.emit("peer-left", serde_json::json!({ "peerId": pid }));
                }
                _ => {}
            }
        })
    }));

    // Handle incoming data channels from receiver
    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();
    let pid_clone = peer_id.clone();
    pc.on_data_channel(Box::new(move |dc| {
        let state = Arc::clone(&state_clone);
        let app = app_clone.clone();
        let pid = pid_clone.clone();
        Box::pin(async move {
            if dc.label() == "chat" {
                let state_inner = Arc::clone(&state);
                let app_inner = app.clone();
                let _pid_inner = pid.clone();
                dc.on_message(Box::new(move |msg| {
                    let state = Arc::clone(&state_inner);
                    let app = app_inner.clone();
                    Box::pin(async move {
                        if let Ok(text) = std::str::from_utf8(&msg.data) {
                            if let Ok(chat) = serde_json::from_str::<ChatMessage>(text) {
                                state.emit(AppEvent::ChatMessage(chat.clone()));
                                let _ = app.emit("chat-message", chat);
                            }
                        }
                    })
                }));
            }
        })
    }));

    // Create offer
    let offer = pc.create_offer(None).await.context("Failed to create offer")?;
    pc.set_local_description(offer.clone()).await.context("Failed to set local description")?;

    let offer_msg = serde_json::json!({
        "type": "offer",
        "sdp": offer.sdp,
        "peerId": peer_id,
    });
    send_to_peer(offer_msg.to_string());

    // Store peer state (control_dc stored for later magnet sending)
    {
        let (dc_tx, mut dc_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let control_dc_clone = Arc::clone(&control_dc);
        tokio::spawn(async move {
            while let Some(msg) = dc_rx.recv().await {
                let _ = control_dc_clone.send_text(msg).await;
            }
        });

        let mut peers = state.peers.lock().await;
        peers.insert(peer_id.clone(), crate::state::PeerState {
            id: peer_id.clone(),
            display_name: display_name.clone(),
            connected_at: std::time::Instant::now(),
            video_position: 0.0,
            data_tx: Some(dc_tx),
        });
    }

    state.emit(AppEvent::PeerJoined {
        peer_id: peer_id.clone(),
        display_name,
    });
    let _ = app.emit("peer-joined", serde_json::json!({
        "peerId": peer_id,
        "displayName": peer_id.clone(),
    }));

    Ok(())
}

/// Process an answer from a receiver
pub async fn handle_answer(
    peer_id: &str,
    sdp: &str,
    peer_connections: &Mutex<HashMap<String, Arc<RTCPeerConnection>>>,
) -> anyhow::Result<()> {
    let pcs = peer_connections.lock().await;
    if let Some(pc) = pcs.get(peer_id) {
        let answer = webrtc::peer_connection::sdp::session_description::RTCSessionDescription::answer(sdp.to_string())?;
        pc.set_remote_description(answer).await?;
    }
    Ok(())
}

/// Broadcast sync message to all connected peers
pub async fn broadcast_sync(
    state: &AppState,
    position: f64,
    playing: bool,
) -> anyhow::Result<()> {
    let seq = state
        .sync_sequence
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    let msg = serde_json::json!({
        "type": "sync",
        "position": position,
        "playing": playing,
        "timestamp": unix_ms(),
        "sequence": seq,
    });
    let json = msg.to_string();

    let peers = state.peers.lock().await;
    for (_, peer) in peers.iter() {
        if let Some(tx) = &peer.data_tx {
            let _ = tx.send(json.clone());
        }
    }
    Ok(())
}

/// Send magnet link to a specific peer
pub async fn send_magnet_to_peer(
    peer_id: &str,
    magnet: &str,
    state: &AppState,
) -> anyhow::Result<()> {
    let msg = serde_json::json!({
        "type": "magnet",
        "magnet": magnet,
    })
    .to_string();

    let peers = state.peers.lock().await;
    if let Some(peer) = peers.get(peer_id) {
        if let Some(tx) = &peer.data_tx {
            let _ = tx.send(msg);
        }
    }
    Ok(())
}

/// Broadcast chat message to all peers
pub async fn broadcast_chat(state: &AppState, msg: &ChatMessage) -> anyhow::Result<()> {
    let json = serde_json::to_string(msg)?;
    let peers = state.peers.lock().await;
    for (_, peer) in peers.iter() {
        if let Some(tx) = &peer.data_tx {
            let _ = tx.send(json.clone());
        }
    }
    Ok(())
}
