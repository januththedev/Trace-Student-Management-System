/** Real browser walkthrough producer. Inputs and recordings stay in the ignored output directory.
 * Requires an authenticated playwright-cli session on the isolated synthetic preview.
 * English narration uses Windows' installed Microsoft David voice; no cloud upload/API key.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TUTORIALS } from '../../src/app/staff/support/tutorials';

const root = path.resolve('output/playwright/support');
fs.mkdirSync(root, { recursive: true });
const npx = 'C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js';
function cli(args: string[]) {
  const r = spawnSync(process.execPath, [npx, '--yes', '--package', '@playwright/cli', 'playwright-cli', '-s=t2t-support', ...args], { encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 4_000_000 });
  const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  fs.appendFileSync(path.join(root, 'recording.log'), log);
  if (r.status !== 0 || /### Error/.test(log)) throw Error(`Browser operation failed: ${args[0]}. See recording.log`);
  const result = log.match(/### Result\r?\n([\s\S]*?)\r?\n### /);
  return result && /^[{[]/.test(result[1].trim()) ? JSON.parse(result[1]) : undefined;
}
const ids = process.argv.slice(2);
for (const guide of TUTORIALS.filter(g => !ids.length || ids.includes(g.id))) {
  try {
  const dir = path.join(root, guide.id); fs.mkdirSync(dir, { recursive: true });
  const actionFile = path.resolve(`scripts/support/actions/${guide.id}.inc`);
  if (!fs.existsSync(actionFile)) throw Error(`Missing real UI actions for ${guide.id}`);
  const manifest = guide.steps.map((text, i) => ({ text, path: path.join(dir, `voice-${i}.wav`) }));
  fs.writeFileSync(path.join(dir, 'narration.json'), JSON.stringify(manifest));
  const speech = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-File', path.resolve('scripts/support/narrate.ps1'), '-Manifest', path.join(dir, 'narration.json')], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (speech.status !== 0) throw Error(`Speech failed: ${speech.stderr}`);
  const seconds = manifest.map(({ path: p }) => {
    // Native speech WAVs have a RIFF header and a data chunk; duration comes from byte rate.
    const b = fs.readFileSync(p); let pos = 12, rate = 0, size = 0;
    while (pos + 8 <= b.length) { const key = b.toString('ascii', pos, pos + 4), length = b.readUInt32LE(pos + 4); if (key === 'fmt ') rate = b.readUInt32LE(pos + 16); if (key === 'data') size = length; pos += 8 + length + length % 2; }
    if (!rate || !size) throw Error('Invalid narration WAV'); return size / rate;
  });
  const code = `async page => {
    if (new URL(page.url()).origin !== 'http://localhost:3100') throw Error('Synthetic preview required');
    await page.setViewportSize({width:1280,height:720});
    const timeline=[];
    const demo=${fs.readFileSync(path.join(root,'demo-data.json'),'utf8')};
    let origin=Date.now();
    async function scene(index, action) {
      if(index===0) origin=Date.now();
      const text=${JSON.stringify(guide.steps)}[index];
      await page.evaluate(({text,title,index})=>{
        document.getElementById('tutorial-caption')?.remove();
        const e=document.createElement('div'); e.id='tutorial-caption'; e.setAttribute('role','note');
        e.style.cssText='position:fixed;z-index:2147483647;bottom:0;left:0;right:0;background:#122e35;color:white;padding:12px 26px 14px;font:16px/1.45 Arial;box-shadow:0 -2px 12px #0002;pointer-events:none';
        const h=document.createElement('div');h.style.cssText='color:#9be0dd;font-size:12px;margin-bottom:4px';h.textContent='T2T • DEMO DATA • '+title+' • STEP '+(index+1)+' OF 3';e.append(h,document.createTextNode(text));document.body.append(e);
      },{text,title:${JSON.stringify(guide.title)},index});
      const start=(Date.now()-origin)/1000;
      await action();
      const remaining=${JSON.stringify(seconds)}[index]+1-(Date.now()-origin)/1000+start;
      if(remaining>0) await page.waitForTimeout(remaining*1000);
      timeline.push({index,start,end:(Date.now()-origin)/1000});
    }
    const go=async url=>{await page.goto('http://localhost:3100'+url);await page.getByRole('main').waitFor();};
    const select=async(label,option)=>{await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();};
    const saved=async()=>{await page.getByText('Saved successfully.',{exact:true}).first().waitFor();};
    const date=async(label,day,index=0,month='November',year='2026')=>{
      await page.getByRole('button',{name:label,exact:true}).nth(index).click();
      await page.getByRole('combobox',{name:'Choose the Year',exact:true}).click();
      await page.getByRole('option',{name:year,exact:true}).click();
      await page.getByRole('combobox',{name:'Choose the Month',exact:true}).click();
      await page.getByRole('option',{name:month,exact:true}).click();
      await page.getByRole('button',{name:new RegExp(month+' '+day+'(?:th|st|nd|rd), '+year)}).click();
    };
    ${fs.readFileSync(actionFile,'utf8')}
    await page.evaluate(()=>document.getElementById('tutorial-caption')?.remove());
    return {timeline,seconds:${JSON.stringify(seconds)}};
  }`;
  const runtime = path.join(dir, 'browser.js'); fs.writeFileSync(runtime, code);
  // Prewarm the first task page before starting capture.
  cli(['goto', `http://localhost:3100${guide.href}`]);
  const video = path.join(dir, 'source.webm');
  fs.rmSync(path.join(dir, 'timings.json'), { force: true });
  cli(['video-start', video, '--size=1280x720', '--fps=12', '--cursor']);
  try {
    const timings = cli(['run-code', `--filename=${runtime}`]);
    if (!timings?.timeline?.length) throw Error('Missing recording timeline');
    fs.writeFileSync(path.join(dir, 'timings.json'), JSON.stringify(timings, null, 2));
  } finally { cli(['video-stop']); }
  console.log(`Recorded ${guide.id}`);
  } catch (error) { console.error(`${guide.id}: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
