//! Background actor that owns the libp2p `Swarm` and drives its event
//! loop, plus accepts commands from the Tauri command handlers via an
//! `mpsc` channel and emits events to the frontend via `app.emit`.
//!
//! This pattern keeps the `Swarm` (which is `!Send` across `.await`
//! points in tricky ways) bound to one task. Tauri command handlers
//! never touch the swarm directly — they just send messages.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures::StreamExt;
use libp2p::{autonat, gossipsub, identify, mdns, swarm::SwarmEvent, PeerId};
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, Mutex};

use super::libp2p_gossip::{GossipEnvelope, GossipKind};
use super::libp2p_node::{build_keypair, Libp2pSession, NodeRole, StreamSyncBehaviourEvent};
use super::session_cipher::SessionCipher;

/// Commands the Tauri layer sends to the running supervisor.
pub enum SupervisorCmd {
    /// Encrypt + publish a gossip envelope. The supervisor fills in
    /// `sender_peer_id` from its local peer id.
    Publish {
        kind: GossipKind,
        payload: serde_json::Value,
        target: Option<String>,
        respond: oneshot::Sender<Result<String>>, // returns envelope id
    },
    /// Snapshot stats / diagnostics for the UI.
    Diagnostics {
        respond: oneshot::Sender<DiagnosticsSnapshot>,
    },
    /// Tear down the swarm and exit the task.
    Shutdown {
        respond: oneshot::Sender<()>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub local_peer_id: String,
    pub listen_addrs: Vec<String>,
    pub external_addrs: Vec<String>,
    pub kad_peers: usize,
    pub gossip_neighbors: usize,
    pub joined_peers: usize,
    pub nat_status: NatStatus,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NatStatus {
    Unknown,
    Public,
    Private,
}

/// Handle the Tauri layer keeps to talk to the supervisor task.
pub struct SupervisorHandle {
    pub local_peer_id: PeerId,
    pub gossip_topic_hex: String,
    pub cmd_tx: mpsc::Sender<SupervisorCmd>,
    /// Wrapped in `Mutex<Option<_>>` so `close_session` can take ownership
    /// of the join handle and `await` task termination.
    pub task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl SupervisorHandle {
    pub async fn publish(
        &self,
        kind: GossipKind,
        payload: serde_json::Value,
        target: Option<String>,
    ) -> Result<String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(SupervisorCmd::Publish {
                kind,
                payload,
                target,
                respond: tx,
            })
            .await
            .map_err(|_| anyhow!("supervisor task is gone"))?;
        rx.await.map_err(|_| anyhow!("supervisor dropped responder"))?
    }

    pub async fn diagnostics(&self) -> Result<DiagnosticsSnapshot> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(SupervisorCmd::Diagnostics { respond: tx })
            .await
            .map_err(|_| anyhow!("supervisor task is gone"))?;
        rx.await.map_err(|_| anyhow!("supervisor dropped responder"))
    }

    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        if self
            .cmd_tx
            .send(SupervisorCmd::Shutdown { respond: tx })
            .await
            .is_err()
        {
            return; // task already dead
        }
        let _ = rx.await;
        let mut guard = self.task.lock().await;
        if let Some(handle) = guard.take() {
            let _ = handle.await;
        }
    }
}

/// Spawn the supervisor. Returns the handle the Tauri layer keeps.
///
/// `app` is used to emit `p2p-*` events to the frontend. `cipher` is
/// shared with the encrypt/decrypt side so we never copy the key.
pub fn spawn(
    app: tauri::AppHandle,
    role: NodeRole,
    share_seed_for_host: Option<[u8; 32]>,
    gossip_topic_bytes: [u8; 32],
    cipher: Arc<SessionCipher>,
) -> Result<SupervisorHandle> {
    let keypair = build_keypair(role, share_seed_for_host)?;
    let local_peer_id = PeerId::from(keypair.public());

    let mut session = Libp2pSession::build(keypair, role, gossip_topic_bytes)?;
    session.listen_quic()?;
    session.subscribe_topic()?;
    let dialed = session.dial_bootstrap_peers().unwrap_or(0);
    tracing::info!(
        "libp2p supervisor: peer_id={local_peer_id}, dialed {dialed} bootstrap peers"
    );
    // Bootstrap is fire-and-forget; if it fails right now the supervisor
    // will retry on its periodic timer.
    let _ = session.bootstrap_dht();

    let gossip_topic_hex = hex::encode(gossip_topic_bytes);
    let (cmd_tx, cmd_rx) = mpsc::channel::<SupervisorCmd>(64);

    let task = tokio::spawn(run_event_loop(app, session, cipher, cmd_rx, local_peer_id));

    Ok(SupervisorHandle {
        local_peer_id,
        gossip_topic_hex,
        cmd_tx,
        task: Mutex::new(Some(task)),
    })
}

async fn run_event_loop(
    app: tauri::AppHandle,
    mut session: Libp2pSession,
    cipher: Arc<SessionCipher>,
    mut cmd_rx: mpsc::Receiver<SupervisorCmd>,
    local_peer_id: PeerId,
) {
    let mut diagnostics_tick = tokio::time::interval(Duration::from_secs(30));
    let mut bootstrap_tick = tokio::time::interval(Duration::from_secs(60));
    let mut nat_status = NatStatus::Unknown;

    loop {
        tokio::select! {
            biased;

            // Commands from the Tauri layer.
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else {
                    tracing::info!("libp2p supervisor: cmd channel closed, exiting");
                    return;
                };
                match cmd {
                    SupervisorCmd::Publish { kind, payload, target, respond } => {
                        let result = (|| -> Result<String> {
                            let mut env = GossipEnvelope::new(
                                kind,
                                local_peer_id.to_string(),
                                payload,
                            );
                            if let Some(t) = target {
                                env = env.with_target(t);
                            }
                            let id = env.id.clone();
                            let wire = env.seal(&cipher)?;
                            session.publish_raw(wire)?;
                            Ok(id)
                        })();
                        let _ = respond.send(result);
                    }
                    SupervisorCmd::Diagnostics { respond } => {
                        let snap = snapshot(&mut session, local_peer_id, nat_status);
                        let _ = respond.send(snap);
                    }
                    SupervisorCmd::Shutdown { respond } => {
                        tracing::info!("libp2p supervisor: shutdown requested");
                        let _ = respond.send(());
                        return;
                    }
                }
            }

            // Swarm produces an event.
            event = session.swarm.select_next_some() => {
                handle_swarm_event(&app, &mut session, &cipher, &mut nat_status, event).await;
            }

            _ = diagnostics_tick.tick() => {
                let snap = snapshot(&mut session, local_peer_id, nat_status);
                let _ = app.emit("p2p-diagnostics", &snap);
            }

            _ = bootstrap_tick.tick() => {
                // Periodically refresh DHT routing table.
                if let Err(err) = session.swarm.behaviour_mut().kademlia.bootstrap() {
                    tracing::debug!("kad bootstrap retry failed: {err}");
                }
            }
        }
    }
}

fn snapshot(
    session: &mut Libp2pSession,
    local_peer_id: PeerId,
    nat_status: NatStatus,
) -> DiagnosticsSnapshot {
    let listen_addrs = session
        .swarm
        .listeners()
        .map(|a| a.to_string())
        .collect::<Vec<_>>();
    let external_addrs = session
        .swarm
        .external_addresses()
        .map(|a| a.to_string())
        .collect::<Vec<_>>();
    let topic_hash = session.gossip_topic.hash();
    let gossip_neighbors = session
        .swarm
        .behaviour_mut()
        .gossipsub
        .mesh_peers(&topic_hash)
        .count();
    let kad_peers: usize = session
        .swarm
        .behaviour_mut()
        .kademlia
        .kbuckets()
        .map(|b| b.num_entries())
        .sum();

    DiagnosticsSnapshot {
        local_peer_id: local_peer_id.to_string(),
        listen_addrs,
        external_addrs,
        kad_peers,
        gossip_neighbors,
        joined_peers: session.joined_peers.len(),
        nat_status,
    }
}

async fn handle_swarm_event(
    app: &tauri::AppHandle,
    session: &mut Libp2pSession,
    cipher: &SessionCipher,
    nat_status: &mut NatStatus,
    event: SwarmEvent<StreamSyncBehaviourEvent>,
) {
    match event {
        SwarmEvent::NewListenAddr { address, .. } => {
            tracing::info!("listening on {address}");
            let _ = app.emit("p2p-listen-addr", address.to_string());
        }
        SwarmEvent::ExternalAddrConfirmed { address } => {
            tracing::info!("external addr confirmed: {address}");
            let _ = app.emit("p2p-external-addr", address.to_string());
        }
        SwarmEvent::Behaviour(ev) => match ev {
            StreamSyncBehaviourEvent::Gossipsub(g) => {
                let local_id = session.local_peer_id;
                handle_gossip_event(app, cipher, local_id, g).await;
            }
            StreamSyncBehaviourEvent::Mdns(m) => match m {
                mdns::Event::Discovered(list) => {
                    for (peer, addr) in list {
                        tracing::debug!("mdns discovered {peer} at {addr}");
                        session
                            .swarm
                            .behaviour_mut()
                            .kademlia
                            .add_address(&peer, addr.clone());
                        // Eagerly dial LAN peers so gossipsub can mesh quickly.
                        if let Err(err) = session.swarm.dial(addr.clone()) {
                            tracing::debug!("mdns dial {addr} failed: {err}");
                        }
                    }
                }
                mdns::Event::Expired(_) => {}
            },
            StreamSyncBehaviourEvent::Kademlia(_) => {
                // Routing-table churn is interesting for diagnostics only;
                // the 30s tick already reports peer counts.
            }
            StreamSyncBehaviourEvent::Identify(id_ev) => {
                if let identify::Event::Received { peer_id, info, .. } = id_ev {
                    for addr in &info.listen_addrs {
                        session
                            .swarm
                            .behaviour_mut()
                            .kademlia
                            .add_address(&peer_id, addr.clone());
                    }
                }
            }
            StreamSyncBehaviourEvent::Autonat(an) => {
                if let autonat::Event::StatusChanged { new, .. } = an {
                    *nat_status = match new {
                        autonat::NatStatus::Public(_) => NatStatus::Public,
                        autonat::NatStatus::Private => NatStatus::Private,
                        autonat::NatStatus::Unknown => NatStatus::Unknown,
                    };
                    let _ = app.emit(
                        "p2p-nat-status",
                        serde_json::json!({ "status": nat_status }),
                    );
                }
            }
            StreamSyncBehaviourEvent::RelayClient(_)
            | StreamSyncBehaviourEvent::Dcutr(_)
            | StreamSyncBehaviourEvent::Ping(_) => {}
        },
        SwarmEvent::ConnectionEstablished { peer_id, .. } => {
            if session.joined_peers.insert(peer_id) {
                let _ = app.emit("p2p-peer-joined", peer_id.to_string());
            }
        }
        SwarmEvent::ConnectionClosed { peer_id, num_established, .. } => {
            if num_established == 0 && session.joined_peers.remove(&peer_id) {
                let _ = app.emit("p2p-peer-left", peer_id.to_string());
            }
        }
        _ => {}
    }
}

async fn handle_gossip_event(
    app: &tauri::AppHandle,
    cipher: &SessionCipher,
    local_peer_id: PeerId,
    ev: gossipsub::Event,
) {
    match ev {
        gossipsub::Event::Message {
            propagation_source,
            message,
            ..
        } => {
            let envelope = match GossipEnvelope::open(cipher, &message.data) {
                Ok(env) => env,
                Err(err) => {
                    tracing::warn!(
                        "drop gossip frame from {propagation_source}: {err}"
                    );
                    return;
                }
            };

            // The gossipsub layer already verified the sender's libp2p
            // signature (MessageAuthenticity::Signed). Reject envelopes
            // whose embedded sender_peer_id disagrees with the signed
            // source — a peer with the share code could otherwise spoof
            // the host's PeerId in the body.
            if let Some(signed_source) = message.source {
                if envelope.sender_peer_id != signed_source.to_string() {
                    tracing::warn!(
                        "drop gossip frame: envelope sender {} != signed source {}",
                        envelope.sender_peer_id,
                        signed_source
                    );
                    return;
                }
            }

            // Drop directed messages not addressed to us.
            if let Some(target) = &envelope.target_peer_id {
                let me = local_peer_id.to_string();
                if target != &me {
                    return;
                }
            }

            let _ = app.emit("p2p-gossip", &envelope);
        }
        gossipsub::Event::Subscribed { peer_id, topic } => {
            tracing::debug!("{peer_id} subscribed to {topic}");
        }
        gossipsub::Event::Unsubscribed { peer_id, topic } => {
            tracing::debug!("{peer_id} unsubscribed from {topic}");
        }
        _ => {}
    }
}
