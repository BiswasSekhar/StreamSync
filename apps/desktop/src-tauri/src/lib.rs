pub mod commands;
pub mod engine;
pub mod error;
pub mod state;

use std::sync::Arc;
use tauri::Manager;
use engine::signaller::CurrentFilePath;
use tokio::sync::RwLock;

use commands::{file::*, session::*, torrent::*};

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
            // This is how bundled ffmpeg/ffprobe binaries are found at runtime
            if let Ok(resource_dir) = app.path().resource_dir() {
                std::env::set_var("TAURI_RESOURCE_DIR", resource_dir.to_string_lossy().as_ref());
                tracing::info!("Resource dir: {}", resource_dir.display());
            }

            let cf = app.state::<CurrentFilePath>().inner().clone();

            // Start signalling server on background thread
            tauri::async_runtime::spawn(async move {
                // Find receiver-web dist path
                if let Err(e) = engine::signaller::create_signalling_server(
                    8787,
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
            prepare_video_for_streaming,
            start_seeding_original,
            load_torrent_file,
            create_room,
            close_room,
            get_session_status,
            get_magnet,
            load_magnet_link,
            get_torrent_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
