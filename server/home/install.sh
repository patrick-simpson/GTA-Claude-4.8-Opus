#!/bin/bash
# PORT CALAMITY: install the game's message service (the MAIN home) on this computer.
# For Debian 13 on x86-64. Run once, as root. Safe to run again (it repairs and updates; the key is kept).
#
#   curl -fsSL https://raw.githubusercontent.com/patrick-simpson/GTA-Claude-4.8-Opus/main/server/home/install.sh | sudo bash
#
# What it does:
#  - makes a system user "port-calamity" that cannot log in and owns nothing but this service;
#  - makes /opt/port-calamity (the programs) and /var/lib/port-calamity (its few small files);
#  - installs five systemd units: the service (loopback only), the quick tunnel with its supervisor,
#    the host bot (the town's permanent host: headless Chromium running the game's host-only mode),
#    and a timer that updates the service from this repository every five minutes (validated first,
#    previous version kept, rolled back if the new one fails);
#  - the first update run downloads the pinned Node, cloudflared and ws INTO /opt/port-calamity,
#    each checked against its SHA-256. Nothing is installed system-wide except, if missing, the
#    ordinary Debian packages git, curl, ca-certificates, xz-utils and chromium (for the host bot).
#    No apt repository is added.
#  - prints the service's PUBLIC key at the end. That one line goes to the game's developer.
# What it does not do: open a firewall port, log in to Cloudflare, or read, change or stop anything
# else on this computer. The service is forbidden (by its units) from /opt/dashboard and /etc/dashboard.
# To remove everything: sudo /opt/port-calamity/bin/uninstall.sh

set -euo pipefail

RAW="${PC_RAW:-https://raw.githubusercontent.com/patrick-simpson/GTA-Claude-4.8-Opus/main/server/home}"
USER_NAME=port-calamity
OPT=/opt/port-calamity
VAR=/var/lib/port-calamity
UNITS=(port-calamity.service port-calamity-tunnel.service port-calamity-hostbot.service port-calamity-update.service port-calamity-update.timer)
PORT=8788

say() { echo "port-calamity install: $*"; }
die() { echo "port-calamity install: STOPPED: $*" >&2; exit 1; }

main() {
  [ "$(id -u)" = 0 ] || die "run this as root (sudo)"
  [ "$(uname -m)" = x86_64 ] || die "this is for an x86-64 computer ($(uname -m) here)"
  command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "systemd is not running here"
  command -v apt-get >/dev/null || die "this is for Debian"
  # shellcheck disable=SC1091
  ver="$(. /etc/os-release 2>/dev/null && echo "${ID:-?} ${VERSION_ID:-?}")"
  [ "$ver" = "debian 13" ] || say "note: written for Debian 13; this is '$ver'. Carrying on."
  for p in /opt/dashboard /etc/dashboard; do
    case "$OPT/ $VAR/" in *"$p/"*) die "refusing to touch $p" ;; esac
  done

  # Ordinary Debian packages, only the missing ones.
  need=()
  command -v git >/dev/null || need+=(git)
  command -v curl >/dev/null || need+=(curl)
  command -v xz >/dev/null || need+=(xz-utils)
  [ -e /etc/ssl/certs/ca-certificates.crt ] || need+=(ca-certificates)
  # The host bot's browser (Debian's own package and the libraries it brings).
  [ -x /usr/bin/chromium ] || need+=(chromium)
  if [ "${#need[@]}" -gt 0 ]; then
    say "installing Debian packages: ${need[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}" >/dev/null
  fi
  for c in git curl xz tar sha256sum flock dpkg-deb; do command -v "$c" >/dev/null || die "the command '$c' is missing"; done

  # The user: no login, no home, no password, in no other group.
  if ! getent passwd "$USER_NAME" >/dev/null; then
    useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
    say "made the system user $USER_NAME"
  fi

  # The folders. Root owns the top and bin/ (the updater must not be able to rewrite itself);
  # the service user owns app/ (written only by the update unit) and the state.
  install -d -o root -g root -m 0755 "$OPT" "$OPT/bin"
  install -d -o "$USER_NAME" -g "$USER_NAME" -m 0755 "$OPT/app"
  install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$VAR" "$VAR/city" "$VAR/update" "$VAR/bot"
  install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "$VAR/key"
  # (A key kept by "uninstall.sh --keep-key" comes back to the new user.)
  chown -R "$USER_NAME:$USER_NAME" "$VAR"

  # This script's companions, from the same place it came from.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  for f in update.sh uninstall.sh "${UNITS[@]/#/units/}"; do
    if [ -n "${PC_SRC:-}" ]; then cp "$PC_SRC/$f" "$tmp/$(basename "$f")"
    else curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$RAW/$f" -o "$tmp/$(basename "$f")" || die "could not download $f"
    fi
    [ -s "$tmp/$(basename "$f")" ] || die "$f came back empty"
  done
  bash -n "$tmp/update.sh" && bash -n "$tmp/uninstall.sh" || die "a downloaded script is damaged"
  install -o root -g root -m 0755 "$tmp/update.sh" "$tmp/uninstall.sh" "$OPT/bin/"
  for u in "${UNITS[@]}"; do install -o root -g root -m 0644 "$tmp/$u" "/etc/systemd/system/$u"; done
  systemctl daemon-reload
  systemctl enable --quiet port-calamity.service port-calamity-tunnel.service port-calamity-hostbot.service port-calamity-update.timer

  # The first update: fetches the code and the pinned programs, validates, switches. A few minutes at most.
  say "fetching and checking the service (about 100 MB of downloads the first time)..."
  if ! systemctl start port-calamity-update.service; then
    journalctl -u port-calamity-update.service -n 15 --no-pager -o cat || true
    die "the first update did not finish. The timer will keep trying every five minutes; see: journalctl -u port-calamity-update"
  fi
  systemctl restart port-calamity.service
  systemctl start port-calamity-update.timer

  health=""
  for _ in $(seq 1 30); do
    health="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
    [ -n "$health" ] && break
    sleep 1
  done
  [ -n "$health" ] || { journalctl -u port-calamity.service -n 15 --no-pager -o cat || true; die "the service did not answer on this computer. See: journalctl -u port-calamity"; }
  say "the service answers: $health"

  systemctl restart port-calamity-tunnel.service
  for _ in $(seq 1 60); do [ -s "$VAR/key/main.pub" ] && break; sleep 1; done
  [ -s "$VAR/key/main.pub" ] || die "the tunnel's supervisor did not make its key. See: journalctl -u port-calamity-tunnel"
  tunnel=""
  for _ in $(seq 1 45); do
    tunnel="$(journalctl -u port-calamity-tunnel.service -n 30 --no-pager -o cat 2>/dev/null | sed -n 's/^tunnel up: //p' | tail -n 1)"
    [ -n "$tunnel" ] && break
    sleep 2
  done
  # The host bot: it signs its pass with the key the tunnel has just made.
  systemctl restart port-calamity-hostbot.service
  bot=""
  for _ in $(seq 1 45); do
    bot="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -o '"bot":true' || true)"
    [ -n "$bot" ] && break
    sleep 2
  done
  if [ -n "$bot" ]; then say "the host bot is in town (it is the host whenever it is running)"
  else say "the host bot is not in yet (it can take a minute). Later: journalctl -u port-calamity-hostbot -n 20"
  fi
  if [ -n "$tunnel" ]; then say "the tunnel is up: $tunnel/health"
  else say "the tunnel is not up yet (it can take a minute, and it retries by itself). Later: journalctl -u port-calamity-tunnel -n 20"
  fi

  echo
  echo "=================================================================="
  echo " Installed. It starts at boot, updates itself, and needs nothing more here."
  echo
  echo " PUBLIC KEY:  $(cat "$VAR/key/main.pub")"
  echo
  echo " Send that one line to the game's developer (it is not a secret). Until it is"
  echo " added to the game's repository, the game cannot find this computer."
  echo "=================================================================="
}

main "$@"
