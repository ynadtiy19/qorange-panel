# QOrange VPS Panel

QOrange is a small, single-server deployment dashboard. Sign in to the panel, pick a repository from the authenticated GitHub CLI account (including private repositories), accept its default branch or choose another branch, set an optional port mapping, and build/deploy it. Service controls include start, stop, restart, logs, replacing environment variables, and deleting the managed container.

## Install on a Linux VPS

Requirements: Linux with systemd, Node.js 18+, Docker Engine already installed and running, and GitHub CLI (`gh`) already authenticated as the user running the command. Run `gh auth login` before installing. The installer checks these prerequisites and recognizes its own prior installation plus the legacy QOrange directory; it refuses to overwrite an unrelated `/opt/qorange-panel`.

Run this on the VPS:

```sh
curl --fail --show-error --location https://raw.githubusercontent.com/ynadtiy19/qorange-panel/main/install.sh --output /tmp/qorange-panel-install.sh && sudo bash /tmp/qorange-panel-install.sh
```

After the systemd service passes its local health check, the installer prints the panel URL and, on first installation, a randomly generated administrator password once. Save that password. Re-running the installer preserves the existing administrator password and service registry. If public-IP detection is unavailable, use the printed localhost URL with the SSH tunnel command shown by the installer.

The installer manages `/opt/qorange-panel`, `/etc/qorange-panel`, `/var/lib/qorange-panel`, `/data/apps/qorange-panel`, and `/data/apps/env`; it does not remove `/data/apps/*`, stop or replace existing containers, or read, modify, or delete `/data/mongo_data`. For a recognized legacy QOrange config, application service metadata is migrated, env values are moved to mode-0600 files under `/data/apps/env`, the old weak `authSecret` is discarded, and database `runCmd` entries are ignored and never executed. Existing MongoDB containers remain untouched.

## Secure access

The installer binds port `8888` to all interfaces and initially uses HTTP so the first login works. Do **not** expose the panel to the public internet over plain HTTP: credentials and session traffic would be unencrypted. Prefer an HTTPS reverse proxy with a firewall allowing port 443 only, proxying to `127.0.0.1:8888`; then set `COOKIE_SECURE=1` in `/etc/qorange-panel/panel.env` and run `sudo systemctl restart qorange-panel`. For temporary access before configuring HTTPS, use an SSH tunnel:

```sh
ssh -L 8888:127.0.0.1:8888 <your-vps>
```

Open `http://127.0.0.1:8888` on your computer. Admin API requests require a signed, HttpOnly, SameSite session cookie, same-origin checks, and a CSRF token. The initial password is stored only as a scrypt hash. GitHub credentials are read from the authenticated `gh` configuration; do not paste a GitHub token into the panel.

## Environment variables and deployments

Enter one `KEY=VALUE` per line. The editor immediately renders editable key/value rows. Environment files are stored at `/data/apps/env/<service-id>.env` with restrictive permissions; they are never included in service listings or returned by the API. Existing values are not fetched back into the browser: replacing them requires entering the complete replacement set. Known values are redacted from container logs and operation errors.

Deployments fetch GitHub branch archives through `gh api`, so private-repository access uses the authenticated GitHub CLI without embedding credentials in Git URLs or shell commands. Docker operations use argument arrays and only manage containers labelled as QOrange-owned. Deleting a service removes that managed container and its environment file; it deliberately leaves images and build/source data alone. There is no unauthenticated webhook endpoint; deploys are initiated from the authenticated panel.

## Development and checks

```sh
npm install
npm test
npm run check
bash -n install.sh
```

`/healthz` is a minimal, unauthenticated local health endpoint. All service, GitHub, and system administration APIs require authentication.
