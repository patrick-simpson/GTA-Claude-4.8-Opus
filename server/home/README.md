# The main home: the message service on the always-on mini PC

The same room as the Cloudflare backup (`../src/room.ts`), run by Node on a home computer with no
daily limits, reached through a free Cloudflare quick tunnel. For Debian 13, x86-64.

## Install (once)

What the line below does: it downloads `install.sh` from this repository and runs it as root. That
script makes a locked-down system user `port-calamity`, the folders `/opt/port-calamity` and
`/var/lib/port-calamity`, and four systemd units (the service, the tunnel, an update timer). It
installs the Debian packages git, curl and xz-utils only if they are missing, adds no apt repository,
opens no firewall port, uses no Cloudflare login, and touches nothing else on the computer.

    curl -fsSL https://raw.githubusercontent.com/patrick-simpson/GTA-Claude-4.8-Opus/main/server/home/install.sh | sudo bash

It ends by printing a **PUBLIC KEY** (one line of 43 characters). Send that line to the game's
developer; it is not a secret. Nothing else is ever needed on this computer: it starts at boot,
restarts itself, and updates itself from this repository every five minutes.

Running the line again is safe (it repairs and refreshes; the key is kept).

## Is it working?

    systemctl status port-calamity port-calamity-tunnel port-calamity-update.timer
    curl http://127.0.0.1:8788/health
    journalctl -u port-calamity-tunnel -n 20 -o cat      # "tunnel up: https://....trycloudflare.com", then "registered with the backup"
    sudo cat /var/lib/port-calamity/key/main.pub         # the public key again

`/health` answers one line such as
`{"ok":true,"service":"port-calamity-home","v":4,"release":"b0bd17a610c4","uptime":42,"seats":8,"players":0}`.
Until the developer has added the public key to the repository the tunnel log says
"registration refused (403...)" or "not registering": that is expected, and it sorts itself out.

## Stop it, or remove it

    sudo systemctl stop port-calamity-tunnel port-calamity port-calamity-update.timer      # stop until the next boot
    sudo systemctl disable --now port-calamity-tunnel port-calamity port-calamity-update.timer   # stop for good, keep the files
    sudo /opt/port-calamity/bin/uninstall.sh            # remove all of it (units, folders, user, key)
    sudo /opt/port-calamity/bin/uninstall.sh --keep-key # the same, but a later install keeps the same public key

With it stopped the game simply uses the backup, then single player.

## How it is put together (for the developer)

| piece | what |
| --- | --- |
| `main.ts` | the service: `ws` round `Room`, 127.0.0.1 only, facts in `/var/lib/port-calamity/city/facts.json`, `/health` |
| `tunnel.ts` | parent of `cloudflared`: reads the quick tunnel's address, checks the game answers through it, registers it signed (Ed25519) with the backup, heartbeat every 30 min, replaces a dead tunnel |
| `selftest.ts` | joins a candidate version as a player; part of the update's validation |
| `update.sh` | the self-update (below); installed root-owned, deliberately not self-updating |
| `pins.env` | the exact Node, cloudflared and ws, with SHA-256 |
| `units/` | the systemd units; `install.sh`, `uninstall.sh` |

**How TypeScript reaches the PC: there is no build.** Debian's own Node (20) cannot run `.ts`, so the
update downloads the official Node 24 binary from nodejs.org into `/opt/port-calamity/app/runtime`,
checks its SHA-256 against `pins.env`, and Node runs the `.ts` files as they are (type stripping;
`home/tsconfig.json` has `erasableSyntaxOnly`, so `npm run typecheck` fails on anything Node could
not strip). Nothing is committed that could go stale, no apt repository is added, nothing system-wide
changes, and a new Node or cloudflared is one pushed edit of `pins.env`. The only runtime dependency
is `ws`, fetched as its registry tarball with a pinned SHA-256 (no npm on the PC).

**The self-update** watches only `server/home`, `server/src`, `server/package.json` and
`src/net/protocol.ts` on `main`: other pushes restart nothing. A new version is built beside the old
one, started on a spare port (8789), must answer `/health` with its own release name and seat a test
player, and only then does the `current` link move. The running programs see the link change and
exit; systemd starts them from the new code (no root, no polkit). If the real service does not come
up on the new version within 90 s the link moves back, and that version is never tried again.
The tunnel is restarted (new address) only when `tunnel.ts`, `where.ts`, `protocol.ts` or the
cloudflared pin changed.

**Boxed in**: one system user with no login and no home; `ProtectSystem=strict`, `ProtectHome=yes`,
private `/tmp` and devices, no capabilities, `NoNewPrivileges`, a system call filter, memory capped at
256 MB and CPU at half a core per unit. The service itself can reach the loopback interface only
(`IPAddressDeny=any`), cannot read the key, and can write one folder. `/opt/dashboard` and
`/etc/dashboard` are `InaccessiblePaths` in every unit. Logs go to journald and hold no numeric
address: cloudflared's own output is discarded.

Tests (from `server/`): `npm test` (the Worker, the registration path, then the same room checks
against `main.ts`), `bash test/update-test.sh` (the self-update end to end, without systemd),
and from the repository root `node tools/net/main.mjs` (a browser finds main, follows it, falls back).
