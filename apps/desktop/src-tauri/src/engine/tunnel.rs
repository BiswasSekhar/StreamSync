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

pub fn kill_existing_cloudflared() {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "cloudflared.exe"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill")
            .arg("cloudflared")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
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
        .creation_flags(0x08000000)
        .spawn()
        .context("Failed to spawn cloudflared")?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Failed to capture cloudflared stderr"))?;

    let public_url = extract_tunnel_url(stderr).await?;
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
