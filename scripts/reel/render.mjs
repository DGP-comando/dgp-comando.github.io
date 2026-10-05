#!/usr/bin/env node
/**
 * reel/render — renderiza composition.html quadro a quadro (24 fps, 1920x1080)
 * com Puppeteer e codifica em MP4 (H.264, yuv420p) com ffmpeg, com uma trilha
 * ambiente sintetizada pelo próprio ffmpeg (sem material de terceiros).
 *
 * Uso: node scripts/reel/render.mjs --dir <pasta com composition.html e footage/> --out <arquivo.mp4> [--from 0 --to 180] [--preview]
 *   [--html composition-en.html --frames frames-en --frames-only]  (outra composição; só os quadros, áudio/encode à parte)
 *   --preview grava só um quadro a cada 3 s em <dir>/preview/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { argValue, hasFlag, launchQaBrowser } from '../lib/qaBrowser.mjs';

const dir = path.resolve(argValue('--dir', 'scripts/reel'));
const out = path.resolve(argValue('--out', path.join(dir, 'datageo-pr-demo.mp4')));
const FPS = 24;
const T0 = Number(argValue('--from', 0));
const T1 = Number(argValue('--to', 180));
const preview = hasFlag('--preview');
const html = argValue('--html', 'composition.html');
const framesOnly = hasFlag('--frames-only');
const framesDir = path.join(dir, preview ? 'preview' : argValue('--frames', 'frames'));
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const { browser, page } = await launchQaBrowser({ viewport: { width: 1920, height: 1080 }, headful: false });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
try {
  await page.goto(pathToFileURL(path.join(dir, html)).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  // aquece: decodifica o primeiro quadro de cada clipe
  await page.evaluate(async () => { for (let t = 0; t < 180; t += 6) await window.__seek(t); });

  const step = preview ? 3 : 1 / FPS;
  const total = Math.round((T1 - T0) / step);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const t = T0 + i * step;
    await page.evaluate((tt) => window.__seek(tt), t);
    await page.screenshot({ path: path.join(framesDir, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 93 });
    if (i % 240 === 0) log(`quadro ${i}/${total} (t=${t.toFixed(1)}s)`, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  log('quadros prontos');
} finally {
  await browser.close();
}
if (preview || framesOnly) process.exit(0);

// trilha ambiente: dois drones detunados com batimento lento + "respiração" de ruído filtrado + pulso surdo a cada 4 s; sobe e desce com o vídeo.
const dur = T1 - T0;
const audio = path.join(dir, 'ambiente.wav');
const af = [
  `aevalsrc=exprs='0.11*sin(2*PI*55*t)*(0.75+0.25*sin(2*PI*0.07*t))+0.07*sin(2*PI*82.5*t+0.3)*(0.7+0.3*sin(2*PI*0.05*t+1))+0.035*sin(2*PI*110.4*t)|0.11*sin(2*PI*55.3*t)*(0.75+0.25*sin(2*PI*0.06*t+2))+0.07*sin(2*PI*82.3*t)*(0.7+0.3*sin(2*PI*0.045*t))+0.035*sin(2*PI*109.8*t+1)':s=48000:d=${dur}[drone]`,
  `anoisesrc=color=brown:amplitude=0.05:d=${dur}:s=48000,lowpass=f=320,tremolo=f=0.11:d=0.8,volume=0.5[ar]`,
  `aevalsrc=exprs='0.16*sin(2*PI*48*t)*exp(-6*mod(t\\,4))':s=48000:d=${dur}[pulso]`,
  `[drone][ar][pulso]amix=inputs=3:normalize=0,afade=t=in:d=3,afade=t=out:st=${dur - 4}:d=4,alimiter=limit=0.8[out]`,
].join(';');
let r = spawnSync('ffmpeg', ['-y', '-filter_complex', af, '-map', '[out]', audio], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('ffmpeg áudio falhou');

r = spawnSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f%05d.jpg'), '-i', audio,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
  '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('ffmpeg vídeo falhou');
log('MP4:', out, `${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
