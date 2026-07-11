//! libp2p signaling + NAT-traversal layer.
//!
//! See plan section "Signaling/NAT-traversal layer: rust-libp2p" in
//! `C:\Users\biswa\.claude\plans\ok-after-analysing-how-fuzzy-shell.md`.
//!
//! ## Responsibilities
//!
//! - Build a long-lived libp2p `Swarm` per session with QUIC + Noise + Yamux.
//! - Compose `kad`, `gossipsub`, `identify`, `mdns`, `autonat`, `relay`,
//!   `dcutr`, `ping` behaviours.
//! - Derive the host's Ed25519 identity from the share code (via
//!   `share_code::derive_libp2p_seed`) so guests can verify host events
//!   without paste-the-PeerId UX. Guests use ephemeral random keys.
//! - Subscribe to the share-code-derived gossipsub topic.
//! - Publish encrypted gossip events; receive + decrypt incoming ones.
//!
//! ## What's NOT in this module
//!
//! - Encrypted envelope encode/decode: lives in [`super::session_cipher`].
//! - Event dispatch to the Tauri side: lives in `commands::p2p` (Phase 3).
//! - Reconnect / supervisor: lives in `libp2p_supervisor` (Phase 1 cont.).

use std::collections::HashSet;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use libp2p::{
    autonat, dcutr, gossipsub, identify, identity, kad, mdns, noise, ping, relay,
    swarm::NetworkBehaviour,
    tcp, yamux, Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder,
};

/// Public IPFS DHT bootstrap nodes — community-operated infrastructure.
/// We connect on session start so Kademlia has anchors to walk from when
/// finding peers under our gossip topic.
///
/// These are NOT servers we operate; if all of them disappear the user
/// can override via settings (TODO Phase 5).
pub const IPFS_BOOTSTRAP_NODES: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
];

/// Application-level identify protocol — purely informational, lets
/// peers know they're talking to a StreamSync node and which version.
const IDENTIFY_PROTOCOL: &str = "/streamsync/identify/1.0.0";

/// Gossipsub mesh defaults — small mesh that scales to ~12 peers.
const GOSSIPSUB_MESH_LO: usize = 4;
const GOSSIPSUB_MESH_N: usize = 6;
const GOSSIPSUB_MESH_HI: usize = 12;
const GOSSIPSUB_HEARTBEAT_SECS: u64 = 1;

/// Whether this node is the deterministic-PeerId host or an ephemeral guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeRole {
    Host,
    Guest,
}

/// Composed behaviour for the StreamSync libp2p stack. Each field is one
/// of the protocols enumerated in the plan; the macro generates an
/// `Event` enum aggregating all sub-behaviour events.
#[derive(NetworkBehaviour)]
pub struct StreamSyncBehaviour {
    pub gossipsub: gossipsub::Behaviour,
    pub kademlia: kad::Behaviour<kad::store::MemoryStore>,
    pub identify: identify::Behaviour,
    pub mdns: mdns::tokio::Behaviour,
    pub autonat: autonat::Behaviour,
    pub relay_client: relay::client::Behaviour,
    pub dcutr: dcutr::Behaviour,
    pub ping: ping::Behaviour,
}

/// Build a libp2p `Keypair` deterministically from a 32-byte seed
/// (host) or freshly at random (guest).
pub fn build_keypair(role: NodeRole, seed: Option<[u8; 32]>) -> Result<identity::Keypair> {
    match (role, seed) {
        (NodeRole::Host, Some(mut bytes)) => {
            // `from_bytes` consumes and zeroizes; clone so we can panic-print
            // for debugging if it fails.
            let key = identity::ed25519::SecretKey::try_from_bytes(&mut bytes)
                .map_err(|e| anyhow!("invalid libp2p ed25519 seed: {e}"))?;
            Ok(identity::Keypair::from(identity::ed25519::Keypair::from(key)))
        }
        (NodeRole::Host, None) => {
            anyhow::bail!("host must be constructed with a deterministic share-code seed")
        }
        (NodeRole::Guest, _) => Ok(identity::Keypair::generate_ed25519()),
    }
}

/// Top-level handle for one active libp2p session.
pub struct Libp2pSession {
    pub swarm: Swarm<StreamSyncBehaviour>,
    pub local_peer_id: PeerId,
    pub role: NodeRole,
    pub gossip_topic: gossipsub::IdentTopic,
    pub joined_peers: HashSet<PeerId>,
}

impl Libp2pSession {
    /// Build a new swarm with all behaviours composed. Does not yet
    /// listen on any address — call [`Self::listen_quic`] to start
    /// listening; bootstrap via [`Self::bootstrap_dht`].
    pub fn build(
        keypair: identity::Keypair,
        role: NodeRole,
        gossip_topic_bytes: [u8; 32],
    ) -> Result<Self> {
        let local_peer_id = PeerId::from(keypair.public());

        // gossipsub: small mesh for 10–12-peer sessions.
        let gossipsub_config = gossipsub::ConfigBuilder::default()
            .heartbeat_interval(Duration::from_secs(GOSSIPSUB_HEARTBEAT_SECS))
            .mesh_n(GOSSIPSUB_MESH_N)
            .mesh_n_low(GOSSIPSUB_MESH_LO)
            .mesh_n_high(GOSSIPSUB_MESH_HI)
            .validation_mode(gossipsub::ValidationMode::Strict)
            .max_transmit_size(256 * 1024) // 256 KiB cap per gossip frame
            .build()
            .map_err(|e| anyhow!("gossipsub config invalid: {e}"))?;

        let topic_str = format!("streamsync/{}", hex::encode(gossip_topic_bytes));
        let gossip_topic = gossipsub::IdentTopic::new(topic_str);

        // Kademlia DHT — used for discovering peers under our gossip topic.
        let kad_store = kad::store::MemoryStore::new(local_peer_id);
        let mut kad_config = kad::Config::new(StreamProtocol::new("/streamsync/kad/1.0.0"));
        kad_config.set_query_timeout(Duration::from_secs(30));

        // Identify — advertises capability/agent. Peers use it to know
        // we're a StreamSync node and to learn our observed external
        // addresses (essential for hole-punching).
        let identify_config =
            identify::Config::new(IDENTIFY_PROTOCOL.to_string(), keypair.public())
                .with_agent_version(format!("streamsync/{}", env!("CARGO_PKG_VERSION")));

        // mDNS — LAN peer discovery.
        let mdns_behaviour = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)
            .context("failed to start mdns")?;

        // AutoNAT — detect whether we're publicly reachable.
        let autonat_behaviour = autonat::Behaviour::new(local_peer_id, autonat::Config::default());

        // ping — keepalive + RTT.
        let ping_behaviour = ping::Behaviour::new(ping::Config::new());

        // Swarm build. `with_relay_client` is what wires DCUtR + the
        // relay client behaviour up against the transport so we can
        // dial peers via /p2p-circuit when hole-punch fails.
        let swarm = SwarmBuilder::with_existing_identity(keypair.clone())
            .with_tokio()
            .with_tcp(
                tcp::Config::default().nodelay(true),
                noise::Config::new,
                yamux::Config::default,
            )
            .map_err(|e| anyhow!("tcp transport build: {e}"))?
            .with_quic()
            .with_dns()
            .map_err(|e| anyhow!("dns transport build: {e}"))?
            .with_relay_client(noise::Config::new, yamux::Config::default)
            .map_err(|e| anyhow!("relay client transport build: {e}"))?
            .with_behaviour(|key, relay_client_behaviour| {
                let gossipsub = gossipsub::Behaviour::new(
                    gossipsub::MessageAuthenticity::Signed(key.clone()),
                    gossipsub_config,
                )?;

                let kademlia = kad::Behaviour::with_config(local_peer_id, kad_store, kad_config);

                let identify = identify::Behaviour::new(identify_config);

                let dcutr = dcutr::Behaviour::new(local_peer_id);

                Ok(StreamSyncBehaviour {
                    gossipsub,
                    kademlia,
                    identify,
                    mdns: mdns_behaviour,
                    autonat: autonat_behaviour,
                    relay_client: relay_client_behaviour,
                    dcutr,
                    ping: ping_behaviour,
                })
            })
            .map_err(|e| anyhow!("behaviour build: {e}"))?
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
            .build();

        Ok(Self {
            swarm,
            local_peer_id,
            role,
            gossip_topic,
            joined_peers: HashSet::new(),
        })
    }

    /// Listen on a random UDP port (QUIC) on all interfaces, IPv4 + IPv6.
    pub fn listen_quic(&mut self) -> Result<()> {
        // QUIC v1 over UDP, both IPv4 and IPv6, ephemeral port.
        let v4: Multiaddr = "/ip4/0.0.0.0/udp/0/quic-v1".parse()?;
        let v6: Multiaddr = "/ip6/::/udp/0/quic-v1".parse()?;
        self.swarm.listen_on(v4).context("listen IPv4 QUIC")?;
        // IPv6 may fail on hosts without IPv6 stack — log but don't error.
        if let Err(err) = self.swarm.listen_on(v6) {
            tracing::warn!("ipv6 QUIC listen failed (non-fatal): {err}");
        }
        Ok(())
    }

    /// Dial each public IPFS bootstrap node so Kademlia has known peers.
    /// Returns the number of addresses successfully queued for dialing.
    pub fn dial_bootstrap_peers(&mut self) -> Result<usize> {
        let mut queued = 0usize;
        for raw in IPFS_BOOTSTRAP_NODES {
            let addr: Multiaddr = match raw.parse() {
                Ok(a) => a,
                Err(e) => {
                    tracing::warn!("bad bootstrap multiaddr {raw}: {e}");
                    continue;
                }
            };
            // Inject the peer-id at the tail of the multiaddr into the
            // Kademlia routing table so it has anchors.
            if let Some(peer_id) = peer_id_from_multiaddr(&addr) {
                self.swarm
                    .behaviour_mut()
                    .kademlia
                    .add_address(&peer_id, addr.clone());
            }
            if let Err(err) = self.swarm.dial(addr.clone()) {
                tracing::warn!("dial bootstrap {addr} failed: {err}");
            } else {
                queued += 1;
            }
        }
        Ok(queued)
    }

    /// Subscribe to the share-code-derived gossipsub topic. Idempotent.
    pub fn subscribe_topic(&mut self) -> Result<()> {
        self.swarm
            .behaviour_mut()
            .gossipsub
            .subscribe(&self.gossip_topic)
            .map_err(|e| anyhow!("gossipsub subscribe failed: {e}"))?;
        Ok(())
    }

    /// Kick off a Kademlia bootstrap query — populates our routing table
    /// from the bootstrap peers we just dialed.
    pub fn bootstrap_dht(&mut self) -> Result<()> {
        self.swarm
            .behaviour_mut()
            .kademlia
            .bootstrap()
            .map_err(|e| anyhow!("kademlia bootstrap failed: {e}"))?;
        Ok(())
    }

    /// Publish a raw (already-encrypted) gossip envelope.
    /// Callers should `SessionCipher::encrypt(...)` first.
    pub fn publish_raw(&mut self, envelope: Vec<u8>) -> Result<gossipsub::MessageId> {
        let topic = self.gossip_topic.clone();
        self.swarm
            .behaviour_mut()
            .gossipsub
            .publish(topic, envelope)
            .map_err(|e| anyhow!("gossipsub publish failed: {e}"))
    }
}

/// Extract the trailing `/p2p/<PeerId>` component of a multiaddr.
fn peer_id_from_multiaddr(addr: &Multiaddr) -> Option<PeerId> {
    addr.iter().find_map(|proto| match proto {
        libp2p::multiaddr::Protocol::P2p(pid) => Some(pid),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_seed() -> [u8; 32] {
        let mut s = [0u8; 32];
        for (i, b) in s.iter_mut().enumerate() {
            *b = i as u8;
        }
        s
    }

    #[test]
    fn host_keypair_is_deterministic() {
        let k1 = build_keypair(NodeRole::Host, Some(fixed_seed())).unwrap();
        let k2 = build_keypair(NodeRole::Host, Some(fixed_seed())).unwrap();
        assert_eq!(PeerId::from(k1.public()), PeerId::from(k2.public()));
    }

    #[test]
    fn guest_keypair_is_random() {
        let k1 = build_keypair(NodeRole::Guest, None).unwrap();
        let k2 = build_keypair(NodeRole::Guest, None).unwrap();
        assert_ne!(PeerId::from(k1.public()), PeerId::from(k2.public()));
    }

    #[test]
    fn host_requires_seed() {
        assert!(build_keypair(NodeRole::Host, None).is_err());
    }

    #[tokio::test]
    async fn session_builds_and_subscribes() {
        let keypair = build_keypair(NodeRole::Host, Some(fixed_seed())).unwrap();
        let mut session =
            Libp2pSession::build(keypair, NodeRole::Host, fixed_seed()).expect("build session");
        session.subscribe_topic().expect("subscribe");
        assert!(!session.local_peer_id.to_string().is_empty());
    }

    #[test]
    fn bootstrap_multiaddrs_parse() {
        for raw in IPFS_BOOTSTRAP_NODES {
            let addr: Multiaddr = raw.parse().unwrap_or_else(|e| panic!("{raw}: {e}"));
            assert!(peer_id_from_multiaddr(&addr).is_some());
        }
    }
}
