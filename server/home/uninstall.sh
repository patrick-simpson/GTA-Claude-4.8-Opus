#!/bin/bash
# PORT CALAMITY: remove the message service from this computer, all of it.
#   sudo /opt/port-calamity/bin/uninstall.sh              everything, the key included
#   sudo /opt/port-calamity/bin/uninstall.sh --keep-key   everything but /var/lib/port-calamity/key
# (With the key kept, a later install has the same public key and the game's developer need do nothing.)
# It removes only what install.sh made: five systemd units, /opt/port-calamity, /var/lib/port-calamity
# and the user "port-calamity". The Debian packages git, curl, xz-utils and chromium are left alone: other
# things on this computer may use them.

set -uo pipefail

main() {
  [ "$(id -u)" = 0 ] || { echo "run this as root (sudo)" >&2; exit 1; }
  local keep=""
  [ "${1:-}" = "--keep-key" ] && keep=1
  local units=(port-calamity-update.timer port-calamity-update.service port-calamity-hostbot.service port-calamity-tunnel.service port-calamity.service)
  for u in "${units[@]}"; do
    systemctl disable --now --quiet "$u" 2>/dev/null || true
    rm -f "/etc/systemd/system/$u"
  done
  systemctl daemon-reload
  systemctl reset-failed 'port-calamity*' 2>/dev/null || true
  # Anything still running as the user (there should be nothing).
  pkill -KILL -u port-calamity 2>/dev/null || true
  rm -rf /opt/port-calamity
  if [ -n "$keep" ]; then
    rm -rf /var/lib/port-calamity/city /var/lib/port-calamity/update /var/lib/port-calamity/bot
    chown -R root:root /var/lib/port-calamity 2>/dev/null || true
    echo "kept /var/lib/port-calamity/key"
  else
    rm -rf /var/lib/port-calamity
  fi
  if getent passwd port-calamity >/dev/null; then userdel port-calamity 2>/dev/null || true; fi
  if getent group port-calamity >/dev/null; then groupdel port-calamity 2>/dev/null || true; fi
  echo "port-calamity is removed."
}

main "$@"
exit 0
