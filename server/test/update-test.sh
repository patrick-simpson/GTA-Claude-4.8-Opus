#!/bin/bash
# A dry run of the home computer's self-update (server/home/update.sh), without systemd and without root:
#   bash test/update-test.sh        (from server/; about a minute; it downloads the pinned Node once, 30 MB)
# It makes a throwaway copy of the service's files as a git repository, points update.sh at it, plays
# the part of systemd (a loop that restarts the service when it exits), and checks:
#   a first install; nothing to do when nothing changed; a good change is switched to and the previous
#   kept; a version that does not start is refused BEFORE the switch; a version that passes validation
#   but fails as the real service is ROLLED BACK; a bad version is not tried again; a fix is taken.
# cloudflared is not downloaded or run here: a stand-in file takes its place (see the end of the report).
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/.." && pwd)"
T="$(mktemp -d)"
PORT=8771; SPARE=8772
fails=0
check() { if [ "$1" = 0 ]; then echo "PASS  $2"; else echo "FAIL  $2  ${3:-}"; fails=$((fails+1)); fi; }
is() { [ "$1" = "$2" ]; check $? "$3" "(got '$1', wanted '$2')"; }
has() { case "$1" in *"$2"*) check 0 "$3" ;; *) check 1 "$3" "(in: $(echo "$1" | tail -n 2 | cut -c1-200))" ;; esac; }

SRC="$T/src"; mkdir -p "$SRC/server" "$SRC/src/net"
cp -R "$here/home" "$here/src" "$here/package.json" "$SRC/server/"; rm -rf "$SRC/server/home/node_modules"
cp "$root/src/net/protocol.ts" "$SRC/src/net/"
g() { git -C "$SRC" -c user.name=test -c user.email=test@invalid "$@"; }
g init -q -b main; g config uploadpack.allowFilter true; g add -A; g commit -qm one

export PC_APP="$T/app" PC_UPDATE_STATE="$T/state" PC_REPO_URL="file://$SRC" PC_PORT=$PORT PC_SPARE_PORT=$SPARE
ver() { sed -n 's/^'"$1"'=//p' "$here/home/pins.env"; }
mkdir -p "$PC_APP/runtime/cloudflared-$(ver CLOUDFLARED_VERSION)"
printf '#!/bin/sh\necho stand-in\n' > "$PC_APP/runtime/cloudflared-$(ver CLOUDFLARED_VERSION)/cloudflared"; chmod +x "$PC_APP/runtime/cloudflared-$(ver CLOUDFLARED_VERSION)/cloudflared"
up() { bash "$here/home/update.sh" 2>&1; }
cur() { basename "$(readlink "$PC_APP/$1" 2>/dev/null)"; }
rel() { curl -s --max-time 3 "http://127.0.0.1:$PORT/health" | sed -n 's/.*"release":"\([^"]*\)".*/\1/p'; }
waitrel() { for _ in $(seq 1 40); do [ "$(rel)" = "$1" ] && return 0; sleep 0.5; done; return 1; }

out="$(up)"; is $? 0 "first install: update.sh succeeds"
A="$(cur current)"
has "$out" "now running $A" "first install: it says which version runs"
is "$("$PC_APP/current/node" --version)" "v$(ver NODE_VERSION)" "the pinned Node was downloaded, verified and runs"
[ -f "$PC_APP/current/server/home/node_modules/ws/package.json" ]; check $? "the pinned ws was downloaded, verified and unpacked"

# systemd's part: run the service from "current", again whenever it exits.
( while true; do PC_PORT=$PORT PC_STATE="$T/city" PC_CURRENT="$PC_APP/current" "$PC_APP/current/node" --disable-warning=ExperimentalWarning "$PC_APP/current/server/home/main.ts" >>"$T/service.log" 2>&1; sleep 1; done ) &
LOOP=$!
trap 'kill $LOOP 2>/dev/null; pkill -f "$PC_APP/" 2>/dev/null; rm -rf "$T"' EXIT
waitrel "$A"; check $? "the service runs version $A"

out="$(up)"; is "$?/$out" "0/" "nothing changed: nothing done, nothing printed"
echo "// a game change" >> "$SRC/README.md"; g add -A; g commit -qm unrelated
out="$(up)"; is "$?/$out/$(cur current)" "0//$A" "a change elsewhere in the repository is not an update"

echo "// a harmless change" >> "$SRC/server/home/main.ts"; g add -A; g commit -qm two
out="$(up)"; rc=$?; B="$(cur current)"
[ "$rc" = 0 ] && [ "$B" != "$A" ] && [ "$(cur previous)" = "$A" ]; check $? "a good change: validated, switched to, the previous version kept" "($out)"
waitrel "$B"; check $? "the running service restarted itself onto the new version"

sed -i '1i throw new Error("broken on purpose");' "$SRC/server/home/main.ts"; g add -A; g commit -qm broken
out="$(up)"; rc=$?
[ "$rc" != 0 ] && [ "$(cur current)" = "$B" ]; check $? "a version that does not start is refused BEFORE the switch" "($out)"
has "$out" "REFUSED" "and the log says so"
is "$(rel)" "$B" "the service never left the good version"
out="$(up)"; is "$?/$out" "0/" "a refused version is not tried again"

sed -i '1d' "$SRC/server/home/main.ts"
sed -i '1i if (process.env.PC_CURRENT) throw new Error("fails only as the real service");' "$SRC/server/home/main.ts"; g add -A; g commit -qm sneaky
out="$(up)"; rc=$?
[ "$rc" != 0 ] && [ "$(cur current)" = "$B" ]; check $? "a version that passes validation but fails as the real service is rolled back" "($out)"
has "$out" "ROLLED BACK" "and the log says so"
waitrel "$B"; check $? "the service is back on the good version"

sed -i '1d' "$SRC/server/home/main.ts"; echo "// fixed" >> "$SRC/server/home/main.ts"; g add -A; g commit -qm fixed
out="$(up)"; rc=$?; C="$(cur current)"
[ "$rc" = 0 ] && [ "$C" != "$B" ] && [ "$(cur previous)" = "$B" ]; check $? "a fix is taken" "($out)"
waitrel "$C"; check $? "and runs"
is "$(ls "$PC_APP/releases" | wc -l | tr -d ' ')" "2" "only the current and the previous version are kept on disk"

sed -i 's/^NODE_SHA256=.*/NODE_SHA256=0000000000000000000000000000000000000000000000000000000000000000/; s/^NODE_VERSION=.*/NODE_VERSION=24.22.2/' "$SRC/server/home/pins.env"; g add -A; g commit -qm badpin
out="$(up)"; rc=$?
[ "$rc" != 0 ] && [ "$(cur current)" = "$C" ]; check $? "a download that does not match its pinned SHA-256 is refused" "($out)"
! echo "$out$(cat "$T/service.log")" | grep -Eq '([0-9]{1,3}\.){3}[0-9]{1,3}'; check $? "nothing printed holds a numeric address"

[ "$fails" = 0 ] && echo "ALL PASS" || echo "$fails FAILED"
exit "$fails"
