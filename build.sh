#!/usr/bin/env bash
# Render build script — yt-dlp install karo
set -e

echo "==> Installing yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
echo "==> yt-dlp version: $(yt-dlp --version)"

echo "==> Installing npm packages..."
npm install

echo "==> Build complete ✅"
