#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="/var/log/antigravity-update.log"
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Checking for Antigravity IDE updates..." >> "$LOG_FILE"

CURRENT_VER=$(/usr/local/bin/agy.real --version 2>/dev/null || echo "unknown")
UPDATE_OUT=$(/usr/local/bin/agy.real update 2>&1 || true)
echo "$UPDATE_OUT" >> "$LOG_FILE"
NEW_VER=$(/usr/local/bin/agy.real --version 2>/dev/null || echo "unknown")

if [ "$CURRENT_VER" != "$NEW_VER" ]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Updated from $CURRENT_VER to $NEW_VER. Restarting daemon..." >> "$LOG_FILE"
    sudo -u opc XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart antigravity-cli-daemon.service
else
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Already on latest version ($CURRENT_VER)." >> "$LOG_FILE"
fi
