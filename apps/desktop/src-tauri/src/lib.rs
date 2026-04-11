pub mod commands;
pub mod engine;
pub mod error;
pub mod state;

use std::sync::Arc;
use tauri::Manager;

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

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state.clone())
        .setup(|app| {
            let state = app.state::<Arc<state::AppState>>();
            let _state_clone = Arc::clone(&state);
            let _app_handle = app.handle().clone();

            // Start signalling server on background thread
            tauri::async_runtime::spawn(async move {
                // Find receiver-web dist path
                let dist_path = find_receiver_web_dist();
                tracing::info!("Receiver web dist: {:?}", dist_path);

                if let Err(e) = engine::signaller::create_signalling_server(
                    8787,
                    dist_path,
                )
                .await
                {
                    tracing::error!("Signalling server error: {}", e);
                }
            });

            // Detect hardware encoders at startup
            let state2 = app.state::<Arc<state::AppState>>();
            let state2_clone = Arc::clone(&state2);
            tauri::async_runtime::spawn(async move {
                match engine::ffmpeg::detect_hw_encoders().await {
                    Ok(encoders) => {
                        tracing::info!("Available encoders: {:?}", encoders);
                        let mut enc = state2_clone.encoder.lock().await;
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
