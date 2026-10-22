#!/bin/zsh
# Installerer nattlig `npm run sync` (kl. 04) som launchd-jobb for innlogget bruker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$HOME/Library/LaunchAgents/no.advokat.sync.plist"
sed "s|__ROOT__|$ROOT|g" "$ROOT/scripts/no.advokat.sync.plist" > "$TARGET"
launchctl bootout "gui/$(id -u)" "$TARGET" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
echo "Installert: $TARGET (logg: $ROOT/data/sync.log)"
