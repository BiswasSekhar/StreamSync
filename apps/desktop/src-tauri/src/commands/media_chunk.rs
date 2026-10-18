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

use std::sync::{Arc, OnceLock};
use tauri::ipc::Response;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::engine::signaller::CurrentFilePath;
use crate::state::AppState;

/// Maximum amount of media a single DataChannel request may read.
///
/// This is a protocol limit, not just a UI hint. Every branch below uses it
/// before allocating a buffer so a guest cannot turn a malformed range into a
/// large allocation or an integer underflow.
const MAX_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

fn torrent_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("static torrent HTTP client configuration is valid")
    })
}

fn bounded_range(start: u64, end: u64, total_len: u64) -> Result<(u64, u64), String> {
    if total_len == 0 {
        return Err("video file is empty".to_string());
    }
    if start >= total_len {
        return Err(format!(
            "range starts beyond video: start {} >= size {}",
            start, total_len
        ));
    }

    let clamped_end = end.min(total_len - 1);
    let read_len = clamped_end
        .checked_sub(start)
        .and_then(|length| length.checked_add(1))
        .ok_or_else(|| "range length overflow".to_string())?;

    if read_len > MAX_CHUNK_BYTES {
        return Err(format!(
            "range too large: {} bytes (maximum {})",
            read_len, MAX_CHUNK_BYTES
        ));
    }

    Ok((clamped_end, read_len))
}

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
        let (clamped_end, expected_len) = bounded_range(start, end, active.file_size)?;
        let response = torrent_http_client()
            .get(&active.stream_url)
            .header(
                reqwest::header::RANGE,
                format!("bytes={start}-{clamped_end}"),
            )
            .send()
            .await
            .map_err(|e| format!("torrent stream request failed: {e}"))?;
        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!(
                "torrent stream returned HTTP {}",
                response.status()
            ));
        }
        let expected_content_range = format!("bytes {start}-{clamped_end}/");
        let content_range = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "torrent stream omitted Content-Range".to_string())?;
        if !content_range.starts_with(&expected_content_range) {
            return Err(format!(
                "torrent stream returned Content-Range {}, expected {}*",
                content_range, expected_content_range
            ));
        }
        if response.content_length().is_some_and(|length| length != expected_len) {
            return Err(format!(
                "torrent stream declared {} bytes, expected {}",
                response.content_length().unwrap_or_default(),
                expected_len
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("torrent stream read failed: {e}"))?;
        if bytes.len() as u64 != expected_len {
            return Err(format!(
                "torrent stream returned {} bytes, expected {}",
                bytes.len(), expected_len
            ));
        }
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
        let (_clamped_end, read_len) = bounded_range(start, end, total_len)?;
        let read_len = usize::try_from(read_len)
            .map_err(|_| "range does not fit in memory on this platform".to_string())?;
        stream
            .seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|e| format!("seek torrent stream: {}", e))?;
        let mut buf = vec![0u8; read_len];
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
    let (_clamped_end, read_len) = bounded_range(start, end, file_size)?;
    let read_len = usize::try_from(read_len)
        .map_err(|_| "range does not fit in memory on this platform".to_string())?;

    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("open {}: {}", file_path, e))?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| format!("seek: {}", e))?;
    let mut buf = vec![0u8; read_len];
    file.read_exact(&mut buf)
        .await
        .map_err(|e| format!("read: {}", e))?;
    Ok(Response::new(buf))
}

#[cfg(test)]
mod tests {
    use super::{bounded_range, MAX_CHUNK_BYTES};

    #[test]
    fn rejects_empty_and_out_of_bounds_ranges() {
        assert!(bounded_range(0, 0, 0).is_err());
        assert!(bounded_range(10, 10, 10).is_err());
    }

    #[test]
    fn clamps_to_the_end_of_the_file() {
        assert_eq!(bounded_range(8, u64::MAX, 10).unwrap(), (9, 2));
        assert_eq!(bounded_range(9, 9, 10).unwrap(), (9, 1));
    }

    #[test]
    fn rejects_oversized_ranges() {
        assert!(bounded_range(0, MAX_CHUNK_BYTES, MAX_CHUNK_BYTES + 1).is_err());
        assert!(bounded_range(1, 0, 10).is_err());
        assert!(bounded_range(u64::MAX, u64::MAX, u64::MAX).is_err());
    }
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
