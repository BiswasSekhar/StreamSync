#!/usr/bin/env node
/**
 * Downloads the correct cloudflared binary for the current platform.
 * Run: node scripts/download-cloudflared.js
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const VERSION = "2024.2.1";

const BINARIES = {
  "darwin-x64": `cloudflared-darwin-amd64`,
  "darwin-arm64": `cloudflared-darwin-arm64`,
  "win32-x64": `cloudflared-windows-amd64.exe`,
  "linux-x64": `cloudflared-linux-amd64`,
  "linux-arm64": `cloudflared-linux-arm64`,
};

const platform = `${process.platform}-${process.arch}`;
const binaryName = BINARIES[platform];

if (!binaryName) {
  console.error(`Unsupported platform: ${platform}`);
  console.error("Supported:", Object.keys(BINARIES).join(", "));
  process.exit(1);
}

const outputName =
  process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
const outputDir = path.join(
  __dirname,
  "..",
  "apps",
  "desktop",
  "src-tauri",
  "resources"
);
const outputPath = path.join(outputDir, outputName);

// Check if already downloaded
if (fs.existsSync(outputPath)) {
  const stat = fs.statSync(outputPath);
  if (stat.size > 1024 * 1024) {
    console.log(`cloudflared already downloaded: ${outputPath}`);
    process.exit(0);
  }
}

fs.mkdirSync(outputDir, { recursive: true });

const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${binaryName}`;
console.log(`Downloading cloudflared ${VERSION} for ${platform}...`);
console.log(`URL: ${url}`);

function download(url, dest, redirects = 0) {
  if (redirects > 5) {
    console.error("Too many redirects");
    process.exit(1);
  }

  https
    .get(url, { headers: { "User-Agent": "streamsync-setup" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        console.log(`Redirecting to ${res.headers.location}`);
        download(res.headers.location, dest, redirects + 1);
        return;
      }

      if (res.statusCode !== 200) {
        console.error(`HTTP ${res.statusCode}: ${url}`);
        process.exit(1);
      }

      const total = parseInt(res.headers["content-length"] || "0", 10);
      let received = 0;

      const file = fs.createWriteStream(dest);
      res.on("data", (chunk) => {
        received += chunk.length;
        if (total > 0) {
          process.stdout.write(
            `\r  ${((received / total) * 100).toFixed(0)}% (${(received / 1024 / 1024).toFixed(1)} MB)`
          );
        }
      });

      res.pipe(file);
      file.on("finish", () => {
        file.close();
        console.log(`\nSaved to: ${dest}`);

        // Make executable on Unix
        if (process.platform !== "win32") {
          fs.chmodSync(dest, "755");
          console.log("Made executable (chmod 755)");
        }

        console.log("Done!");
      });
    })
    .on("error", (e) => {
      console.error("Download failed:", e.message);
      process.exit(1);
    });
}

download(url, outputPath);
