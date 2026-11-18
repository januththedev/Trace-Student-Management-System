import fs from 'node:fs';
import path from 'node:path';

const catalog = fs.readFileSync('src/app/staff/support/tutorials.ts', 'utf8');
const ids = [...catalog.matchAll(/task\("([a-z-]+)"/g)].map(m => m[1]);
const media = JSON.parse(fs.readFileSync('src/app/staff/support/tutorial-media.json', 'utf8'));
const errors = [];
let total = 0;
for (const id of ids) {
  const clip = media[id];
  if (!clip) { errors.push(`${id}: missing recorded walkthrough`); continue; }
  for (const [key, extension] of [['src', '.mp4'], ['captions', '.vtt'], ['poster', '.jpg']]) {
    const expected = `/support/videos/${id}${extension}`;
    if (clip[key] !== expected) { errors.push(`${id}: unexpected ${key} path`); continue; }
    const file = path.join('public', expected);
    if (!fs.existsSync(file)) { errors.push(`${id}: ${key} file missing`); continue; }
    const bytes = fs.readFileSync(file);
    if (key === 'src') {
      if (bytes.toString('ascii', 4, 8) !== 'ftyp') errors.push(`${id}: invalid MP4 header`);
      if (clip.bytes !== bytes.length || bytes.length > 4_000_000) errors.push(`${id}: video exceeds budget or stale size`);
      if (!(clip.duration > 5 && clip.duration <= 240)) errors.push(`${id}: invalid duration`);
      total += bytes.length;
    }
    if (key === 'captions') {
      const text = bytes.toString('utf8').replaceAll('\r\n', '\n');
      if (!text.startsWith('WEBVTT\n') || !text.includes(' --> ')) errors.push(`${id}: captions missing`);
      const time = value => value.split(':').reduce((a, n) => a * 60 + Number(n), 0);
      let previousEnd = 0;
      for (const match of text.matchAll(/(\d\d:\d\d:\d\d\.\d{3}) --> (\d\d:\d\d:\d\d\.\d{3})/g)) {
        const start = time(match[1]), end = time(match[2]);
        if (start < previousEnd - .01 || end <= start || end > clip.duration + .2) errors.push(`${id}: caption timing invalid`);
        previousEnd = end;
      }
    }
    if (key === 'poster' && bytes.readUInt16BE(0) !== 0xffd8) errors.push(`${id}: invalid poster`);
  }
}
for (const id of Object.keys(media)) if (!ids.includes(id)) errors.push(`${id}: orphan media entry`);
if (total > 35_000_000) errors.push('Walkthrough library exceeds 35 MB total budget');
if (errors.length) throw Error(errors.join('\n'));
console.log(`Support media: ${ids.length} recorded English walkthroughs, ${(total / 1_000_000).toFixed(2)} MB total; files, captions and budgets verified.`);
