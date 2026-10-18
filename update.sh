#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ARCHIVE="https://codeload.github.com/ynadtiy19/qorange-panel/tar.gz/refs/heads/main"
INSTALL_DIR="/opt/qorange-panel"
ETC_DIR="/etc/qorange-panel"
SERVICE_NAME="qorange-panel"
UNIT_FILE="/etc/systemd/system/qorange-panel.service"
LOCK_DIR="/run/lock/qorange-panel-update.lock"

TMP_DIR=""
BACKUP_DIR=""
LOCK_ACQUIRED=0
SERVICE_STOPPED=0

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    local result=$?
    if [[ $result -ne 0 && -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then
        printf '\nUpdate failed; restoring the previous application files...\n' >&2
        systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
        if [[ -d "$INSTALL_DIR" ]]; then
            mv -- "$INSTALL_DIR" "$TMP_DIR/failed-update"
        fi
        if [[ -d "$BACKUP_DIR" ]]; then
            mv -- "$BACKUP_DIR" "$INSTALL_DIR"
        fi
        if ! systemctl restart "$SERVICE_NAME"; then
            printf 'The previous application files were restored, but the service did not restart. Check: journalctl -u %s -n 80\n' "$SERVICE_NAME" >&2
        fi
    elif [[ $result -ne 0 && "$SERVICE_STOPPED" -eq 1 ]]; then
        systemctl start "$SERVICE_NAME" ||
            printf 'The original application files remain in place, but the service did not restart. Check: journalctl -u %s -n 80\n' "$SERVICE_NAME" >&2
    fi
    if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
        rm -rf -- "$TMP_DIR"
    fi
    if [[ "$LOCK_ACQUIRED" -eq 1 ]]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
    exit "$result"
}
trap cleanup EXIT

[[ "$(uname -s)" == "Linux" ]] || fail "This updater supports Linux VPS hosts with systemd."
[[ "$(id -u)" -eq 0 ]] || fail "Run this updater with sudo/root privileges."
for command_name in node npm systemctl curl tar; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Required command '$command_name' is not installed."
done
systemctl --version >/dev/null 2>&1 || fail "systemd is required."
[[ -f "$INSTALL_DIR/.qorange-panel-owned" && ! -L "$INSTALL_DIR/.qorange-panel-owned" ]] ||
    fail "$INSTALL_DIR is not a recognized QOrange Panel installation."
[[ -f "$INSTALL_DIR/app.js" && -f "$INSTALL_DIR/package.json" ]] ||
    fail "The existing QOrange Panel installation is incomplete."
[[ -f "$ETC_DIR/panel.env" && ! -L "$ETC_DIR/panel.env" ]] ||
    fail "$ETC_DIR/panel.env is missing or is not a regular file."
[[ -f "$ETC_DIR/auth.json" && ! -L "$ETC_DIR/auth.json" ]] ||
    fail "$ETC_DIR/auth.json is missing or is not a regular file; refusing to create or replace administrator credentials."
[[ -f "$ETC_DIR/session.key" && ! -L "$ETC_DIR/session.key" ]] ||
    fail "$ETC_DIR/session.key is missing or is not a regular file; refusing to replace the session key."
[[ -f "$UNIT_FILE" ]] || fail "$UNIT_FILE is missing."
grep -q '^# QOrange Panel managed$' "$UNIT_FILE" || fail "$UNIT_FILE is not the managed QOrange Panel service unit."
systemctl is-active --quiet "$SERVICE_NAME" || fail "The QOrange Panel service is not active; inspect it before updating."

mkdir -p /run/lock
mkdir "$LOCK_DIR" 2>/dev/null || fail "Another update may already be running (lock: $LOCK_DIR)."
LOCK_ACQUIRED=1
TMP_DIR="$(mktemp -d /opt/qorange-panel-update.XXXXXX)"
chmod 0700 "$TMP_DIR"
curl --fail --silent --show-error --location "$REPOSITORY_ARCHIVE" -o "$TMP_DIR/release.tar.gz" ||
    fail "Could not download the QOrange Panel release archive."
mkdir "$TMP_DIR/release"
tar -xzf "$TMP_DIR/release.tar.gz" --strip-components=1 -C "$TMP_DIR/release"
[[ -f "$TMP_DIR/release/app.js" && -f "$TMP_DIR/release/package.json" ]] ||
    fail "Downloaded release is incomplete."
node -p 'Number(process.versions.node.split(".")[0]) >= 18' | grep -qx true ||
    fail "Node.js 18 or newer is required."
(cd "$TMP_DIR/release" && npm ci --omit=dev --no-audit --no-fund)
printf 'QOrange Panel managed installation\n' > "$TMP_DIR/release/.qorange-panel-owned"
chmod 0600 "$TMP_DIR/release/.qorange-panel-owned"

PORT_VALUE="$(awk -F= '$1 == "PORT" { gsub(/"/, "", $2); print $2 }' "$ETC_DIR/panel.env" | tail -n 1)"
[[ "$PORT_VALUE" =~ ^[0-9]+$ ]] && ((PORT_VALUE >= 1 && PORT_VALUE <= 65535)) ||
    fail "PORT in $ETC_DIR/panel.env must be a valid port number."
BIND_ADDRESS_VALUE="$(awk -F= '$1 == "BIND_ADDRESS" { gsub(/"/, "", $2); print $2 }' "$ETC_DIR/panel.env" | tail -n 1)"
BIND_ADDRESS_VALUE="${BIND_ADDRESS_VALUE:-127.0.0.1}"
[[ "$BIND_ADDRESS_VALUE" =~ ^[A-Za-z0-9.:%_-]+$ ]] ||
    fail "BIND_ADDRESS in $ETC_DIR/panel.env must be a valid local address."
case "$BIND_ADDRESS_VALUE" in
    0.0.0.0) HEALTH_ADDRESS="127.0.0.1" ;;
    ::) HEALTH_ADDRESS="[::1]" ;;
    *:*) HEALTH_ADDRESS="[$BIND_ADDRESS_VALUE]" ;;
    *) HEALTH_ADDRESS="$BIND_ADDRESS_VALUE" ;;
esac

BACKUP_DIR="/opt/qorange-panel.rollback.$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$BACKUP_DIR" ]] || fail "Rollback path already exists: $BACKUP_DIR"
SERVICE_STOPPED=1
systemctl stop "$SERVICE_NAME"
mv -- "$INSTALL_DIR" "$BACKUP_DIR"
mv -- "$TMP_DIR/release" "$INSTALL_DIR"
systemctl start "$SERVICE_NAME"

READY=0
for _ in $(seq 1 30); do
    if curl --fail --silent --max-time 2 "http://${HEALTH_ADDRESS}:${PORT_VALUE}/healthz" >/dev/null; then
        READY=1
        break
    fi
    sleep 1
done
if [[ "$READY" != "1" ]]; then
    systemctl status "$SERVICE_NAME" --no-pager >&2 || true
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
    fail "The updated panel did not pass its local health check."
fi

printf '\nQOrange Panel updated and healthy.\n'
printf 'Rollback copy retained at: %s\n' "$BACKUP_DIR"
printf 'Authentication files, panel.env, service registry, environment files, builds, and application data were not changed.\n'
