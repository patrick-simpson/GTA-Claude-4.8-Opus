#!/bin/bash
# PORT CALAMITY home service: the self-update. A systemd timer runs it every few minutes as the
# unprivileged service user (never as root), inside the sandbox of port-calamity-update.service.
#
# What it does, in order:
#  1. asks this repository's main branch what the service's code is now (server/home, server/src,
#     src/net/protocol.ts). Nothing else in the repository matters: a change to the game itself
#     does not restart anything here. If the code is what is running: done, silently.
#  2. builds the new version in its own folder beside the old one, with the exact Node, cloudflared
#     and ws that server/home/pins.env names, each download checked against its SHA-256.
#  3. VALIDATES it before switching: starts it on a spare port, and joins it as a player would.
#  4. switches the "current" link, keeps the previous version, and watches the real service come up
#     on the new one. If it does not, it switches back, and remembers that version as bad.
# The running programs notice the link change and restart themselves; nothing here needs privilege.
#
# This file is installed once by install.sh (root owned) and is deliberately NOT self-updating:
# it is the part that must keep working so that everything else can be repaired by a push.
#
# It prints one line when it does something, nothing when there is nothing to do, and never an address.

set -euo pipefail
umask 022

APP="${PC_APP:-/opt/port-calamity/app}"
STATE="${PC_UPDATE_STATE:-/var/lib/port-calamity/update}"
REPO_URL="${PC_REPO_URL:-https://github.com/patrick-simpson/GTA-Claude-4.8-Opus}"
BRANCH="${PC_BRANCH:-main}"
PORT="${PC_PORT:-8788}"
SPARE_PORT="${PC_SPARE_PORT:-8789}"
# The paths of the repository that make up the service. A change anywhere else is not an update.
PATHS=(server/home server/src server/package.json src/net/protocol.ts)

say() { echo "update: $*" >&2; }
die() { say "$*"; exit 1; }

mkdir -p "$APP/releases" "$APP/runtime" "$APP/cache" "$STATE/bad"
exec 9>"$STATE/lock"
flock -n 9 || exit 0

WORK="$(mktemp -d)"
CAND_PID=""
cleanup() {
  if [ -n "$CAND_PID" ]; then kill "$CAND_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
  rm -rf "$APP/releases/"*.tmp 2>/dev/null || true
}
trap cleanup EXIT

# ---- 1. what is the code now? ----

REPO="$APP/repo"
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
if [ ! -d "$REPO/.git" ]; then
  rm -rf "$REPO"
  # History and the game's own files are not fetched: one commit, and only the folders below.
  git clone --quiet --depth 1 --filter=blob:none --no-checkout --branch "$BRANCH" "$REPO_URL" "$REPO" 2>/dev/null \
    || die "could not fetch the repository (no network?)"
  git -C "$REPO" sparse-checkout set server/home server/src src/net 2>/dev/null || die "could not prepare the checkout"
fi
git -C "$REPO" fetch --quiet --depth 1 origin "$BRANCH" 2>/dev/null || die "could not reach the repository (no network?)"

ID_SRC=""
for p in "${PATHS[@]}"; do
  ID_SRC+="$(git -C "$REPO" rev-parse --verify --quiet "FETCH_HEAD:$p" || die "the repository has no $p")"$'\n'
done
ID="$(printf '%s' "$ID_SRC" | sha256sum | cut -c1-12)"

current_id() { basename "$(readlink "$APP/$1" 2>/dev/null || true)"; }
[ "$(current_id current)" = "$ID" ] && exit 0
[ -e "$STATE/bad/$ID" ] && exit 0
say "new version $ID (running: $(current_id current || true))"

bad() {
  : > "$STATE/bad/$ID"
  die "version $ID REFUSED: $*. Still running $(current_id current). It will not be tried again; push a fix."
}

# ---- 2. build it beside the old one ----

git -C "$REPO" checkout --quiet --force --detach FETCH_HEAD 2>/dev/null || die "could not check the new version out"
REL="$APP/releases/$ID.tmp"
rm -rf "$REL"
mkdir -p "$REL/server" "$REL/src/net"
cp -R "$REPO/server/home" "$REPO/server/src" "$REPO/server/package.json" "$REL/server/"
cp "$REPO/src/net/protocol.ts" "$REL/src/net/"
echo '{ "type": "module", "private": true }' > "$REL/package.json"
echo "$ID" > "$REL/RELEASE"

# The pins: NAME=value lines, nothing else is read (the file is never executed).
pin() {
  local v
  v="$(sed -n "s/^$1=\([A-Za-z0-9._-]\{1,80\}\)\$/\1/p" "$REL/server/home/pins.env" | head -n 1)"
  [ -n "$v" ] || bad "pins.env has no usable $1"
  printf '%s' "$v"
}
NODE_VERSION="$(pin NODE_VERSION)"; NODE_SHA256="$(pin NODE_SHA256)"
CLOUDFLARED_VERSION="$(pin CLOUDFLARED_VERSION)"; CLOUDFLARED_SHA256="$(pin CLOUDFLARED_SHA256)"
WS_VERSION="$(pin WS_VERSION)"; WS_SHA256="$(pin WS_SHA256)"

# fetch <url> <sha256> : prints the path of the verified file (kept in the cache, named by its checksum).
fetch() {
  local url="$1" sha="$2" out="$APP/cache/$2"
  if [ ! -f "$out" ] || ! echo "$sha  $out" | sha256sum --check --status; then
    rm -f "$out" "$out.part"
    curl --silent --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 900 --output "$out.part" "$url" 2>/dev/null \
      || die "could not download $(basename "$url") (no network?)"
    echo "$sha  $out.part" | sha256sum --check --status || { rm -f "$out.part"; bad "$(basename "$url") does not have the pinned SHA-256"; }
    mv "$out.part" "$out"
  fi
  printf '%s' "$out"
}

NODE_DIR="$APP/runtime/node-v$NODE_VERSION"
if [ ! -x "$NODE_DIR/node" ]; then
  f="$(fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256")"
  mkdir -p "$WORK/node"
  tar -xJf "$f" -C "$WORK/node" --strip-components=2 "node-v$NODE_VERSION-linux-x64/bin/node" || bad "the Node archive could not be unpacked"
  mkdir -p "$NODE_DIR" && mv "$WORK/node/node" "$NODE_DIR/node" && chmod 0755 "$NODE_DIR/node"
fi
CF_DIR="$APP/runtime/cloudflared-$CLOUDFLARED_VERSION"
if [ ! -x "$CF_DIR/cloudflared" ]; then
  f="$(fetch "https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_${CLOUDFLARED_VERSION}_amd64.deb" "$CLOUDFLARED_SHA256")"
  mkdir -p "$WORK/cf"
  # Unpacked, never installed: no package is added to the system.
  dpkg-deb --fsys-tarfile "$f" | tar -x -C "$WORK/cf" ./usr/bin/cloudflared || bad "the cloudflared package could not be unpacked"
  mkdir -p "$CF_DIR" && mv "$WORK/cf/usr/bin/cloudflared" "$CF_DIR/cloudflared" && chmod 0755 "$CF_DIR/cloudflared"
fi
f="$(fetch "https://registry.npmjs.org/ws/-/ws-$WS_VERSION.tgz" "$WS_SHA256")"
mkdir -p "$REL/server/home/node_modules/ws"
tar -xzf "$f" -C "$REL/server/home/node_modules/ws" --strip-components=1 || bad "the ws package could not be unpacked"

ln -s "../../runtime/node-v$NODE_VERSION/node" "$REL/node"
ln -s "../../runtime/cloudflared-$CLOUDFLARED_VERSION/cloudflared" "$REL/cloudflared"
NODE=("$REL/node" --disable-warning=ExperimentalWarning)
[ "$("$REL/node" --version 2>/dev/null)" = "v$NODE_VERSION" ] || bad "the pinned Node does not run here"
"$REL/cloudflared" --version >/dev/null 2>&1 || bad "the pinned cloudflared does not run here"

# ---- 3. validate BEFORE switching ----

health() { curl --silent --fail --max-time 5 "http://127.0.0.1:$1/health" 2>/dev/null || true; }
WAS_RUNNING=""
[ -n "$(health "$PORT")" ] && WAS_RUNNING=1

mkdir -p "$WORK/state" "$WORK/key"
PC_PORT="$SPARE_PORT" PC_STATE="$WORK/state" PC_CURRENT="" "${NODE[@]}" "$REL/server/home/main.ts" >"$WORK/candidate.log" 2>&1 &
CAND_PID=$!
ok=""
for _ in $(seq 1 40); do
  case "$(health "$SPARE_PORT")" in *"\"release\":\"$ID\""*) ok=1; break ;; esac
  kill -0 "$CAND_PID" 2>/dev/null || break
  sleep 0.5
done
[ -n "$ok" ] || bad "it did not start and answer /health on the spare port ($(tail -n 3 "$WORK/candidate.log" | tr '\n' ' ' | cut -c1-300))"
"${NODE[@]}" "$REL/server/home/selftest.ts" "$SPARE_PORT" "$ID" >"$WORK/selftest.log" 2>&1 || bad "it did not seat a test player ($(tail -n 2 "$WORK/selftest.log" | tr '\n' ' ' | cut -c1-300))"
# The tunnel's supervisor cannot be tried without a real tunnel; at least it must load and handle a key.
PC_KEYDIR="$WORK/key" "${NODE[@]}" "$REL/server/home/tunnel.ts" --key >/dev/null 2>"$WORK/tunnel.log" || bad "the tunnel supervisor does not load ($(tail -n 2 "$WORK/tunnel.log" | tr '\n' ' ' | cut -c1-300))"
kill "$CAND_PID" 2>/dev/null || true
wait "$CAND_PID" 2>/dev/null || true
CAND_PID=""

# ---- 4. switch, keep the previous one, and watch ----

point() { ln -s "$2" "$APP/$1.new" && mv -T "$APP/$1.new" "$APP/$1"; }
OLD="$(current_id current || true)"
rm -rf "$APP/releases/$ID"
mv "$REL" "$APP/releases/$ID"
point current "releases/$ID"
[ -n "$OLD" ] && [ -d "$APP/releases/$OLD" ] && point previous "releases/$OLD"

if [ -n "$WAS_RUNNING" ]; then
  ok=""
  for _ in $(seq 1 90); do
    case "$(health "$PORT")" in *"\"release\":\"$ID\""*) ok=1; break ;; esac
    sleep 1
  done
  if [ -z "$ok" ]; then
    if [ -n "$OLD" ] && [ -d "$APP/releases/$OLD" ]; then
      point current "releases/$OLD"
      : > "$STATE/bad/$ID"
      die "version $ID did not come up as the real service: ROLLED BACK to $OLD. It will not be tried again; push a fix."
    fi
    die "version $ID did not come up as the real service, and there is no earlier one to go back to"
  fi
fi
say "now running $ID${OLD:+ (previous: $OLD, kept)}"

# ---- tidy: only the current and previous versions, and what they use, are kept ----

KEEP_A="$(current_id current || true)"; KEEP_B="$(current_id previous || true)"
for d in "$APP/releases/"*; do
  [ -d "$d" ] || continue
  n="$(basename "$d")"
  [ "$n" = "$KEEP_A" ] || [ "$n" = "$KEEP_B" ] || rm -rf "$d"
done
for d in "$APP/runtime/"*; do
  [ -d "$d" ] || continue
  used=""
  for r in "$KEEP_A" "$KEEP_B"; do
    [ -n "$r" ] || continue
    for l in node cloudflared; do
      [ "$(dirname "$(readlink -f "$APP/releases/$r/$l" 2>/dev/null || true)")" = "$d" ] && used=1
    done
  done
  [ -n "$used" ] || rm -rf "$d"
done
find "$APP/cache" -type f -mtime +7 -delete 2>/dev/null || true
find "$STATE/bad" -type f -mtime +90 -delete 2>/dev/null || true
exit 0
