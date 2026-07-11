pub mod commands;
pub mod engine;
pub mod error;
pub mod state;

use std::sync::Arc;
use tauri::Manager;
use engine::signaller::CurrentFilePath;
use tokio::sync::RwLock;

use commands::{file::*, session::*, torrent::*, media_chunk::*, p2p::*};

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("streamsync=debug".parse().unwrap())
                .add_directive("librqbit=info".parse().unwrap())
                .add_directive("librqbit_core=info".parse().unwrap()),
        )
        .init();

    let app_state = state::AppState::new();
    // Shared current file path — written by start_seeding_original, read by read_video_chunk
    let current_file: CurrentFilePath = Arc::new(RwLock::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_libmpv::init())
        .manage(app_state.clone())
        .manage(current_file.clone())
        .setup(|app| {
            // Expose the Tauri resource dir to resolve_binary() via env var
            // This is how bundled ffmpeg/ffprobe binaries are found at runtime
            if let Ok(resource_dir) = app.path().resource_dir() {
                std::env::set_var("TAURI_RESOURCE_DIR", resource_dir.to_string_lossy().as_ref());
                tracing::info!("Resource dir: {}", resource_dir.display());
            }

            // Avoid stale background tunnel processes after crashes.
            engine::tunnel::kill_existing_cloudflared();

            let cf = app.state::<CurrentFilePath>().inner().clone();

            // Start signalling server on background thread
            tauri::async_runtime::spawn(async move {
                let dist_path = find_receiver_web_dist();
                if let Err(e) = engine::signaller::create_signalling_server(
                    8787,
                    dist_path,
                    cf,
                    app_state.clone(),
                )
                .await
                {
                    tracing::error!("Signalling server error: {}", e);
                }
            });

            // Detect hardware encoders at startup
            let enc_state = Arc::clone(app.state::<Arc<state::AppState>>().inner());
            tauri::async_runtime::spawn(async move {
                match engine::ffmpeg::detect_hw_encoders().await {
                    Ok(encoders) => {
                        tracing::info!("Available encoders: {:?}", encoders);
                        let mut enc = enc_state.encoder.lock().await;
                        enc.available_hw = encoders.clone();
                        if let Some(best) = encoders.first() {
                            enc.selected_hw = best.clone();
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Hardware detection failed: {}", e);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_file,
            detect_hardware,
            extract_subtitle_command,
            prepare_video_for_streaming,
            start_seeding_original,
            load_torrent_file,
            create_room,
            close_room,
            get_session_status,
            get_magnet,
            load_magnet_link,
            get_torrent_stats,
            read_video_chunk,
            get_video_size,
            // libp2p signaling layer (Phase 3)
            p2p_start_session,
            p2p_publish_event,
            p2p_get_stats,
            p2p_close_session,
            // BitTorrent content layer (Phase 3b)
            p2p_publish_file,
            p2p_open_magnet,
            p2p_open_torrent_file,
            p2p_get_active_torrent_stats,
            p2p_select_torrent_video,
            p2p_torrent_local_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn find_receiver_web_dist() -> Option<String> {
    let candidates = [
        "../../receiver-web/dist",
        "../receiver-web/dist",
        "receiver-web/dist",
    ];

    for candidate in &candidates {
        let path = std::path::Path::new(candidate);
        if path.exists() {
            return Some(candidate.to_string());
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let path = parent.join("receiver-web/dist");
            if path.exists() {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }

    None
}
