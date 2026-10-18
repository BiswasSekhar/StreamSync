use anyhow::{anyhow, Context};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::state::{AppState, TunnelState};

pub struct TunnelProcess {
    pub child: Child,
    pub public_url: String,
}

pub fn get_cloudflared_path() -> anyhow::Result<std::path::PathBuf> {
    let path = crate::engine::ffmpeg::resolve_binary("cloudflared");
    let p = std::path::PathBuf::from(&path);

    if p.components().count() == 1 {
        if std::process::Command::new(&path).arg("--version").output().is_ok() {
            return Ok(p);
        }
        return Err(anyhow!("cloudflared not found. It should be bundled with the app."));
    }

    Ok(p)
}

pub async fn stop_tunnel(state: &AppState) {
    {
        let mut child_lock = state.tunnel_child.lock().await;
        if let Some(ref mut child) = *child_lock {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        *child_lock = None;
    }

    {
        let mut ts = state.tunnel.lock().await;
        *ts = None;
    }
}

pub async fn start_tunnel(port: u16) -> anyhow::Result<TunnelProcess> {
    let cloudflared_path = get_cloudflared_path()?;

    let mut command = Command::new(&cloudflared_path);
    command
        .args([
            "tunnel",
            "--url",
            &format!("http://localhost:{}", port),
            "--no-autoupdate",
            "--loglevel",
            "info",
        ])
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .context("Failed to spawn cloudflared")?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Failed to capture cloudflared stderr"))?;

    let public_url = match extract_tunnel_url(stderr).await {
        Ok(url) => url,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    tracing::info!("cloudflared tunnel URL: {}", public_url);
    if let Err(error) = wait_for_tunnel_ready(&public_url).await {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(error);
    }
    tracing::info!("cloudflared tunnel is reachable at {}/ws", public_url.trim_end_matches('/'));
    Ok(TunnelProcess { child, public_url })
}

pub async fn set_running_tunnel(state: &AppState, tunnel: TunnelProcess) {
    let pid = tunnel.child.id();
    {
        let mut ts = state.tunnel.lock().await;
        *ts = Some(TunnelState {
            public_url: tunnel.public_url.clone(),
            child_pid: pid,
        });
    }
    {
        let mut child_lock = state.tunnel_child.lock().await;
        *child_lock = Some(tunnel.child);
    }
}

async fn extract_tunnel_url(stderr: tokio::process::ChildStderr) -> anyhow::Result<String> {
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    let timeout = tokio::time::Duration::from_secs(45);

    tokio::time::timeout(timeout, async {
        while let Ok(Some(line)) = lines.next_line().await {
            if line.contains("trycloudflare.com") {
                if let Some(url) = line.split_whitespace().find(|s| s.starts_with("https://")) {
                    return Ok(url.trim_matches(|c| c == '"' || c == '\'').to_string());
                }
            }
            if line.contains("https://") && line.contains(".trycloudflare.com") {
                for word in line.split_whitespace() {
                    if word.starts_with("https://") {
                        return Ok(word.trim_matches(|c| c == '"' || c == '\'').to_string());
                    }
                }
            }
        }
        Err(anyhow!("Tunnel URL not found; cloudflared may have exited"))
    })
    .await
    .map_err(|_| anyhow!("Timeout waiting for cloudflared tunnel URL (45s)"))?
}

async fn wait_for_tunnel_ready(public_url: &str) -> anyhow::Result<()> {
    let probe_url = format!("{}/ws", public_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(tokio::time::Duration::from_secs(5))
        .build()
        .context("Failed to create tunnel readiness probe client")?;

    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(25);
    let mut last_reason = String::from("no response");

    while tokio::time::Instant::now() < deadline {
        match client.get(&probe_url).send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success()
                    || status.as_u16() == 400
                    || status.as_u16() == 404
                    || status.as_u16() == 405
                    || status.as_u16() == 426
                {
                    return Ok(());
                }
                last_reason = format!("status {}", status);
            }
            Err(error) => {
                last_reason = error.to_string();
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(900)).await;
    }

    Err(anyhow!(
        "Tunnel URL {} did not become ready in time ({})",
        probe_url,
        last_reason
    ))
}
