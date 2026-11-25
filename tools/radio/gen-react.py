# Claude FM's reactive host lines (fun queue 2, item 31): same Kokoro voice (am_michael), speed and broadcast chain as
# scratch/fmdj/gen.py (the host's 28 stock lines); the lines are in src/audio/fmReactLines.json (kind -> [text]).
# Output: public/audio/voice/dj-claudefm-react.{webm,mp3,json} (a sprite file and its index, clip ids kind#i).
# Run from the repo root: C:\Users\User\kokoro\venv\Scripts\python.exe -I tools/radio/gen-react.py
import sys, os, json, subprocess, wave, tempfile
import numpy as np
from kokoro_onnx import Kokoro
VOICE = sys.argv[1] if len(sys.argv) > 1 else 'am_michael'
OUT = 'public/audio/voice'; TMP = tempfile.mkdtemp(); SR = 22050
LINES = json.load(open('src/audio/fmReactLines.json', encoding='utf-8'))
k = Kokoro(r'C:\Users\User\kokoro\models\kokoro-v1.0.onnx', r'C:\Users\User\kokoro\models\voices-v1.0.bin')
FX = ('highpass=f=85,equalizer=f=170:t=q:w=1:g=2.5,equalizer=f=3200:t=q:w=1:g=1.5,lowpass=f=9500,'
      'equalizer=f=6500:t=q:w=2:g=-2,acompressor=threshold=-24dB:ratio=3:attack=8:release=120:makeup=3')
def dress(a, n):
    src = '%s/in%d.wav' % (TMP, n)
    with wave.open(src, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes((np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())
    r = subprocess.run(['ffmpeg','-v','error','-y','-i',src,'-af',FX,'-ar',str(SR),'-ac','1','-f','f32le','-'], capture_output=True); os.remove(src)
    if r.returncode: print(r.stderr.decode()); raise SystemExit(1)
    x = np.frombuffer(r.stdout, dtype=np.float32).copy()
    idx = np.where(np.abs(x) > 0.02 * np.abs(x).max())[0]
    x = x[max(0, idx[0] - int(0.04*SR)): idx[-1] + int(0.1*SR)]
    x *= 0.14 / (np.sqrt((x**2).mean()) + 1e-9); x = np.tanh(x/0.85)*0.85
    f = int(0.015*SR); x[:f] *= np.linspace(0,1,f); x[-f:] *= np.linspace(1,0,f)
    return x
gap = np.zeros(int(0.12*SR), dtype=np.float32); parts=[]; index=[]; pos=0.0; n = 0
for kind, texts in LINES.items():
    for i, text in enumerate(texts):
        a, sr = k.create(text, voice=VOICE, speed=0.93, lang='en-us')
        x = dress(a, n); n += 1
        index.append(['%s#%d' % (kind, i), round(pos,3), round(len(x)/SR,3), kind]); parts += [x, gap]; pos += (len(x)+len(gap))/SR
        print(kind, i, round(len(x)/SR,1), flush=True)
pcm = np.concatenate(parts); wav = TMP + '/react.wav'
with wave.open(wav,'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(pcm,-1,1)*32767).astype(np.int16).tobytes())
subprocess.run(['ffmpeg','-v','error','-y','-i',wav,'-c:a','libopus','-b:a','32k','-application','audio','-ac','1',OUT+'/dj-claudefm-react.webm'],check=True)
subprocess.run(['ffmpeg','-v','error','-y','-i',wav,'-c:a','libmp3lame','-b:a','32k','-ar','22050','-ac','1',OUT+'/dj-claudefm-react.mp3'],check=True)
json.dump({'clips':index}, open(OUT+'/dj-claudefm-react.json','w'), separators=(',',':'))
print('total', round(pos,1), 's', len(index), 'clips')
