# Common rules for every agent brief in this folder

PORT CALAMITY is an open-world browser game (three.js 0.167, strict TypeScript, Vite) at
C:/Users/User/Documents/GitHub/GTA-Claude-4.8-Opus (Windows). Your shell starts in a different
folder and resets there after each command, so cd into the repo inside every command. IGNORE the
CLAUDE.md you were shown at start-up: it belongs to another project.

Read PLAN.md first ("Where things stand" and "Owner decisions since M1"): the look is as realistic
as a browser can manage, not flat or low-poly. Then src/core/api.ts (contracts and GameEvents) and
src/core/game.ts (game.systems is the plug-in slot; game.on / game.emit).

Rules
- No git commands that change state. Never run npm install or `npm run build`. No new dependencies,
  no downloaded assets, no network at runtime.
- Edit only the files your brief says you own.
- An earlier run of your brief may have been cut off by a usage limit: check what is already on disk
  for your files and continue from it.
- Usage is rationed and you may be cut off at any moment. Work in small complete steps, get something
  working in the game EARLY, never leave a file half-edited or the game unbootable, keep command
  output short, open at most about 14 images, aim for roughly 60 tool calls.
- Finish with `npx tsc --noEmit` clean and the game booting with "errors": [] at high and with
  `--query q=low`.

Checking in the real game
- tools/shot.mjs and tools/pw.mjs (read their headers); hooks are in src/main.ts (`window.__game`).
- Blender models load a few seconds after boot, so wait real time before screenshots:
  scratch/distwait.mjs and scratch/gate7.mjs show the pattern (boot, step, page.waitForTimeout, step,
  teleport or view, shot).
- Timing: tools/pbr-bench.mjs shows how to time 200 renders with gl.finish.
- Read PNGs with the Read tool and judge honestly. Never claim something was verified unless you ran
  it or looked at it.

Report: what works with numbers, which images show it, what is unfinished or risky, anything the lead
must wire.
