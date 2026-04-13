use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

pub type CurrentFilePath = Arc<RwLock<Option<String>>>;

#[derive(Clone)]
struct SignallerState {
    current_file: CurrentFilePath,
}

pub async fn create_signalling_server(
    port: u16,
    current_file: CurrentFilePath,
) -> anyhow::Result<()> {
    let state = SignallerState { current_file };

    let router = Router::new()
        .route("/host-video", get(video_stream_handler))
        .with_state(state)
        .layer(CorsLayer::permissive());

    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Signalling server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}

// ========================================================================
// Video streaming with proper range requests (no full-file-in-RAM)
// ========================================================================

const STREAM_CHUNK_SIZE: u64 = 2 * 1024 * 1024;

async fn video_stream_handler(
    State(state): State<SignallerState>,
    headers: HeaderMap,
) -> Response {
    let file_path = {
        let guard = state.current_file.read().await;
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => {
                return (StatusCode::NOT_FOUND, "No video loaded").into_response();
            }
        }
    };

    let path = std::path::PathBuf::from(&file_path);
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("Video file not found: {} — {}", file_path, e);
            return (StatusCode::NOT_FOUND, "File not found").into_response();
        }
    };
    let file_size = metadata.len();

    if file_size == 0 {
        return (StatusCode::NOT_FOUND, "Empty file").into_response();
    }

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let content_type = match ext.to_lowercase().as_str() {
        "mkv" => "video/x-matroska",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "ts" => "video/mp2t",
        _ => "video/mp4",
    };

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let (start, end, is_range) = if range_header.starts_with("bytes=") {
        let range_spec = &range_header[6..];
        let parts: Vec<&str> = range_spec.splitn(2, '-').collect();
        let start = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let end = parts.get(1)
            .and_then(|s| if s.is_empty() { None } else { s.parse::<u64>().ok() })
            .unwrap_or_else(|| (start + STREAM_CHUNK_SIZE).min(file_size) - 1)
            .min(file_size - 1);
        (start, end, true)
    } else {
        (0, file_size.saturating_sub(1), false)
    };

    let chunk_size = end - start + 1;

    use tokio::io::AsyncSeekExt;
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("Cannot open video file: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Cannot open file").into_response();
        }
    };

    if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
        tracing::error!("Seek failed: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Seek failed").into_response();
    }

    use tokio::io::AsyncReadExt;
    let limited = file.take(chunk_size);
    let stream = tokio_util::io::ReaderStream::new(limited);
    let body = Body::from_stream(stream);

    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    response_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());

    if is_range {
        response_headers.insert(header::CONTENT_LENGTH, chunk_size.to_string().parse().unwrap());
        response_headers.insert(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end, file_size).parse().unwrap(),
        );
        (StatusCode::PARTIAL_CONTENT, response_headers, body).into_response()
    } else {
        response_headers.insert(header::CONTENT_LENGTH, chunk_size.to_string().parse().unwrap());
        (StatusCode::OK, response_headers, body).into_response()
    }
}
