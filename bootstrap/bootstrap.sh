#!/bin/sh
# mkit bootstrap for macOS / Linux:  curl -fsSL <raw>/bootstrap.sh | sh -s -- <dashboard-url> <pairing-code>
# Env for E2E: MKIT_SKIP_TAILSCALE=1, MKIT_KIT_DIR=<local kit copy instead of git clone>
set -eu
FROM="${1:?dashboard url required}"; CODE="${2:?pairing code required}"
KIT="${MKIT_KIT_DIR:-$HOME/.mkit/kit}"
OS="$(uname -s)"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
need() { command -v "$1" >/dev/null 2>&1; }

if [ "$OS" = "Darwin" ]; then
  if ! need brew; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
  fi
  need git || brew install git
  need node || brew install node
  [ "${MKIT_SKIP_TAILSCALE:-}" = "1" ] || need tailscale || brew install --cask tailscale
elif [ "$OS" = "Linux" ]; then
  $SUDO apt-get update -y
  need git || $SUDO apt-get install -y git
  need curl || $SUDO apt-get install -y curl
  if ! need node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
  fi
  [ "${MKIT_SKIP_TAILSCALE:-}" = "1" ] || need tailscale || curl -fsSL https://tailscale.com/install.sh | sh
else
  echo "unsupported OS: $OS" >&2; exit 1
fi

if [ "${MKIT_SKIP_TAILSCALE:-}" != "1" ]; then
  tailscale status >/dev/null 2>&1 || $SUDO tailscale up --ssh
fi

if [ -z "${MKIT_KIT_DIR:-}" ]; then
  if [ -d "$KIT/.git" ]; then git -C "$KIT" pull --ff-only; else git clone https://github.com/jurgis-vilums/mkit "$KIT"; fi
fi
cd "$KIT" && npm ci --omit=dev
# `curl … | sh` makes stdin the script pipe, so the passphrase prompt needs /dev/tty; automation passes MKIT_PASSPHRASE instead
if [ -n "${MKIT_PASSPHRASE:-}" ]; then exec node "$KIT/bin/mkit.js" import --from "$FROM" --code "$CODE"; fi
exec node "$KIT/bin/mkit.js" import --from "$FROM" --code "$CODE" </dev/tty
