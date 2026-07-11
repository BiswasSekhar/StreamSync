//! Shared librqbit session + localhost streaming for the P2P content layer.
//!
//! One [`Session`] backs the whole app. Two roles share it:
//!   - **Host** seeds the original chosen file (no transcode — mpv plays any
//!     format). It plays back from the file path directly, so it never needs
//!     the stream endpoint.
//!   - **Guest** / **public magnet** adds a magnet, and mpv opens librqbit's
//!     localhost stream URL. librqbit's `FileStream` reprioritizes pieces from
//!     the player's read/seek position, so seeking a half-downloaded file
//!     works without any manual piece-priority calls.
//!
//! The HTTP endpoint binds `127.0.0.1:<ephemeral>` — a loopback IPC surface,
//! not a server we operate. Discovery still rides Mainline DHT (no tracker
//! required for private sessions; public magnets may carry their own).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use librqbit::{
    api::Api, create_torrent, AddTorrent, AddTorrentOptions, AddTorrentResponse,
    CreateTorrentOptions, ManagedTorrent, Session, SessionOptions,
};

const DEFAULT_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.internetwarriors.net:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.cyberia.is:6969/announce",
    "http://tracker.openbittorrent.com:80/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
];

const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "avi", "mov", "webm", "ts", "m4v", "wmv", "flv"];

fn default_trackers() -> Vec<String> {
    DEFAULT_TRACKERS.iter().map(|t| (*t).to_string()).collect()
}

fn append_trackers_to_magnet(mut magnet: String) -> String {
    for tracker in DEFAULT_TRACKERS {
        magnet.push_str("&tr=");
        magnet.push_str(&urlencoding::encode(tracker));
    }
    magnet
}

/// Result of publishing or opening a torrent for streaming.
#[derive(Clone)]
pub struct StreamableTorrent {
    pub handle: Arc<ManagedTorrent>,
    pub info_hash_hex: String,
    pub file_id: usize,
    pub file_name: String,
    pub file_size: u64,
    pub total_size: u64,
    pub video_files: Vec<TorrentVideoFile>,
    pub magnet: String,
    /// `http://127.0.0.1:<port>/torrents/<hash>/stream/<file_id>` — what mpv opens.
    pub stream_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentVideoFile {
    pub file_id: usize,
    pub file_name: String,
    pub file_size: u64,
}

/// Owns the shared session and the localhost streaming server.
pub struct TorrentStreamManager {
    session: Arc<Session>,
    base_url: String,
}

impl TorrentStreamManager {
    /// Build the session and start the localhost streaming server.
    pub async fn new(default_download_dir: PathBuf) -> Result<Self> {
        tokio::fs::create_dir_all(&default_download_dir)
            .await
            .ok();

        // Mainline DHT is the trackerless discovery substrate; UPnP negotiates
        // an inbound port so DHT works behind NAT.
        let mut opts = SessionOptions::default();
        opts.disable_dht = false;
        opts.disable_dht_persistence = false;
        opts.enable_upnp_port_forwarding = true;
        opts.listen_port_range = Some(6881..65535);

        let session = Session::new_with_opts(default_download_dir, opts)
            .await
            .context("failed to create librqbit session")?;

        // librqbit's HTTP API on an ephemeral loopback port.
        let listener = tokio::net::TcpListener::bind::<SocketAddr>("127.0.0.1:0".parse().unwrap())
            .await
            .context("failed to bind localhost streaming port")?;
        let local_addr = listener.local_addr().context("no local addr")?;
        let base_url = format!("http://{}", local_addr);

        // The `http-api` feature drags in `tracing-subscriber-utils`, which
        // adds the `line_broadcast` arg to `Api::new`. We don't stream logs to
        // the UI, so pass `None`.
        let api = Api::new(session.clone(), None, None);
        let http_api = librqbit::http_api::HttpApi::new(api, None);
        tokio::spawn(async move {
            if let Err(e) = http_api.make_http_api_and_run(listener, None).await {
                tracing::error!("librqbit http api exited: {e:#}");
            }
        });

        tracing::info!("torrent stream server on {base_url}");
        Ok(Self { session, base_url })
    }

    fn stream_url(&self, info_hash_hex: &str, file_id: usize) -> String {
        format!("{}/torrents/{}/stream/{}", self.base_url, info_hash_hex, file_id)
    }

    /// Host path: seed the original file as-is (no transcode). The torrent's
    /// `output_folder` points at the file's own directory so librqbit finds it.
    pub async fn publish_file(&self, file_path: &Path) -> Result<StreamableTorrent> {
        let parent = file_path
            .parent()
            .context("file has no parent directory")?
            .to_path_buf();

        let torrent_bytes = create_torrent(
            file_path,
            CreateTorrentOptions {
                name: None,
                piece_length: Some(512 * 1024),
            },
        )
        .await
        .context("failed to create torrent from file")?
        .as_bytes()
        .context("failed to serialize torrent")?;

        let handle = self
            .add(
                AddTorrent::from_bytes(torrent_bytes),
                Some(parent.to_string_lossy().to_string()),
            )
            .await?;

        let info_hash_hex = hex::encode(handle.info_hash().0);
        let file_name = file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "video".to_string());
        let magnet = append_trackers_to_magnet(format!(
            "magnet:?xt=urn:btih:{}&dn={}",
            info_hash_hex,
            urlencoding::encode(&file_name)
        ));

        let video_files = self.video_files(&handle);
        let selected = video_files
            .iter()
            .max_by_key(|file| file.file_size)
            .cloned()
            .unwrap_or(TorrentVideoFile {
                file_id: 0,
                file_name,
                file_size: file_path.metadata().map(|m| m.len()).unwrap_or(0),
            });
        let total_size = self.total_size(&handle);

        Ok(StreamableTorrent {
            handle,
            stream_url: self.stream_url(&info_hash_hex, selected.file_id),
            info_hash_hex,
            file_id: selected.file_id,
            file_name: selected.file_name,
            file_size: selected.file_size,
            total_size,
            video_files,
            magnet,
        })
    }

    /// Guest / public-magnet path: add a magnet and resolve its primary video
    /// file once metadata arrives.
    pub async fn open_magnet(&self, magnet: &str, download_dir: PathBuf) -> Result<StreamableTorrent> {
        tokio::fs::create_dir_all(&download_dir).await.ok();
        let handle = self
            .add(
                AddTorrent::from_url(magnet),
                Some(download_dir.to_string_lossy().to_string()),
            )
            .await?;

        // Magnets need a metadata round-trip before files are known.
        handle
            .wait_until_initialized()
            .await
            .context("torrent metadata never resolved")?;

        let info_hash_hex = hex::encode(handle.info_hash().0);
        let video_files = self.video_files(&handle);
        let selected = video_files
            .iter()
            .max_by_key(|file| file.file_size)
            .cloned()
            .ok_or_else(|| anyhow!("no playable video file in torrent"))?;
        let total_size = self.total_size(&handle);

        Ok(StreamableTorrent {
            handle,
            stream_url: self.stream_url(&info_hash_hex, selected.file_id),
            info_hash_hex,
            file_id: selected.file_id,
            file_name: selected.file_name,
            file_size: selected.file_size,
            total_size,
            video_files,
            magnet: magnet.to_string(),
        })
    }

    /// Open an existing public `.torrent` file and expose its primary video
    /// through librqbit's Range-aware loopback stream. The original metainfo
    /// remains authoritative; DHT can discover additional peers and the
    /// generated magnet lets other StreamSync native clients join the swarm.
    pub async fn open_torrent_file(
        &self,
        torrent_path: &Path,
        download_dir: PathBuf,
    ) -> Result<StreamableTorrent> {
        tokio::fs::create_dir_all(&download_dir).await.ok();
        let torrent_bytes = tokio::fs::read(torrent_path)
            .await
            .with_context(|| format!("failed to read {}", torrent_path.display()))?;

        let handle = self
            .add(
                AddTorrent::from_bytes(torrent_bytes),
                Some(download_dir.to_string_lossy().to_string()),
            )
            .await?;

        handle
            .wait_until_initialized()
            .await
            .context("torrent metadata never initialized")?;

        let info_hash_hex = hex::encode(handle.info_hash().0);
        let video_files = self.video_files(&handle);
        let selected = video_files
            .iter()
            .max_by_key(|file| file.file_size)
            .cloned()
            .ok_or_else(|| anyhow!("no playable video file in torrent"))?;
        let total_size = self.total_size(&handle);
        let magnet = append_trackers_to_magnet(format!(
            "magnet:?xt=urn:btih:{}&dn={}",
            info_hash_hex,
            urlencoding::encode(&selected.file_name)
        ));

        Ok(StreamableTorrent {
            handle,
            stream_url: self.stream_url(&info_hash_hex, selected.file_id),
            info_hash_hex,
            file_id: selected.file_id,
            file_name: selected.file_name,
            file_size: selected.file_size,
            total_size,
            video_files,
            magnet,
        })
    }

    async fn add<'a>(
        &self,
        torrent: AddTorrent<'a>,
        output_folder: Option<String>,
    ) -> Result<Arc<ManagedTorrent>> {
        let resp = self
            .session
            .add_torrent(
                torrent,
                Some(AddTorrentOptions {
                    overwrite: true,
                    output_folder,
                    trackers: Some(default_trackers()),
                    ..Default::default()
                }),
            )
            .await
            .context("failed to add torrent to shared session")?;

        match resp {
            AddTorrentResponse::AlreadyManaged(_, h) => Ok(h),
            AddTorrentResponse::Added(_, h) => Ok(h),
            AddTorrentResponse::ListOnly(_) => Err(anyhow!("unexpected ListOnly response")),
        }
    }

    /// Largest file with a known video extension → `(file_id, len)`.
    fn video_files(&self, handle: &Arc<ManagedTorrent>) -> Vec<TorrentVideoFile> {
        handle
            .with_metadata(|m| {
                m.file_infos
                    .iter()
                    .enumerate()
                    .filter(|(_, f)| {
                        Path::new(&f.relative_filename)
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                            .unwrap_or(false)
                    })
                    .map(|(file_id, file)| TorrentVideoFile {
                        file_id,
                        file_name: file.relative_filename.to_string_lossy().to_string(),
                        file_size: file.len,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn total_size(&self, handle: &Arc<ManagedTorrent>) -> u64 {
        handle
            .with_metadata(|m| m.file_infos.iter().map(|file| file.len).sum())
            .unwrap_or(0)
    }

    pub fn select_video(
        &self,
        torrent: &StreamableTorrent,
        file_id: usize,
    ) -> Result<StreamableTorrent> {
        let selected = torrent
            .video_files
            .iter()
            .find(|file| file.file_id == file_id)
            .cloned()
            .ok_or_else(|| anyhow!("video file id {file_id} is not available"))?;
        let mut updated = torrent.clone();
        updated.file_id = selected.file_id;
        updated.file_name = selected.file_name;
        updated.file_size = selected.file_size;
        updated.stream_url = self.stream_url(&updated.info_hash_hex, selected.file_id);
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_magnet_adds_every_default_tracker() {
        let magnet = append_trackers_to_magnet(
            "magnet:?xt=urn:btih:0123456789012345678901234567890123456789".to_string(),
        );
        for tracker in DEFAULT_TRACKERS {
            assert!(
                magnet.contains(&format!("tr={}", urlencoding::encode(tracker))),
                "missing tracker {tracker}"
            );
        }
    }

    #[test]
    fn supported_video_extensions_are_case_insensitive() {
        for name in ["movie.MKV", "clip.Mp4", "archive.AVI"] {
            let supported = Path::new(name)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            assert!(supported, "{name} should be recognized as video");
        }
    }
}
