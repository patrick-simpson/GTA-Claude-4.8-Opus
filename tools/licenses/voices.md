# Voices (Piper text-to-speech)

Every spoken line in the game (radio DJs and adverts, police megaphones and radio chatter, townsfolk barks) was
written for Port Calamity and synthesised offline with **Piper** (piper-tts 1.8, MIT licence, installed in
`C:\Users\User\piper`, outside the repo). Nothing is synthesised at runtime and nothing is fetched from a network
service: the output is baked into `public/audio/voice/` (Opus/WebM 24 kbps mono, MP3 24 kbps fallback) by
`scratch/voices/gen.py` from the lines in `scratch/voices/lines.py`.

Rule: only voices whose model card names a dataset licence that allows use in a public game, AND whose training
lineage (what the model was fine-tuned from) is equally clear. The model cards were read on 2026-11-23
(`rhasspy/piper-voices` on Hugging Face, `MODEL_CARD` next to each voice).

## Used

| Voice | Dataset and licence | Lineage | Used for |
| --- | --- | --- | --- |
| `en_GB-vctk-medium` (109 speakers; speaker ids 1, 5, 6, 10, 11, 13, 15, 16, 19, 20, 24, 25, 27, 29, 36, 38, 40, 44, 57, 60, 67, 71, 79, 82, 86, 87, 88, 95, 97, 98) | VCTK corpus 0.92, University of Edinburgh, CC BY 4.0 (datashare.ed.ac.uk/handle/10283/3443) | Fine-tuned from `hifi_tts_92` (Hi-Fi TTS, CC BY 4.0) | Most DJs, adverts, police, barks |
| `en_GB-alba-medium` (1 speaker) | Alba recordings, University of Edinburgh, CC BY 4.0 (datashare.ed.ac.uk/handle/10283/3270) | Fine-tuned from `hifi_tts_92` (CC BY 4.0) | The carols station's DJ |
| `en_US-ljspeech-high` (1 speaker) | LJ Speech, public domain (keithito.com/LJ-Speech-Dataset) | Trained from scratch | Ledger 1040's DJ |

Attribution (CC BY 4.0) is shown in the game: `VOICE_CREDIT` in `src/audio/voices.ts`, printed in the pause menu's
Settings tab. The voices are synthetic: no recording of any real speaker is reproduced, and no line mentions a real
person, place or brand.

## Not used, and why

| Voice | Reason |
| --- | --- |
| `en_US-libritts_r-medium` (904 speakers) | Dataset (LibriTTS-R) is CC BY 4.0, but the model card says it was fine-tuned from `lessac medium`, whose dataset (Blizzard 2013) carries restrictive terms. The lineage is unclear for a public game, so it is out even though it has the most speakers. |
| `en_US-lessac-*` | Blizzard 2013 licence terms, unclear for a public game. |
| `en_US-hfc_female-medium`, `en_US-hfc_male-medium` | Hi-Fi Captain, CC BY-NC-SA 4.0: non-commercial. |
| `en_US-amy`, `en_US-ryan`, others | Dataset terms not stated on the model card. |

Model files are not committed (they are 60-115 MB each); only the rendered clips are.

## Settings per character (length_scale, noise_scale, noise_w; pitch)

DJs: WDOOF spk 79 (0.86, 0.75, 0.9); Low Tide spk 71 (1.28, 0.6, 0.8); Ledger LJSpeech (1.0, 0.55, 0.7); Cannery spk 29
(0.9, 0.7, 0.85); Fishbone spk 97 (1.12, 0.6, 0.8, tremolo); WTPD spk 11 (1.0, 0.7, 0.85, AM band 320-3300 Hz); carols
Alba (1.05, 0.6, 0.8). Adverts: twelve different VCTK announcers, length 0.8-1.15. Police: four officers (spk 10, 25, 38,
15; 0.93-1.0) through a megaphone chain (500-3200 Hz band, hard-clipped, two echoes); dispatcher (spk 87, 60; 0.9) through
a squelched radio chain. Barks: seven men and seven women (VCTK), length 0.82-1.05, pitch factor 0.96-1.06.

## Regenerating

```
C:\Users\User\piper\venv\Scripts\python.exe -I scratch/voices/gen.py     (from the repo root)
```

Needs the three `.onnx` models and their `.json` in `C:\Users\User\piper\voices\` (downloaded from
`huggingface.co/rhasspy/piper-voices`, `en/en_GB/vctk/medium`, `en/en_GB/alba/medium`, `en/en_US/ljspeech/high`) and ffmpeg.
