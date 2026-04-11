use std::sync::Arc;
use anyhow::{anyhow, Context};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::state::{AppState, AppEvent, TunnelState};

pub struct TunnelProcess {
    pub child: Child,
    pub public_url: String,
}

pub fn get_cloudflared_path() -> anyhow::Result<std::path::PathBuf> {
    // Reuse the same resolution logic as FFmpeg binaries
    let path = crate::engine::ffmpeg::resolve_binary("cloudflared");
    let p = std::path::PathBuf::from(&path);

    // If it resolved to just the name (fallback), verify it actually exists in PATH
    if p.components().count() == 1 {
        if std::process::Command::new(&path).arg("--version").output().is_ok() {
            return Ok(p);
        }
        return Err(anyhow!(
            "cloudflared not found. Run: node scripts/download-cloudflared.js"
        ));
    }

    Ok(p)
}

pub async fn start_tunnel(port: u16) -> anyhow::Result<TunnelProcess> {
    let cloudflared_path = get_cloudflared_path()?;

    tracing::info!("Starting cloudflared tunnel on port {}", port);

    let mut child = Command::new(&cloudflared_path)
        .args([
            "tunnel",
            "--url",
            &format!("http://localhost:{}", port),
            "--no-autoupdate",
            "--loglevel",
            "info",
        ])
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .context("Failed to spawn cloudflared")?;

    let stderr = child.stderr.take()
        .ok_or_else(|| anyhow!("Failed to capture cloudflared stderr"))?;

    let public_url = extract_tunnel_url(stderr).await?;

    tracing::info!("Tunnel established: {}", public_url);

    Ok(TunnelProcess { child, public_url })
}

async fn extract_tunnel_url(
    stderr: tokio::process::ChildStderr,
) -> anyhow::Result<String> {
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    let timeout = tokio::time::Duration::from_secs(45);

    tokio::time::timeout(timeout, async {
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!("cloudflared: {}", line);
            // cloudflared prints the URL like:
            // "INF | Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):"
            // followed by: "INF | https://abc123.trycloudflare.com"
            if line.contains("trycloudflare.com") {
                if let Some(url) = line.split_whitespace()
                    .find(|s| s.starts_with("https://"))
                {
                    return Ok(url.to_string());
                }
            }
            // Also check for standard URL pattern
            if line.contains("https://") && line.contains(".trycloudflare.com") {
                for word in line.split_whitespace() {
                    if word.starts_with("https://") {
                        return Ok(word.trim_matches(|c| c == '"' || c == '\'').to_string());
                    }
                }
            }
        }
        Err(anyhow!("Tunnel URL not found — cloudflared may have exited"))
    })
    .await
    .map_err(|_| anyhow!("Timeout waiting for cloudflared tunnel URL (45s)"))?
}

/// Start tunnel with auto-reconnect loop
pub async fn start_tunnel_with_reconnect(
    port: u16,
    state: Arc<AppState>,
    app: tauri::AppHandle,
) {
    let mut backoff = tokio::time::Duration::from_secs(1);

    loop {
        match start_tunnel(port).await {
            Ok(mut tunnel) => {
                let url = tunnel.public_url.clone();
                backoff = tokio::time::Duration::from_secs(1);

                {
                    let mut ts = state.tunnel.lock().await;
                    *ts = Some(TunnelState { public_url: url.clone() });
                }
                state.emit(AppEvent::TunnelUrl { url: url.clone() });
                let _ = app.emit("tunnel-url", serde_json::json!({ "url": url }));

                // Wait for tunnel process to exit
                let _ = tunnel.child.wait().await;
                tracing::warn!("cloudflared tunnel exited, reconnecting...");

                {
                    let mut ts = state.tunnel.lock().await;
                    *ts = None;
                }
                state.emit(AppEvent::TunnelDisconnected);
                let _ = app.emit("tunnel-disconnected", ());
            }
            Err(e) => {
                tracing::error!("Tunnel failed to start: {}", e);
                let _ = app.emit("tunnel-error", e.to_string());
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(tokio::time::Duration::from_secs(60));
        tracing::info!("Retrying tunnel in {:?}...", backoff);
    }
}

pub struct TurnCredentials {
    pub url: String,
    pub username: String,
    pub credential: String,
}

/// Fetch ephemeral TURN credentials from Cloudflare Calls API (optional)
pub async fn get_turn_credentials() -> Option<TurnCredentials> {
    let app_id = std::env::var("CF_CALLS_APP_ID").ok()?;
    let app_secret = std::env::var("CF_CALLS_APP_SECRET").ok()?;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "https://rtc.live.cloudflare.com/v1/apps/{}/turn/credentials",
            app_id
        ))
        .header("Authorization", format!("Bearer {}", app_secret))
        .send()
        .await
        .ok()?;

    let creds: serde_json::Value = resp.json().await.ok()?;

    Some(TurnCredentials {
        url: creds["iceServers"][0]["urls"][0].as_str()?.to_string(),
        username: creds["iceServers"][0]["username"].as_str()?.to_string(),
        credential: creds["iceServers"][0]["credential"].as_str()?.to_string(),
    })
}
