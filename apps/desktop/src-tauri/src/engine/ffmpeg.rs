use std::path::{Path, PathBuf};
use std::sync::Arc;
use anyhow::{anyhow, Context};
use tokio::io::{AsyncBufReadExt, BufReader};
use serde::{Deserialize, Serialize};

use tauri::Emitter;
use crate::state::{AppState, AppEvent, EncodeProgress, HwEncoder};

/// Resolve the path to a bundled binary (for example ffmpeg or ffprobe).
/// Checks all known locations in priority order:
/// 1. TAURI_RESOURCE_DIR env var (set by Tauri at runtime — works for all installs)
/// 2. Next to the current exe (portable / MSI with dest ".")
/// 3. resources/ subdir next to exe (dev mode)
/// 4. System PATH
pub fn resolve_binary(name: &str) -> String {
    #[cfg(target_os = "windows")]
    let exe = format!("{}.exe", name);
    #[cfg(not(target_os = "windows"))]
    let exe = name.to_string();

    // 1. Check Tauri resource dir (set at runtime by all install targets)
    if let Ok(resource_dir) = std::env::var("TAURI_RESOURCE_DIR") {
        let p = std::path::PathBuf::from(&resource_dir).join(&exe);
        if p.exists() {
            tracing::debug!("Using TAURI_RESOURCE_DIR binary: {}", p.display());
            return p.to_string_lossy().to_string();
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(dir) = exe_path.parent() {
            // 2. Next to the exe
            let bundled = dir.join(&exe);
            if bundled.exists() {
                tracing::debug!("Using bundled binary: {}", bundled.display());
                return bundled.to_string_lossy().to_string();
            }

            // 3. resources/ subdir (dev mode)
            for subdir in &["resources", "_up_/resources", "../resources"] {
                let p = dir.join(subdir).join(&exe);
                if p.exists() {
                    tracing::debug!("Using {} binary: {}", subdir, p.display());
                    return p.to_string_lossy().to_string();
                }
            }
        }
    }

    // 4. Fall back to system PATH
    tracing::debug!("Using system PATH for: {}", exe);
    exe
}

/// Helper to create a new async Command while ensuring console windows are hidden on Windows
fn get_command(binary: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(binary);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleStream {
    pub index: usize,
    pub language: String,
    pub title: String,
    pub codec_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProbeResult {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub codec_name: String,
    pub container_format: String,
    pub bitrate_kbps: u64,
    pub fps: f64,
    pub has_hdr: bool,
    pub audio_codec: String,
    pub needs_transcode: bool,
    pub estimated_encode_seconds: u64,
    pub file_size_bytes: u64,
    pub subtitle_streams: Vec<SubtitleStream>,
}

/// Probe video file using ffprobe (bundled with ffmpeg)
pub async fn probe_video(path: &str) -> anyhow::Result<VideoProbeResult> {
    let ffprobe = resolve_binary("ffprobe");
    let output = get_command(&ffprobe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            path,
        ])
        .output()
        .await
        .context("ffprobe not found — ensure FFmpeg is installed")?;

    if !output.status.success() {
        return Err(anyhow!("ffprobe failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .context("Failed to parse ffprobe output")?;

    let streams = json["streams"].as_array()
        .ok_or_else(|| anyhow!("No streams found"))?;

    // Find video and audio streams
    let video_stream = streams.iter()
        .find(|s| s["codec_type"].as_str() == Some("video"))
        .ok_or_else(|| anyhow!("No video stream found"))?;

    let audio_stream = streams.iter()
        .find(|s| s["codec_type"].as_str() == Some("audio"));

    let mut subtitle_streams = Vec::new();
    for s in streams.iter() {
        if s["codec_type"].as_str() == Some("subtitle") {
            let index = s["index"].as_u64().unwrap_or(0) as usize;
            let codec_name = s["codec_name"].as_str().unwrap_or("unknown").to_string();
            let tags = &s["tags"];
            let language = tags["language"].as_str().unwrap_or("und").to_string();
            let title = tags["title"].as_str().unwrap_or("").to_string();
            subtitle_streams.push(SubtitleStream {
                index,
                language,
                title,
                codec_name,
            });
        }
    }

    let format = &json["format"];

    let codec_name = video_stream["codec_name"].as_str()
        .unwrap_or("unknown").to_string();
    let container_format = format["format_name"].as_str()
        .unwrap_or("unknown").to_string();

    let duration_seconds = format["duration"].as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let bitrate_kbps = format["bit_rate"].as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0) / 1000;

    let width = video_stream["width"].as_u64().unwrap_or(0) as u32;
    let height = video_stream["height"].as_u64().unwrap_or(0) as u32;

    // Parse FPS
    let fps = parse_fps(video_stream["r_frame_rate"].as_str().unwrap_or("30/1"));

    // Check HDR via color primaries
    let color_primaries = video_stream["color_primaries"].as_str().unwrap_or("");
    let has_hdr = color_primaries == "bt2020";

    let audio_codec = audio_stream
        .and_then(|s| s["codec_name"].as_str())
        .unwrap_or("none")
        .to_string();

    let file_size_bytes = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Determine if transcode is needed
    // Only H.264 in MP4 container can potentially be remuxed
    let needs_transcode = codec_name != "h264" || !container_format.contains("mp4");

    let estimated_encode_seconds = if needs_transcode {
        (duration_seconds / 2.0) as u64  // Rough estimate: 2x real-time software
    } else {
        (duration_seconds / 10.0) as u64  // Remux is very fast
    };

    Ok(VideoProbeResult {
        duration_seconds,
        width,
        height,
        codec_name,
        container_format,
        bitrate_kbps,
        fps,
        has_hdr,
        audio_codec,
        needs_transcode,
        estimated_encode_seconds,
        file_size_bytes,
        subtitle_streams,
    })
}

fn parse_fps(fps_str: &str) -> f64 {
    let parts: Vec<&str> = fps_str.split('/').collect();
    if parts.len() == 2 {
        let num = parts[0].parse::<f64>().unwrap_or(30.0);
        let den = parts[1].parse::<f64>().unwrap_or(1.0);
        if den > 0.0 { num / den } else { 30.0 }
    } else {
        fps_str.parse::<f64>().unwrap_or(30.0)
    }
}

/// Extract a specific subtitle stream as WebVTT
pub async fn extract_subtitle(path: &str, stream_index: usize) -> anyhow::Result<String> {
    let ffmpeg = resolve_binary("ffmpeg");
    let output = get_command(&ffmpeg)
        .args([
            "-v", "quiet",
            "-i", path,
            "-map", &format!("0:{}", stream_index),
            "-f", "webvtt",
            "-",
        ])
        .output()
        .await
        .context("Failed to run ffmpeg for subtitle extraction")?;

    if !output.status.success() {
        return Err(anyhow::anyhow!("ffmpeg failed to extract subtitles: {}", String::from_utf8_lossy(&output.stderr)));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Probe available hardware encoders by attempting to use ffmpeg
pub async fn detect_hw_encoders() -> anyhow::Result<Vec<HwEncoder>> {
    let mut available = Vec::new();

    // Check encoders via ffmpeg
    let ffmpeg = resolve_binary("ffmpeg");
    let output = get_command(&ffmpeg)
        .args(["-encoders", "-v", "quiet"])
        .output()
        .await
        .context("ffmpeg not found")?;

    let encoders_text = String::from_utf8_lossy(&output.stdout);

    if encoders_text.contains("h264_nvenc") {
        if test_encoder("h264_nvenc").await.is_ok() {
            available.push(HwEncoder::Nvenc);
        }
    }

    if encoders_text.contains("h264_videotoolbox") {
        if test_encoder("h264_videotoolbox").await.is_ok() {
            available.push(HwEncoder::VideoToolbox);
        }
    }

    if encoders_text.contains("h264_qsv") {
        if test_encoder("h264_qsv").await.is_ok() {
            available.push(HwEncoder::Qsv);
        }
    }

    if encoders_text.contains("h264_amf") {
        if test_encoder("h264_amf").await.is_ok() {
            available.push(HwEncoder::Amf);
        }
    }

    // Software always available
    available.push(HwEncoder::Software);

    Ok(available)
}

async fn test_encoder(name: &str) -> anyhow::Result<()> {
    // Try encoding a single black frame to null to test if encoder works
    let ffmpeg = resolve_binary("ffmpeg");
    let output = get_command(&ffmpeg)
        .args([
            "-f", "lavfi",
            "-i", "color=black:s=320x240:d=0.1",
            "-c:v", name,
            "-frames:v", "1",
            "-f", "null",
            "-",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await?;

    if output.status.success() {
        Ok(())
    } else {
        Err(anyhow!("Encoder {} not available", name))
    }
}

pub fn get_temp_output_path(input_path: &str) -> PathBuf {
    let input = Path::new(input_path);
    let stem = input.file_stem().unwrap_or_default().to_string_lossy();
    let temp_dir = std::env::temp_dir();
    temp_dir.join(format!("{}_streamsync_output.mp4", stem))
}

fn build_ffmpeg_args(
    input: &str,
    output: &str,
    hw: &HwEncoder,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    // Hardware-specific input flags
    match hw {
        HwEncoder::Nvenc => {
            args.extend(["-hwaccel".into(), "cuda".into()]);
        }
        HwEncoder::Qsv => {
            args.extend(["-hwaccel".into(), "qsv".into()]);
        }
        _ => {}
    }

    args.extend([
        "-i".into(), input.into(),
        "-y".into(),
        // Video codec
        "-c:v".into(), hw.codec_name().into(),
    ]);

    // Add preset (skip for VideoToolbox which uses different params)
    match hw {
        HwEncoder::VideoToolbox => {
            args.extend(["-q:v".into(), "65".into()]);
        }
        _ => {
            args.extend(["-preset".into(), hw.preset().into()]);
            // CRF / quality
            match hw {
                HwEncoder::Nvenc | HwEncoder::Amf => {
                    args.extend(["-cq".into(), "23".into()]);
                }
                HwEncoder::Software => {
                    args.extend(["-crf".into(), "23".into()]);
                }
                _ => {}
            }
        }
    }

    // Extra encoder-specific args
    for (k, v) in hw.extra_args() {
        args.push(k.into());
        args.push(v.into());
    }

    args.extend([
        // Keyframe interval for seeking in torrent stream (every 2s at 30fps)
        "-g".into(), "60".into(),
        "-keyint_min".into(), "60".into(),
        // Audio
        "-c:a".into(), "aac".into(),
        "-b:a".into(), "192k".into(),
        "-ar".into(), "48000".into(),
        // Fragmented MP4 for MSE streaming
        "-movflags".into(),
        "+faststart+frag_keyframe+empty_moov+default_base_moof".into(),
        "-frag_duration".into(), "2000000".into(), // 2 second fragments
        // Progress output
        "-progress".into(), "pipe:2".into(),
        "-stats_period".into(), "1".into(),
        output.into(),
    ]);

    args
}

/// Core pipeline: FFmpeg encodes to file → librqbit reads file → creates torrent pieces
pub async fn start_encode_pipeline(
    input_path: String,
    hw_encoder: HwEncoder,
    state: Arc<AppState>,
    app_handle: tauri::AppHandle,
) -> anyhow::Result<()> {
    let output_path = get_temp_output_path(&input_path);
    let output_str = output_path.to_string_lossy().to_string();

    // Store output path in state
    {
        let mut enc = state.encoder.lock().await;
        enc.output_path = Some(output_path.clone());
        enc.selected_hw = hw_encoder.clone();
    }

    let ffmpeg_args = build_ffmpeg_args(&input_path, &output_str, &hw_encoder);
    let encoder_name = hw_encoder.codec_name().to_string();

    tracing::info!("Starting FFmpeg with encoder: {}", encoder_name);
    tracing::debug!("FFmpeg args: {:?}", ffmpeg_args);

    let ffmpeg = resolve_binary("ffmpeg");
    let mut child = get_command(&ffmpeg)
        .args(&ffmpeg_args)
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .context("Failed to spawn FFmpeg")?;

    let stderr = child.stderr.take().unwrap();
    let state_clone = Arc::clone(&state);
    let app_clone = app_handle.clone();
    let enc_name_clone = encoder_name.clone();

    // Parse progress in background
    tokio::spawn(parse_ffmpeg_progress(
        stderr,
        state_clone,
        app_clone,
        enc_name_clone,
    ));

    let status = child.wait().await?;
    let currently_hw = hw_encoder != HwEncoder::Software;

    if status.success() {
        let mut enc = state.encoder.lock().await;
        enc.encode_complete = true;
        drop(enc);
        state.emit(AppEvent::EncodeComplete);
        let _ = app_handle.emit("encode-complete", ());
        tracing::info!("Encoding complete, starting torrent seeding");

        // Start seeding now that the file is complete
        let state_clone = Arc::clone(&state);
        let app_clone = app_handle.clone();
        let output_clone = output_path.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::engine::torrent::start_seeding(
                output_clone,
                state_clone,
                app_clone,
            ).await {
                tracing::error!("Failed to start torrent seeding: {}", e);
            }
        });
    } else {
        let code = status.code().unwrap_or(-1);
        if code != 0 && currently_hw {
            tracing::warn!("HW encoder failed (code {}), retrying with software", code);
            state.emit(AppEvent::EncoderFallback { encoder: "libx264".into() });
            let _ = app_handle.emit("encoder-fallback", "libx264");
            Box::pin(start_encode_pipeline(
                input_path,
                HwEncoder::Software,
                state,
                app_handle,
            )).await?;
        } else {
            let msg = format!("FFmpeg exited with code {}", code);
            state.emit(AppEvent::EncodeError { message: msg.clone() });
            let _ = app_handle.emit("encode-error", msg);
        }
    }

    Ok(())
}

async fn parse_ffmpeg_progress(
    stderr: tokio::process::ChildStderr,
    state: Arc<AppState>,
    app: tauri::AppHandle,
    encoder_name: String,
) {
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    let mut total_duration_secs: Option<f64> = None;
    let mut current_fps = 0.0f64;
    let mut current_size = 0u64;

    while let Ok(Some(line)) = lines.next_line().await {
        // Parse duration from stderr header (e.g. "  Duration: 01:23:45.67,")
        if total_duration_secs.is_none() && line.contains("Duration:") {
            total_duration_secs = parse_duration_from_ffmpeg_line(&line);
        }

        // Parse -progress pipe:2 output lines
        if line.starts_with("out_time_ms=") {
            if let Ok(ms) = line["out_time_ms=".len()..].trim().parse::<i64>() {
                if ms > 0 {
                    let current_secs = ms as f64 / 1_000_000.0;
                    if let Some(total) = total_duration_secs {
                        let percent = (current_secs / total * 100.0).min(100.0);
                        let eta = if percent > 0.0 {
                            ((100.0 - percent) / percent * current_secs) as u64
                        } else {
                            0
                        };
                        let progress = EncodeProgress {
                            percent,
                            fps: current_fps,
                            eta_seconds: eta,
                            encoder: encoder_name.clone(),
                            output_size_bytes: current_size,
                        };
                        {
                            let mut enc = state.encoder.lock().await;
                            enc.progress = Some(progress.clone());
                        }
                        let _ = app.emit("encode-progress", &progress);
                    }
                }
            }
        }

        if line.starts_with("fps=") {
            if let Ok(fps) = line["fps=".len()..].trim().parse::<f64>() {
                current_fps = fps;
            }
        }

        if line.starts_with("total_size=") {
            if let Ok(size) = line["total_size=".len()..].trim().parse::<u64>() {
                current_size = size;
            }
        }
    }
}

fn parse_duration_from_ffmpeg_line(line: &str) -> Option<f64> {
    // Find "Duration: HH:MM:SS.ms"
    let idx = line.find("Duration:")?;
    let after = &line[idx + 9..].trim_start();
    let end = after.find(',')?;
    let time_str = &after[..end].trim();

    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() != 3 {
        return None;
    }

    let hours: f64 = parts[0].parse().ok()?;
    let minutes: f64 = parts[1].parse().ok()?;
    let seconds: f64 = parts[2].parse().ok()?;

    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}
