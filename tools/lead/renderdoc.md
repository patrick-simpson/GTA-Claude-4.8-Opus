# RenderDoc on this laptop (installed Nov 23, winget BaldurKarlsson.RenderDoc 1.47)

`winget install --id BaldurKarlsson.RenderDoc -e` -> C:\Program Files\RenderDoc (renderdoccmd.exe, qrenderdoc.exe). The
Python module `renderdoc` exists ONLY inside qrenderdoc.exe: run scripts with `qrenderdoc.exe --python <abs path>.py`.
First launch shows an "Anonymous Analytics" dialog that blocks the script: press Down, Down, Enter (opt out) once.
Windows Firewall may also ask about Chrome: Esc.

## Capturing the game in Chrome (what worked)
Chrome's GPU process was NOT hooked by `--opt-hook-children`, so run the GPU inside the browser process:

    renderdoccmd capture -d <dir> -c <dir>\cap -w "%LOCALAPPDATA%\ms-playwright\chromium-1248\chrome-win64\chrome.exe"
      --user-data-dir=<dir>\prof --remote-debugging-port=9333 --use-angle=d3d11 --in-process-gpu --disable-gpu-sandbox
      --ignore-gpu-blocklist --force_high_performance_gpu --no-first-run --no-sandbox  http://127.0.0.1:5199/index.html?net=0&q=high&save=0&xmas=0

(`--force_high_performance_gpu` = the RTX.) Serve the game with `npx vite --port 5199 --host 127.0.0.1` (note: a vite
dev server serves WORKING-TREE files, so another worker's half-done import breaks it; a `git archive HEAD` copy with a
node_modules junction works, but then fonts 403 harmlessly).
Then `qrenderdoc.exe --python tools/lead/renderdoc/loop.py` connects by target control (EnumerateRemoteTargets, one
target = the browser process) and waits for files `req_<name>.txt` in scratch/renderdoc: it triggers a capture and
writes `<name>.rdc` + `done_<name>.txt`. `tools/lead/renderdoc/drive.mjs [names]` drives the page over CDP (teleport,
time, weather, tornado), writes the request files and screenshots. (Paths inside the scripts are absolute: edit D.)
A capture is about 300 MB (textures): delete them after analysing.

## Reading a capture
`analyze.py` (names in scratch/renderdoc/an_names.txt) opens each .rdc, walks every action, reads the pipeline state at
each draw (targets, pixel shader id, blend), and writes `<name>.json` (event, name, indices, target size, GPU ms).
`node tools/lead/renderdoc/summ.mjs name...` groups into passes by render target (shadow 2048x2048, main, bloom
chain 950..59, composite) and lists the dearest draws. `shaders.py` dumps constant-buffer names of the top pixel
shaders (a hint to which material). Caveats: replay GPU times run at low clocks, so use them as shares, not absolute
ms; D3D11 `DiscardView` events absorb a big idle gap (8 ms) that is not work.

## Timing without noise: tools/lead/gpubench.mjs
rafprobe --vsync is +-3 ms noisy on battery (GPU clocks wander). gpubench renders 80 frames back to back with
gl.finish, configs interleaved over rounds: `node tools/lead/gpubench.mjs --scene downtown --cfg full,noShadow,noPost`.
