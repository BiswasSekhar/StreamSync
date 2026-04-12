pub mod commands;
pub mod engine;
pub mod error;
pub mod state;

use std::sync::Arc;
use tauri::Manager;
use engine::signaller::CurrentFilePath;
use tokio::sync::RwLock;

use commands::{file::*, session::*, torrent::*, tunnel::*};

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("streamsync=debug".parse().unwrap())
                .add_directive("librqbit=debug".parse().unwrap())
                .add_directive("librqbit_core=debug".parse().unwrap()),
        )
        .init();

    let app_state = state::AppState::new();
    // Shared current file path — written by start_seeding_original, read by /host-video
    let current_file: CurrentFilePath = Arc::new(RwLock::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state.clone())
        .manage(current_file.clone())
        .setup(|app| {
            // Expose the Tauri resource dir to resolve_binary() via env var
            // This is how bundled ffmpeg/ffprobe/cloudflared are found at runtime
            if let Ok(resource_dir) = app.path().resource_dir() {
                std::env::set_var("TAURI_RESOURCE_DIR", resource_dir.to_string_lossy().as_ref());
                tracing::info!("Resource dir: {}", resource_dir.display());
            }

            // Kill any stale cloudflared from previous crashed sessions
            engine::tunnel::kill_existing_cloudflared();

            let cf = app.state::<CurrentFilePath>().inner().clone();

            // Start signalling server on background thread
            tauri::async_runtime::spawn(async move {
                // Find receiver-web dist path
                let dist_path = find_receiver_web_dist();
                tracing::info!("Receiver web dist: {:?}", dist_path);

                if let Err(e) = engine::signaller::create_signalling_server(
                    8787,
                    dist_path,
                    cf,
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
            extract_subtitle_command,
            start_seeding_original,
            create_room,
            close_room,
            get_session_status,
            send_host_sync,
            broadcast_chat,
            get_magnet,
            get_torrent_stats,
            get_tunnel_url,
            check_cloudflared,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn find_receiver_web_dist() -> Option<String> {
    // Try common locations relative to the binary
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

    // Try relative to exe
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
