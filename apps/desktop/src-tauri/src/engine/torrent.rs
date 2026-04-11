use std::path::PathBuf;
use std::sync::Arc;
use anyhow::Context;
use tauri::Emitter;

use crate::state::{AppState, AppEvent, TorrentState};

/// Start seeding a completed file as a torrent using librqbit.
/// Must be called AFTER FFmpeg has finished encoding (file must be complete
/// for create_torrent to hash all pieces correctly).
pub async fn start_seeding(
    file_path: PathBuf,
    state: Arc<AppState>,
    app: tauri::AppHandle,
) -> anyhow::Result<()> {
    use librqbit::{Session, AddTorrent, AddTorrentOptions, CreateTorrentOptions};
    use librqbit::create_torrent;

    let output_dir = file_path.parent()
        .context("No parent directory for output file")?
        .to_path_buf();

    tracing::info!("Creating torrent from: {:?}", file_path);

    // Step 1: Create torrent metadata from the completed file and serialize to bytes
    let torrent_bytes = create_torrent(
        &file_path,
        CreateTorrentOptions {
            name: Some("streamsync"),
            piece_length: Some(512 * 1024), // 512KB pieces
        },
    ).await
    .context("Failed to create torrent from file")?
    .as_bytes()
    .context("Failed to serialize torrent")?;

    tracing::info!("Torrent created, adding to session");

    // Step 2: Create librqbit session and add the torrent for seeding
    let session = Session::new(output_dir)
        .await
        .context("Failed to create librqbit session")?;

    let add_result = session.add_torrent(
        AddTorrent::from_bytes(torrent_bytes),
        Some(AddTorrentOptions {
            only_files: None,
            trackers: Some(vec![
                "udp://tracker.opentrackr.org:1337/announce".to_string(),
                "udp://open.stealth.si:80/announce".to_string(),
                "wss://tracker.webtorrent.dev".to_string(),
                "wss://tracker.openwebtorrent.com".to_string(),
            ]),
            ..Default::default()
        }),
    ).await
    .context("Failed to add torrent to session")?;

    let handle = match add_result {
        librqbit::AddTorrentResponse::AlreadyManaged(_, h) => h,
        librqbit::AddTorrentResponse::Added(_, h) => h,
        librqbit::AddTorrentResponse::ListOnly(_) => {
            return Err(anyhow::anyhow!("Unexpected ListOnly response"));
        }
    };

    // Build magnet link from handle's info hash
    let info_hash = handle.info_hash();
    let hash_hex = hex::encode(info_hash.0);
    let magnet = format!(
        "magnet:?xt=urn:btih:{}&dn=streamsync&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=wss%3A%2F%2Ftracker.webtorrent.dev",
        hash_hex
    );

    tracing::info!("Torrent magnet: {}", magnet);

    // Update torrent state
    {
        let mut torrent_state = state.torrent.lock().await;
        *torrent_state = Some(TorrentState {
            magnet_link: magnet.clone(),
            piece_count: 0,
            pieces_ready: 0,
            upload_speed: 0,
            peer_count: 0,
        });
    }

    // Store magnet in session state
    {
        let mut sess = state.session.lock().await;
        if let Some(ref mut s) = *sess {
            s.magnet_link = Some(magnet.clone());
        }
    }

    // Emit magnet ready event to frontend
    state.emit(AppEvent::MagnetReady { magnet: magnet.clone() });
    let _ = app.emit("magnet-ready", serde_json::json!({ "magnet": magnet }));

    // Keep session alive via spawn
    tokio::spawn(monitor_torrent_stats(handle, state, session));

    Ok(())
}

async fn monitor_torrent_stats(
    handle: Arc<librqbit::ManagedTorrent>,
    state: Arc<AppState>,
    _session: Arc<librqbit::Session>, // keep alive
) {
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        let stats = handle.stats();
        let mut ts = state.torrent.lock().await;
        if let Some(ref mut t) = *ts {
            if let Some(live) = stats.live {
                t.upload_speed = (live.upload_speed.mbps * 1_000_000.0 / 8.0) as u64;
                t.peer_count = live.snapshot.peer_stats.live as u32;
            }
        }
    }
}

pub async fn get_magnet_link(state: &AppState) -> Option<String> {
    state.torrent.lock().await
        .as_ref()
        .map(|t| t.magnet_link.clone())
}

pub async fn get_torrent_stats(state: &AppState) -> Option<serde_json::Value> {
    let ts = state.torrent.lock().await;
    ts.as_ref().map(|t| serde_json::json!({
        "magnetLink": t.magnet_link,
        "pieceCount": t.piece_count,
        "piecesReady": t.pieces_ready,
        "uploadSpeedBps": t.upload_speed,
        "peerCount": t.peer_count,
    }))
}
