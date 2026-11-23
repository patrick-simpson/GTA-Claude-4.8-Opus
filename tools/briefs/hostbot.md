# Brief: the mini PC as the town's permanent host (owner, Nov 23: TOP PRIORITY)

Owner: "Push to make the PC the permanent host the priority." Context: multiplayer looked "a little
glitchy, like bad ping". The mini PC (Debian 13, x86-64, always on; server/home/README.md) already
runs the message service (the main room) and updates itself from this repository every 5 minutes, but
it only relays. The shared town (traffic, parked cars, crowd, police, helicopter, fire, the clock and
weather, missions' shared parts) is simulated by ONE player's browser, the host (src/net/), and if
that is a phone or a busy machine everybody's town stutters, and a host leaving forces a hand-over.

Build a dedicated host that runs on the mini PC:
1. A HOST-ONLY MODE of the game (for example `?hostbot=1&key=...`): it joins the main town but has no
   player character, is not drawn, not on the radar or map, not counted in the town's 8 seats, sends no
   player state, and does not render frames (tick the simulation at a fixed rate without drawing; no
   WebGL needed if the simulation can run without the renderer, otherwise draw nothing and the
   smallest canvas). It simulates the shared town around ALL the players (today the host centres
   traffic and crowd on itself; centre them on every player's position, merging areas).
2. HOST CHOICE: the room (server/src/room.ts, shared by the home service and the Cloudflare backup)
   always makes the host bot the host when it is present, authenticated so a visitor cannot claim it
   (reuse the mini PC's key: server/src/mainkey.ts and /var/lib/port-calamity/key/), and falls back to
   today's player-host rules when it is absent or stalls. The backup never gets a bot (it stays as is).
3. ON THE MINI PC: a new systemd unit started by the existing installer and update path that runs the
   host bot (headless Chromium through Playwright, or plain Node if the simulation can run there), with
   the same lock-down as the other units, restarting itself, logging a line a minute (players, town
   cars, tick time). If it needs Debian packages (a browser and its libraries), the installer adds
   them, and the OWNER must run the install line once more on the mini PC: say so plainly and give
   the exact line; nothing else should need the owner. Keep CPU modest (it is a mini PC).
4. PROTOCOL: keep it backwards-safe if possible; if the Worker must be redeployed, say so (the lead runs
   the kvbcawana workflow deploy-port-calamity-city.yml).
Tests: a tools/net/hostbot.mjs: the local home service plus the bot plus two or three player browsers:
the bot is host, players are guests, traffic/crowd/police are shared and smooth (displacement against
speed, as the earlier smoothness checks), a player-host takes over when the bot is stopped, the bot
takes back over when it returns, the 8-seat cap is unaffected. Server tests pass. Measure the bot's
CPU and memory on this laptop as a stand-in for the mini PC.

## Also fix, from the glitch diagnosis (Nov 23, scratch/glitch/, report summarised in lead-notes)
No regression was found in today's builds; guests already draw other players and shared cars with
large frame-to-frame speed swings (pops in 11-15% of frames), worse when frame pacing is uneven.
a. RATE CAP: in busy play a host page sends 44-45 messages a second; server/src/room.ts allows 40 a
   second (burst 80) and kicks with 4002 "too fast" when it runs out, which would look exactly like bad
   ping (host kicked, reconnects, host job moves). Count by kind what reaches room.ts from a host in
   busy play; give the host (and the bot) a proper allowance and keep guests' cap; make the client
   batch so it stays well under.
b. SMOOTHING: src/net/index.ts Net.update places remote things at performance.now() (about line 395)
   rather than the frame's time, so uneven frames show as uneven motion. Use the frame time and a
   steady interpolation delay; re-measure guest smoothness at 60 Hz vsync (tools/lead/rafprobe.mjs
   boot60 pattern; scratch/glitch/measure.mjs is the measuring script) before and after.
c. src/core/update.ts reloads whenever the stamp differs, even to an OLDER one; GitHub Pages' CDN
   ignores query strings. Reload only when the same new id has been seen twice in a row (or once
   after a 30 s wait), never for an id equal to one seen before this page loaded.
