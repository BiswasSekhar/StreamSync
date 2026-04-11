use std::sync::Arc;
use tauri::State;

use crate::engine::ffmpeg::{probe_video, start_encode_pipeline, VideoProbeResult};
use crate::state::{AppState, HwEncoder};

#[tauri::command]
pub async fn probe_file(
    path: String,
    _state: State<'_, Arc<AppState>>,
) -> Result<VideoProbeResult, String> {
    probe_video(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_encode(
    path: String,
    hw_override: Option<String>,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let hw = {
        let enc = state.encoder.lock().await;
        hw_override
            .as_deref()
            .and_then(parse_hw_encoder)
            .unwrap_or_else(|| enc.selected_hw.clone())
    };

    let state_clone = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(e) = start_encode_pipeline(path, hw, state_clone, app_handle).await {
            tracing::error!("Encode pipeline error: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn detect_hardware(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let encoders = crate::engine::ffmpeg::detect_hw_encoders()
        .await
        .map_err(|e| e.to_string())?;

    // Cache in state
    {
        let mut enc = state.encoder.lock().await;
        enc.available_hw = encoders.clone();
        if let Some(best) = encoders.first() {
            enc.selected_hw = best.clone();
        }
    }

    Ok(encoders.iter().map(|e| format!("{:?}", e)).collect())
}

#[tauri::command]
pub async fn get_encode_progress(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<serde_json::Value>, String> {
    let enc = state.encoder.lock().await;
    Ok(enc.progress.as_ref().map(|p| serde_json::to_value(p).unwrap_or_default()))
}

fn parse_hw_encoder(s: &str) -> Option<HwEncoder> {
    match s.to_lowercase().as_str() {
        "nvenc" => Some(HwEncoder::Nvenc),
        "amf" => Some(HwEncoder::Amf),
        "videotoolbox" => Some(HwEncoder::VideoToolbox),
        "qsv" => Some(HwEncoder::Qsv),
        "software" | "libx264" => Some(HwEncoder::Software),
        _ => None,
    }
}
