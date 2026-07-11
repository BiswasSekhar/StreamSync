//! `read_video_chunk` — Tauri command that returns a byte range of the
//! currently-loaded video as a raw IPC `Response` (the JS side gets an
//! `ArrayBuffer` directly, with no JSON serialization overhead).
//!
//! This replaces the broken `/host-video` HTTP endpoint that was only
//! reachable on `localhost:8787` (and therefore failed for any remote
//! guest in serverless tracker mode). Logic mirrors the deleted
//! `engine::signaller::video_stream_handler` exactly — single file path or
//! a librqbit torrent stream — but is invoked by the host's own
//! `hostWebrtc.ts` and the bytes flow directly into the per-peer mediaDc.
//!
//! Range semantics match the wire-level `Range: bytes=N-M` header the
//! receiver already constructs: `end` is **inclusive**.

use std::sync::Arc;
use tauri::ipc::Response;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::engine::signaller::CurrentFilePath;
use crate::state::AppState;

/// Read `[start, end]` (inclusive end) from the active video and return
/// the bytes as a raw IPC `Response` (no JSON wrapping — the JS side
/// receives an `ArrayBuffer` directly).
///
/// The `end` value is clamped to `total - 1`; callers may pass any value
/// they want and receive a possibly-shorter chunk.
#[tauri::command]
pub async fn read_video_chunk(
    state: State<'_, Arc<AppState>>,
    current_file: State<'_, CurrentFilePath>,
    start: u64,
    end: u64,
) -> Result<Response, String> {
    if end < start {
        return Err(format!("invalid range: end {} < start {}", end, start));
    }

    // Public-torrent path: read through librqbit's own Range-aware HTTP API.
    // Native guests join the torrent directly; this bridge only preserves the
    // browser/DataChannel compatibility path for clients that cannot speak the
    // standard TCP/uTP BitTorrent transport.
    if let Some(active) = state.active_stream.lock().await.clone() {
        if active.file_size == 0 || start >= active.file_size {
            return Err("range starts beyond the torrent video".to_string());
        }
        let clamped_end = end.min(active.file_size - 1);
        let response = reqwest::Client::new()
            .get(&active.stream_url)
            .header(
                reqwest::header::RANGE,
                format!("bytes={start}-{clamped_end}"),
            )
            .send()
            .await
            .map_err(|e| format!("torrent stream request failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "torrent stream returned HTTP {}",
                response.status()
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("torrent stream read failed: {e}"))?;
        return Ok(Response::new(bytes.to_vec()));
    }

    // Prefer the torrent stream if seeding is active — same priority as
    // the old video_stream_handler.
    if let Some(source) = state.torrent_stream.lock().await.clone() {
        let mut stream = source
            .handle
            .stream(source.file_id)
            .map_err(|e| format!("open torrent stream: {}", e))?;
        let total_len = stream.len();
        if total_len == 0 {
            return Err("torrent stream empty".to_string());
        }
        let clamped_end = end.min(total_len - 1);
        let read_len = clamped_end - start + 1;
        stream
            .seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|e| format!("seek torrent stream: {}", e))?;
        let mut buf = vec![0u8; read_len as usize];
        stream
            .read_exact(&mut buf)
            .await
            .map_err(|e| format!("read torrent stream: {}", e))?;
        return Ok(Response::new(buf));
    }

    // Fall back to the local file path written by `start_seeding_original`
    // (or `prepare_video_for_streaming`).
    let file_path = {
        let guard = current_file.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "no video loaded".to_string())?
    };

    let path = std::path::PathBuf::from(&file_path);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("stat {}: {}", file_path, e))?;
    let file_size = metadata.len();
    if file_size == 0 {
        return Err("video file is empty".to_string());
    }
    let clamped_end = end.min(file_size - 1);
    let read_len = clamped_end - start + 1;

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("open {}: {}", file_path, e))?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| format!("seek: {}", e))?;
    let mut buf = vec![0u8; read_len as usize];
    file.read_exact(&mut buf)
        .await
        .map_err(|e| format!("read: {}", e))?;
    Ok(Response::new(buf))
}

/// Quick size lookup so the renderer can build correct range requests
/// without firing a probe read. Mirrors the size logic used by
/// `read_video_chunk`.
#[tauri::command]
pub async fn get_video_size(
    state: State<'_, Arc<AppState>>,
    current_file: State<'_, CurrentFilePath>,
) -> Result<u64, String> {
    if let Some(active) = state.active_stream.lock().await.as_ref() {
        return Ok(active.file_size);
    }
    if let Some(source) = state.torrent_stream.lock().await.clone() {
        let stream = source
            .handle
            .stream(source.file_id)
            .map_err(|e| format!("open torrent stream: {}", e))?;
        return Ok(stream.len());
    }
    let file_path = {
        let guard = current_file.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "no video loaded".to_string())?
    };
    let metadata = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("stat {}: {}", file_path, e))?;
    Ok(metadata.len())
}
