#!/bin/sh
# Install the official cloudflared release without root privileges.
set -eu

INSTALL_DIR="$HOME/.kiro-remote"
DEST="$INSTALL_DIR/cloudflared"

if command -v cloudflared >/dev/null 2>&1 && cloudflared --version; then
  exit 0
fi
if [ -x "$DEST" ] && "$DEST" --version; then
  exit 0
fi

case "$(uname -s)" in
  Linux) PLATFORM=linux; EXTENSION= ;;
  Darwin) PLATFORM=darwin; EXTENSION=.tgz ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR"
STAGING=$(mktemp -d "$INSTALL_DIR/.cloudflared-XXXXXX")
trap 'rm -rf "$STAGING"' EXIT
trap 'exit 1' HUP INT TERM

URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${PLATFORM}-${ARCH}${EXTENSION}"
echo "Downloading cloudflared for ${PLATFORM}-${ARCH}..."
if [ "$PLATFORM" = darwin ]; then
  curl -fsSL --connect-timeout 10 --max-time 120 -o "$STAGING/cloudflared.tgz" "$URL"
  tar -xzf "$STAGING/cloudflared.tgz" -C "$STAGING" cloudflared
else
  curl -fsSL --connect-timeout 10 --max-time 120 -o "$STAGING/cloudflared" "$URL"
fi
chmod 755 "$STAGING/cloudflared"
"$STAGING/cloudflared" --version
mv -f "$STAGING/cloudflared" "$DEST"
echo "cloudflared installed to $DEST"
echo 'Optional PATH: export PATH="$HOME/.kiro-remote:$PATH"'
