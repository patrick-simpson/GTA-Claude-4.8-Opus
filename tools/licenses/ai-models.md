# AI models used to make game art

Only models whose licences allow commercial use and use in a public game. Installed in
`C:\Users\User\ComfyUI\ComfyUI_windows_portable` (outside the repo; models are not committed).

| Model | File | Source | Licence | Use |
|---|---|---|---|---|
| Stable Diffusion XL base 1.0 | `models/checkpoints/sd_xl_base_1.0.safetensors` (6.9 GB) | https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0 | CreativeML Open RAIL++-M (commercial use allowed; use restrictions apply: no illegal, harmful, deceptive or defamatory output) | Billboard, poster and title-card imagery (`tools/art`) |
| SDXL VAE | `models/vae/sdxl_vae.safetensors` (335 MB) | https://huggingface.co/stabilityai/sdxl-vae | MIT | Decoding SDXL latents (tiled, bf16) |
| ComfyUI v0.46.0 (Windows portable, NVIDIA) | n/a | https://github.com/Comfy-Org/ComfyUI | GPL-3.0 (the tool only; its output is not covered) | Runs the models over a local HTTP API |

Rejected: FLUX.1-dev (non-commercial licence).

Notes
- Prompts ask for invented brands only and for no lettering; every word on the finished art is set in
  Big Shoulders Display / Barlow Semi Condensed by `tools/art/compose.mjs` (both SIL OFL).
- No real brands, logos, people or celebrities are named in any prompt (`tools/art/jobs.json`).
- OpenRAIL++-M asks that the licence text travel with redistributed model weights; the weights are not
  redistributed here, only images made with them.
