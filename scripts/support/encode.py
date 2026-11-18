"""Encode recorded UI at 720p/12 fps with local English speech and seekable MP4.
No student data or external services are accessed. Raw recordings remain ignored.
"""
import json, re, subprocess, sys
from pathlib import Path
import imageio_ffmpeg

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
root = Path('output/playwright/support')
public = Path('public/support/videos'); public.mkdir(parents=True, exist_ok=True)
media_path = Path('src/app/staff/support/tutorial-media.json')
media = json.loads(media_path.read_text())

def stamp(t):
    n = round(t * 1000)
    return f'{n//3600000:02d}:{n//60000%60:02d}:{n//1000%60:02d}.{n%1000:03d}'

for name in sys.argv[1:]:
    folder = root / name
    timing = json.loads((folder/'timings.json').read_text())
    lead = timing['timeline'][0]['start']
    for scene in timing['timeline']:
        scene['start'] -= lead
        scene['end'] -= lead
    narration = json.loads((folder/'narration.json').read_text())
    # Find the first frame of our dark-teal on-screen teaching caption, eliminating CLI lead-in.
    r = subprocess.run([ffmpeg,'-v','error','-i',str(folder/'source.webm'),'-t','25','-vf','fps=12,crop=8:8:1200:704','-f','rawvideo','-pix_fmt','rgb24','-'],capture_output=True,check=True)
    frames = [r.stdout[i:i+192] for i in range(0,len(r.stdout),192)]
    offset = None
    for i,frame in enumerate(frames):
        if len(frame)==192 and sum(abs(frame[j] - (18,46,53)[j%3]) for j in range(192))/192 < 5:
            offset = i/12; break
    if offset is None: raise RuntimeError(f'{name}: no teaching caption detected')
    end = timing['timeline'][-1]['end']
    args = [ffmpeg,'-y','-v','error','-ss',str(offset),'-i',str(folder/'source.webm')]
    for i in range(3): args += ['-i',str(folder/f'voice-{i}.wav')]
    filters = []
    for i,item in enumerate(timing['timeline']):
        filters.append(f'[{i+1}:a]adelay={round(item["start"]*1000)}:all=1[a{i}]')
    filters.append('[a0][a1][a2]amix=inputs=3:normalize=0,alimiter=limit=0.95[audio]')
    target = public/f'{name}.mp4'
    args += ['-filter_complex',';'.join(filters),'-map','0:v','-map','[audio]','-t',str(end),'-vf','scale=1280:720,format=yuv420p','-r','12','-c:v','libx264','-preset','slow','-crf','31','-c:a','aac','-ac','1','-b:a','32k','-movflags','+faststart',str(target)]
    subprocess.run(args,check=True)
    subprocess.run([ffmpeg,'-y','-v','error','-ss','2','-i',str(target),'-frames:v','1','-vf','scale=640:360','-update','1',str(public/f'{name}.jpg')],check=True)
    captions = ['WEBVTT','']
    for i,item in enumerate(timing['timeline']):
        sentences = re.split(r'(?<=[.!?])\s+',narration[i]['text'])
        count = sum(len(s.split()) for s in sentences)
        t = item['start']
        for sentence in sentences:
            span = timing['seconds'][i] * len(sentence.split()) / count
            captions += [f'{stamp(t)} --> {stamp(t+span)} line:8%',sentence,'']
            t += span
    (public/f'{name}.vtt').write_text('\n'.join(captions),encoding='utf8')
    size = target.stat().st_size
    if size>4_000_000: raise RuntimeError(f'{name}: clip exceeds 4 MB budget')
    media[name] = dict(src=f'/support/videos/{name}.mp4',captions=f'/support/videos/{name}.vtt',poster=f'/support/videos/{name}.jpg',duration=round(end,1),bytes=size)
    print(f'{name}: {end:.1f}s, {size/1e6:.2f} MB, trimmed {offset:.2f}s')
media_path.write_text(json.dumps(media,indent=2)+'\n')
