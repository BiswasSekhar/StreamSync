use std::path::PathBuf;
use std::sync::Arc;
use anyhow::Context;
use tauri::Emitter;

use crate::state::{AppState, AppEvent, TorrentState};

const DEFAULT_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.internetwarriors.net:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.cyberia.is:6969/announce",
    "http://tracker.openbittorrent.com:80/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
];

fn default_trackers() -> Vec<String> {
    DEFAULT_TRACKERS.iter().map(|tracker| (*tracker).to_string()).collect()
}

fn append_trackers_to_magnet(mut magnet: String) -> String {
    for tracker in DEFAULT_TRACKERS {
        magnet.push_str("&tr=");
        magnet.push_str(&urlencoding::encode(tracker));
    }
    magnet
}

/// Start seeding a completed file as a torrent using librqbit.
/// Must be called AFTER FFmpeg has finished encoding (file must be complete
/// for create_torrent to hash all pieces correctly).
pub async fn start_seeding(
    file_path: PathBuf,
    state: Arc<AppState>,
    app: tauri::AppHandle,
) -> anyhow::Result<()> {
    use librqbit::{Session, SessionOptions, AddTorrent, AddTorrentOptions, CreateTorrentOptions};
    use librqbit::create_torrent;

    let output_dir = file_path.parent()
        .context("No parent directory for output file")?
        .to_path_buf();

    tracing::info!("Creating torrent from: {:?}", file_path);

    // Step 1: Create torrent metadata from the completed file and serialize to bytes
    let torrent_bytes = create_torrent(
        &file_path,
        CreateTorrentOptions {
            name: None, // DO NOT OVERRIDE. librqbit needs to find the real file name to seed it.
            piece_length: Some(512 * 1024), // 512KB pieces
        },
    ).await
    .context("Failed to create torrent from file")?
    .as_bytes()
    .context("Failed to serialize torrent")?;

    tracing::info!("Torrent created, adding to session");

    // Step 2: Create librqbit session with DHT disabled.
    // DHT often fails inside desktop apps (port conflicts, firewall) and kills the session.
    // We rely on WebTorrent trackers for peer discovery instead.
    let mut opts = SessionOptions::default();
    opts.listen_port_range = Some(6881..65535);

    let session = Session::new_with_opts(output_dir, opts)
        .await
        .context("Failed to create librqbit session")?;

    tracing::info!("librqbit session created, adding torrent for seeding");

    let trackers = default_trackers();
    let add_result = session.add_torrent(
        AddTorrent::from_bytes(torrent_bytes),
        Some(AddTorrentOptions {
            only_files: None,
            overwrite: true,
            trackers: Some(trackers.clone()),
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

    let info_hash = handle.info_hash();
    let hash_hex = hex::encode(info_hash.0);

    let file_name = file_path.file_name().unwrap().to_string_lossy();
    let encoded_name = urlencoding::encode(&file_name);

    let magnet = append_trackers_to_magnet(format!(
        "magnet:?xt=urn:btih:{}&dn={}",
        hash_hex, encoded_name
    ));

    tracing::info!("Torrent magnet: {}", magnet);

    // Update torrent state
    {
        let mut torrent_state = state.torrent.lock().await;
        *torrent_state = Some(TorrentState {
            magnet_link: magnet.clone(),
            piece_count: 0,
            pieces_ready: 0,
            upload_speed: 0,
            download_speed: 0,
            peer_count: 0,
            is_seeder: true,
            file_name: None,
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
                t.download_speed = (live.download_speed.mbps * 1_000_000.0 / 8.0) as u64;
                t.peer_count = live.snapshot.peer_stats.live as u32;
            }
        }
    }
}

// ─── External torrent loading (download from swarm) ───────────────────────────

/// Load an existing .torrent file, download it sequentially, and start serving
/// the video via librqbit. Sets `current_file` once the first video file appears
/// on disk so the host's /host-video endpoint can stream it immediately.
pub async fn load_external_torrent(
    torrent_path: PathBuf,
    download_dir: PathBuf,
    state: Arc<AppState>,
    app: tauri::AppHandle,
    current_file: Arc<tokio::sync::RwLock<Option<String>>>,
) -> anyhow::Result<()> {
    use librqbit::{Session, SessionOptions, AddTorrent, AddTorrentOptions};

    let torrent_bytes = tokio::fs::read(&torrent_path)
        .await
        .context("Failed to read .torrent file")?;

    tokio::fs::create_dir_all(&download_dir)
        .await
        .context("Failed to create download directory")?;

    tracing::info!("Loading external torrent into: {:?}", download_dir);

    let mut opts = SessionOptions::default();
    opts.disable_dht = true;
    opts.disable_dht_persistence = true;
    opts.listen_port_range = Some(6881..65535);

    let session = Session::new_with_opts(download_dir.clone(), opts)
        .await
        .context("Failed to create librqbit session")?;

    let add_result = session
        .add_torrent(
            AddTorrent::from_bytes(torrent_bytes),
            Some(AddTorrentOptions {
                overwrite: true,
                trackers: Some(default_trackers()),
                ..Default::default()
            }),
        )
        .await
        .context("Failed to add external torrent")?;

    let handle = match add_result {
        librqbit::AddTorrentResponse::AlreadyManaged(_, h) => h,
        librqbit::AddTorrentResponse::Added(_, h) => h,
        librqbit::AddTorrentResponse::ListOnly(_) => {
            return Err(anyhow::anyhow!("Unexpected ListOnly response"));
        }
    };

    let info_hash = handle.info_hash();
    let hash_hex = hex::encode(info_hash.0);

    let magnet = append_trackers_to_magnet(format!("magnet:?xt=urn:btih:{}", hash_hex));

    tracing::info!("External torrent magnet: {}", magnet);

    {
        let mut ts = state.torrent.lock().await;
        *ts = Some(TorrentState {
            magnet_link: magnet.clone(),
            piece_count: 0,
            pieces_ready: 0,
            upload_speed: 0,
            download_speed: 0,
            peer_count: 0,
            is_seeder: false,
            file_name: None,
        });
    }

    {
        let mut sess = state.session.lock().await;
        if let Some(ref mut s) = *sess {
            s.magnet_link = Some(magnet.clone());
        }
    }

    state.emit(AppEvent::MagnetReady { magnet: magnet.clone() });
    let _ = app.emit("magnet-ready", serde_json::json!({ "magnet": magnet }));

    // Spawn background task: poll the download dir until a video file appears,
    // then set CurrentFilePath so /host-video can serve it.
    let download_dir_watch = download_dir.clone();
    let current_file_watch = current_file.clone();
    let app_watch = app.clone();
    let state_watch = Arc::clone(&state);
    tokio::spawn(async move {
        for _ in 0..180 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

            if let Some((video_path, _size)) = find_largest_video(&download_dir_watch).await {
                let path_str = video_path.to_string_lossy().to_string();
                let file_name = video_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "video".to_string());

                {
                    let mut guard = current_file_watch.write().await;
                    *guard = Some(path_str.clone());
                }

                // Update torrent state with the discovered file name
                {
                    let mut ts = state_watch.torrent.lock().await;
                    if let Some(ref mut t) = *ts {
                        t.file_name = Some(file_name.clone());
                    }
                }

                let _ = app_watch.emit(
                    "torrent-video-ready",
                    serde_json::json!({
                        "fileName": file_name,
                        "filePath": path_str,
                    }),
                );
                tracing::info!("Torrent video file detected on disk: {}", path_str);
                break;
            }
        }
    });

    // Spawn download progress monitor
    tokio::spawn(monitor_download_stats(handle, state, app, session));

    Ok(())
}

pub async fn load_magnet(
    magnet_link: String,
    download_dir: PathBuf,
    state: Arc<AppState>,
    app: tauri::AppHandle,
    current_file: Arc<tokio::sync::RwLock<Option<String>>>,
) -> anyhow::Result<()> {
    use librqbit::{Session, SessionOptions, AddTorrent, AddTorrentOptions};

    tokio::fs::create_dir_all(&download_dir)
        .await
        .context("Failed to create download directory")?;

    tracing::info!("Loading magnet link into: {:?}", download_dir);

    let mut opts = SessionOptions::default();
    opts.listen_port_range = Some(6881..65535);

    let session = Session::new_with_opts(download_dir.clone(), opts)
        .await
        .context("Failed to create librqbit session")?;

    // librqbit AddTorrent Enum supports From<String> for URLs/magnets
    let add_result = session
        .add_torrent(
            AddTorrent::from_url(&magnet_link),
            Some(AddTorrentOptions {
                overwrite: true,
                trackers: Some(default_trackers()),
                ..Default::default()
            }),
        )
        .await
        .context("Failed to add magnet link torrent")?;

    let handle = match add_result {
        librqbit::AddTorrentResponse::AlreadyManaged(_, h) => h,
        librqbit::AddTorrentResponse::Added(_, h) => h,
        librqbit::AddTorrentResponse::ListOnly(_) => {
            return Err(anyhow::anyhow!("Unexpected ListOnly response"));
        }
    };

    tracing::info!("Magnet link torrent added to session");

    {
        let mut ts = state.torrent.lock().await;
        *ts = Some(TorrentState {
            magnet_link: magnet_link.clone(),
            piece_count: 0,
            pieces_ready: 0,
            upload_speed: 0,
            download_speed: 0,
            peer_count: 0,
            is_seeder: false,
            file_name: None,
        });
    }

    {
        let mut sess = state.session.lock().await;
        if let Some(ref mut s) = *sess {
            s.magnet_link = Some(magnet_link.clone());
        }
    }

    // Usually we don't emit magnet-ready here because it was already ready, but for consistency:
    state.emit(AppEvent::MagnetReady { magnet: magnet_link.clone() });

    let download_dir_watch = download_dir.clone();
    let current_file_watch = current_file.clone();
    let app_watch = app.clone();
    let state_watch = Arc::clone(&state);
    tokio::spawn(async move {
        for _ in 0..180 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

            if let Some((video_path, _size)) = find_largest_video(&download_dir_watch).await {
                let path_str = video_path.to_string_lossy().to_string();
                let file_name = video_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "video".to_string());

                {
                    let mut guard = current_file_watch.write().await;
                    *guard = Some(path_str.clone());
                }

                // Update torrent state with the discovered file name
                {
                    let mut ts = state_watch.torrent.lock().await;
                    if let Some(ref mut t) = *ts {
                        t.file_name = Some(file_name.clone());
                    }
                }

                let _ = app_watch.emit(
                    "torrent-video-ready",
                    serde_json::json!({
                        "fileName": file_name,
                        "filePath": path_str,
                    }),
                );
                tracing::info!("Torrent video file detected on disk: {}", path_str);
                break;
            }
        }
    });

    // Spawn download progress monitor
    tokio::spawn(monitor_download_stats(handle, state, app, session));

    Ok(())
}

/// Iteratively walk `dir` and return the largest video file found so far.
/// Uses a stack instead of recursion to avoid async recursive futures.
async fn find_largest_video(dir: &PathBuf) -> Option<(PathBuf, u64)> {
    const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "avi", "mov", "webm", "ts", "m4v", "wmv"];
    let mut stack = vec![dir.clone()];
    let mut best: Option<(PathBuf, u64)> = None;

    while let Some(current) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            let meta = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push(path);
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if VIDEO_EXTS.contains(&ext.to_lowercase().as_str()) {
                    let size = meta.len();
                    // Accept file if it has been written to (size > 0)
                    if size > 0 && best.as_ref().map(|(_, s)| size > *s).unwrap_or(true) {
                        best = Some((path, size));
                    }
                }
            }
        }
    }

    best
}

/// Monitor download speed, upload speed, and peer count for an external torrent.
/// Emits `torrent-progress` events to the frontend every 2 seconds.
async fn monitor_download_stats(
    handle: Arc<librqbit::ManagedTorrent>,
    state: Arc<AppState>,
    app: tauri::AppHandle,
    _session: Arc<librqbit::Session>,
) {
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        let stats = handle.stats();
        let Some(live) = stats.live else { continue };

        let download_speed_bps = (live.download_speed.mbps * 1_000_000.0 / 8.0) as u64;
        let upload_speed_bps = (live.upload_speed.mbps * 1_000_000.0 / 8.0) as u64;
        let peer_count = live.snapshot.peer_stats.live as u32;
        let have_bytes = live.snapshot.downloaded_and_checked_bytes;
        // StatsSnapshot has no total_bytes field; use fetched_bytes as a proxy
        // for how much has been transferred so far (frontend hides bar when 0)
        let total_bytes: u64 = 0;

        {
            let mut ts = state.torrent.lock().await;
            if let Some(ref mut t) = *ts {
                t.upload_speed = upload_speed_bps;
                t.download_speed = download_speed_bps;
                t.peer_count = peer_count;
            }
        }

        let _ = app.emit(
            "torrent-progress",
            serde_json::json!({
                "downloadSpeedBps": download_speed_bps,
                "haveBytes": have_bytes,
                "totalBytes": total_bytes,
                "peerCount": peer_count,
            }),
        );
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
        "downloadSpeedBps": t.download_speed,
        "peerCount": t.peer_count,
        "isSeeder": t.is_seeder,
        "fileName": t.file_name,
    }))
}
