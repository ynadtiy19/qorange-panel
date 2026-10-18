#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_ARCHIVE="https://codeload.github.com/ynadtiy19/qorange-panel/tar.gz/refs/heads/main"
INSTALL_DIR="/opt/qorange-panel"
DATA_DIR="/data/apps/qorange-panel"
ENV_DIR="/data/apps/env"
STATE_DIR="/var/lib/qorange-panel"
ETC_DIR="/etc/qorange-panel"
SERVICE_NAME="qorange-panel"
UNIT_FILE="/etc/systemd/system/qorange-panel.service"

TMP_DIR=""
CREATED_AUTH=0
INITIAL_PASSWORD=""
cleanup() {
    local result=$?
    if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
        rm -rf -- "$TMP_DIR"
    fi
    if [[ $result -ne 0 && $CREATED_AUTH -eq 1 ]]; then
        rm -f -- "$ETC_DIR/auth.json"
        systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
        printf '\nInstallation failed; the newly generated administrator credential was discarded.\n' >&2
    fi
    exit "$result"
}
trap cleanup EXIT

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' is not installed."
}

[[ "$(uname -s)" == "Linux" ]] || fail "This installer supports Linux VPS hosts with systemd."
[[ "$(id -u)" -eq 0 ]] || fail "Run this installer with sudo/root privileges."
for command_name in node npm systemctl curl tar docker gh openssl getent cut runuser; do
    require_command "$command_name"
done
systemctl --version >/dev/null 2>&1 || fail "systemd is required."

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 18 ]] || fail "Node.js 18 or newer is required."
docker info >/dev/null 2>&1 || fail "Docker is required and its daemon must already be running. No Docker data was changed."

INSTALLER_USER="${SUDO_USER:-root}"
USER_HOME="$(getent passwd "$INSTALLER_USER" | cut -d: -f6)"
[[ -n "$USER_HOME" && -d "$USER_HOME" ]] || fail "Could not determine the home directory for $INSTALLER_USER."
if [[ -n "${GH_CONFIG_DIR:-}" ]]; then
    GH_CONFIG_DIR_VALUE="$GH_CONFIG_DIR"
else
    GH_CONFIG_DIR_VALUE="$USER_HOME/.config/gh"
fi
if [[ "$INSTALLER_USER" != "root" ]]; then
    runuser -u "$INSTALLER_USER" -- env GH_CONFIG_DIR="$GH_CONFIG_DIR_VALUE" gh auth status >/dev/null 2>&1 ||
        fail "GitHub CLI is unavailable or '$INSTALLER_USER' is not authenticated. Run 'gh auth login' as that user, then rerun."
else
    gh auth status >/dev/null 2>&1 || fail "GitHub CLI is unavailable or root is not authenticated. Run 'gh auth login' as root, then rerun."
fi
env HOME="$USER_HOME" GH_CONFIG_DIR="$GH_CONFIG_DIR_VALUE" gh auth status >/dev/null 2>&1 ||
    fail "The authenticated GitHub CLI configuration cannot be read by the panel service account. Re-authenticate with gh and retry."

if [[ -e "$INSTALL_DIR" && ! -f "$INSTALL_DIR/.qorange-panel-owned" ]]; then
    LEGACY_PANEL=0
    if [[ -f "$INSTALL_DIR/package.json" && -f "$INSTALL_DIR/app.js" && -f "$INSTALL_DIR/public/index.html" ]] &&
        grep -q '"name"[[:space:]]*:[[:space:]]*"qorange-panel"' "$INSTALL_DIR/package.json" &&
        grep -q "CONFIG_PATH = path.join(__dirname, 'config.json')" "$INSTALL_DIR/app.js" &&
        grep -q 'QOrange' "$INSTALL_DIR/public/index.html"; then
        LEGACY_PANEL=1
    fi
    [[ "$LEGACY_PANEL" -eq 1 ]] || fail "$INSTALL_DIR exists but is not a recognized QOrange Panel installation; refusing to replace it."
fi
if [[ -e "$UNIT_FILE" ]]; then
    [[ -f "$UNIT_FILE" ]] || fail "$UNIT_FILE is not a regular file; refusing to replace it."
    if grep -q '^# QOrange Panel managed$' "$UNIT_FILE"; then
        :
    elif grep -q '^Description=.*QOrange Panel' "$UNIT_FILE" &&
        { grep -Fq "$INSTALL_DIR/app.js" "$UNIT_FILE" || grep -Fq "WorkingDirectory=$INSTALL_DIR" "$UNIT_FILE"; }; then
        printf 'Recognized legacy QOrange Panel systemd unit.\n'
    else
        fail "$UNIT_FILE exists but is not a recognized QOrange Panel unit; refusing to replace it."
    fi
fi
UNIT_FRAGMENT="$(systemctl show -p FragmentPath --value "$SERVICE_NAME" 2>/dev/null || true)"
if [[ -n "$UNIT_FRAGMENT" && "$UNIT_FRAGMENT" != "$UNIT_FILE" ]]; then
    fail "The $SERVICE_NAME service is defined by $UNIT_FRAGMENT, not the panel-owned unit; refusing to replace it."
fi

printf 'Checking existing MongoDB services (read-only)...\n'
MONGO_CONTAINERS="$(docker ps -a --format '{{.Names}}' | grep -i 'mongo' || true)"
if [[ -n "$MONGO_CONTAINERS" ]]; then
    printf 'Existing Mongo-related containers will be left untouched:\n%s\n' "$MONGO_CONTAINERS"
fi
if [[ -d /data/mongo_data ]]; then
    printf 'Existing /data/mongo_data found; this installer will not read, modify, or delete its contents.\n'
fi

TMP_DIR="$(mktemp -d /tmp/qorange-panel-install.XXXXXX)"
chmod 700 "$TMP_DIR"
curl --fail --silent --show-error --location "$REPOSITORY_ARCHIVE" -o "$TMP_DIR/release.tar.gz" ||
    fail "Could not download the QOrange Panel release archive."
mkdir "$TMP_DIR/release"
tar -xzf "$TMP_DIR/release.tar.gz" --strip-components=1 -C "$TMP_DIR/release"
[[ -f "$TMP_DIR/release/app.js" && -f "$TMP_DIR/release/package.json" ]] || fail "Downloaded release is incomplete."
cd "$TMP_DIR/release"
npm ci --omit=dev --no-audit --no-fund

install -d -m 0755 /opt "$INSTALL_DIR"
install -d -m 0700 "$DATA_DIR" "$ENV_DIR" "$STATE_DIR" "$STATE_DIR/builds" "$ETC_DIR"
chmod 700 "$DATA_DIR" "$ENV_DIR" "$STATE_DIR" "$STATE_DIR/builds" "$ETC_DIR"
if [[ ! -f "$ETC_DIR/session.key" ]]; then
    openssl rand -hex 32 > "$TMP_DIR/session.key"
    install -m 0600 "$TMP_DIR/session.key" "$ETC_DIR/session.key"
fi

if [[ ! -f "$ETC_DIR/auth.json" ]]; then
    INITIAL_PASSWORD="$(openssl rand -hex 24)"
    printf '%s\n' "$INITIAL_PASSWORD" | node "$TMP_DIR/release/scripts/create-auth.js" > "$TMP_DIR/auth.json"
    install -m 0600 "$TMP_DIR/auth.json" "$ETC_DIR/auth.json"
    CREATED_AUTH=1
fi

if systemctl is-active --quiet "$SERVICE_NAME"; then
    [[ -f "$UNIT_FILE" ]] || fail "An active $SERVICE_NAME service has no recognized panel-owned unit; refusing to stop it."
    systemctl stop "$SERVICE_NAME"
fi
cp -a "$TMP_DIR/release/." "$INSTALL_DIR/"
printf 'QOrange Panel managed installation\n' > "$INSTALL_DIR/.qorange-panel-owned"
chmod 600 "$INSTALL_DIR/.qorange-panel-owned"
node "$INSTALL_DIR/scripts/migrate-legacy.js" "$INSTALL_DIR/config.json" "$DATA_DIR/services.json" "$ENV_DIR"

systemd_quote() {
    local escaped="$1"
    escaped="${escaped//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    printf '"%s"' "$escaped"
}
NODE_PATH="$(command -v node)"
PANEL_ENV_TMP="$TMP_DIR/panel.env"
{
    printf 'PORT=8888\n'
    printf 'BIND_ADDRESS=0.0.0.0\n'
    printf 'DATA_DIR=/data/apps/qorange-panel\n'
    printf 'ENV_DIR=/data/apps/env\n'
    printf 'WORKSPACE_DIR=/var/lib/qorange-panel/builds\n'
    printf 'AUTH_FILE=/etc/qorange-panel/auth.json\n'
    printf 'SESSION_KEY_FILE=/etc/qorange-panel/session.key\n'
    printf 'COOKIE_SECURE=0\n'
    printf 'HOME=%s\n' "$(systemd_quote "$USER_HOME")"
    printf 'GH_CONFIG_DIR=%s\n' "$(systemd_quote "$GH_CONFIG_DIR_VALUE")"
} > "$PANEL_ENV_TMP"
install -m 0600 "$PANEL_ENV_TMP" "$ETC_DIR/panel.env"

UNIT_TMP="$TMP_DIR/qorange-panel.service"
cat > "$UNIT_TMP" <<EOF
# QOrange Panel managed
[Unit]
Description=QOrange VPS deployment panel
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ETC_DIR/panel.env
ExecStart=$NODE_PATH $INSTALL_DIR/app.js
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
install -m 0644 "$UNIT_TMP" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

READY=0
for _ in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:8888/healthz >/dev/null; then
        READY=1
        break
    fi
    sleep 1
done
if [[ "$READY" != "1" ]]; then
    systemctl status "$SERVICE_NAME" --no-pager >&2 || true
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
    fail "The panel did not pass its health check. No panel URL or credential has been printed."
fi

PUBLIC_IP="$(curl -4 --fail --silent --show-error --max-time 5 https://api.ipify.org 2>/dev/null || true)"
if [[ ! "$PUBLIC_IP" =~ ^[0-9.]+$ ]] || [[ "$(node -e 'process.stdout.write(String(require("node:net").isIP(process.argv[1])))' "$PUBLIC_IP")" != "4" ]]; then
    PUBLIC_IP=""
fi
printf '\nQOrange Panel installed and healthy.\n'
if [[ -n "$PUBLIC_IP" ]]; then
    printf 'Panel URL: http://%s:8888\n' "$PUBLIC_IP"
else
    printf 'Panel URL: http://127.0.0.1:8888 (use an SSH tunnel for remote access)\n'
fi
if [[ "$CREATED_AUTH" -eq 1 ]]; then
    printf 'Administrator password (shown once; save it now): %s\n' "$INITIAL_PASSWORD"
    printf 'Username: admin\n'
else
    printf 'Administrator credentials were preserved from the previous installation.\n'
fi
printf 'GitHub CLI authentication is inherited from %s; private repositories are supported.\n' "$INSTALLER_USER"
printf 'Security: use HTTPS before exposing this panel to the public internet, then set COOKIE_SECURE=1 in %s and restart the service.\n' "$ETC_DIR/panel.env"
printf 'For temporary secure remote access, use: ssh -L 8888:127.0.0.1:8888 <your-vps>\n'
printf 'MongoDB and /data/mongo_data were not modified. The installer does not remove /data/apps/*.\n'
CREATED_AUTH=0
