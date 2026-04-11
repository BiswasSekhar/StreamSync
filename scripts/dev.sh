#!/bin/bash
# Start all dev servers

set -e

echo "StreamSync Dev Environment"
echo "=========================="

# Check for required tools
command -v ffmpeg >/dev/null 2>&1 || { echo "⚠ ffmpeg not found. Install from https://ffmpeg.org"; }
command -v cloudflared >/dev/null 2>&1 || { echo "⚠ cloudflared not found. Run: node scripts/download-cloudflared.js"; }

# Install dependencies
echo "Installing npm dependencies..."
pnpm install

# Build shared package
echo "Building shared package..."
cd packages/shared && pnpm build 2>/dev/null || true && cd ../..

# Build receiver-web
echo "Building receiver-web for host serving..."
cd apps/receiver-web && pnpm build && cd ../..

# Start desktop app
echo ""
echo "Starting StreamSync desktop..."
cd apps/desktop && pnpm tauri dev
