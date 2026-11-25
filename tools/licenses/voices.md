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

## Claude FM's host (Kokoro, not Piper)

The host of Claude FM (`public/audio/voice/dj-claudefm.*`, 28 lines, about 0.9 MB as Opus/WebM at 32 kbps, 0.8 MB as MP3) is spoken by
**Kokoro-82M v1.0** (hexgrad), synthesised offline with `kokoro-onnx` 0.4.7 (MIT) in `C:\Users\User\kokoro` (outside the repo; models
`kokoro-v1.0.onnx` and `voices-v1.0.bin` from github.com/thewh1teagle/kokoro-onnx, release `model-files-v1.0`). Read on 2026-11-24:

| Part | Licence | Notes |
| --- | --- | --- |
| Kokoro-82M weights | **Apache-2.0** (model card, huggingface.co/hexgrad/Kokoro-82M: "Apache-licensed weights, Kokoro can be deployed anywhere ... we welcome the deployment of the model in real use cases") | Architecture StyleTTS 2 (MIT), ISTFTNet |
| Voice pack `am_michael` (American English, male; grade C+, target quality B) | Part of the same Apache-2.0 release; the card names no separate voice licence | The card states the training data was "exclusively permissive/non-copyrighted audio" (public domain, Apache/MIT, and synthetic audio from closed TTS providers; none from open TTS models or custom clones). The only CC BY audio it lists is Koniwa (Japanese) and SIWIS (French), neither American. |
| espeak-ng (phonemiser, GPL-3.0) | Used only at build time to turn text into phonemes; not shipped or linked into the game; the spoken audio is not a derivative of it | |

Allowed in a public game, so Kokoro is used (no fall back to Piper was needed). Apache-2.0 asks no attribution for output audio, but the
credit is shown anyway (`VOICE_CREDIT` in `src/audio/voices.ts`). Chosen by analysis of the same 140-character line in `am_michael`,
`am_adam`, `am_fenrir`, `am_puck`, `af_heart`, `af_bella` (median pitch, pitch spread in semitones, voicing clarity, peak level):
`am_michael` has a low steady pitch (117 Hz, spread 3.2 semitones, so it does not swing), no clipping (peak 0.56; `am_fenrir` peaked at 1.00)
and the calm pace of a late-night host. Speed 0.93. Broadcast chain (ffmpeg): 85 Hz high-pass, +2.5 dB at 170 Hz for body, +1.5 dB at
3.2 kHz, -2 dB at 6.5 kHz against hiss, low-pass 9.5 kHz, gentle 3:1 compressor, levelled to about -18 LUFS. Regenerate (repo root):
`C:\Users\User\kokoro\venv\Scripts\python.exe -I scratch/fmdj/gen.py [voice]`; the lines are in `scratch/fmdj/lines.py`.

The reactive host lines (`public/audio/voice/dj-claudefm-react.*`, 36 lines, 0.73 MB Opus/WebM at 32 kbps, 0.68 MB MP3) use the same voice, speed and chain: `C:/Users/User/kokoro/venv/Scripts/python.exe -I tools/radio/gen-react.py` (repo root); the lines are in `src/audio/fmReactLines.json`.

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
