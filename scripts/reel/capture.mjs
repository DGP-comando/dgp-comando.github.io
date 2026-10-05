#!/usr/bin/env node
/**
 * reel/capture — footage REAL do DataGeo PR para o demo reel.
 *
 * Abre o app no dev server (sem login: só camadas públicas), hides/mostra a
 * interface e grava clipes quadro a quadro (24 fps) com a câmera interpolada
 * deterministicamente, mais telas da interface (painel de camadas, busca,
 * ficha municipal, vigilância, atalhos). Cada clipe vira uma pasta de JPGs.
 *
 * Uso: node scripts/reel/capture.mjs [--url http://localhost:5173] [--out <pasta>] [--only clipeA,clipeB]
 */
import fs from 'node:fs';
import path from 'node:path';
import { argValue, launchQaBrowser, openApp, setCamera, setLayer, sleep, waitMapIdle } from '../lib/qaBrowser.mjs';

const url = argValue('--url', 'http://localhost:5173');
const OUT = argValue('--out', path.resolve('scripts/reel/footage'));
const only = argValue('--only', '')?.split(',').filter(Boolean);
const FPS = 24;
const IBGE = '4120606'; // Prudentópolis
fs.mkdirSync(OUT, { recursive: true });

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
const lerp = (a, b, k) => a + (b - a) * k;
const lerpLog = (a, b, k) => Math.exp(lerp(Math.log(a), Math.log(b), k));

const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1920, height: 1080 }, headful: false });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function shot(dir, i) {
  await page.screenshot({ path: path.join(dir, `f${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
}

/** Voo A→B em `sec` segundos; alt interpola em log. Grava um JPG por quadro. */
async function flight(name, from, to, sec, { pre = 0 } = {}) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const n = Math.round(sec * FPS);
  await setCamera(page, from);
  await waitMapIdle(page, 15_000);
  await sleep(pre);
  for (let i = 0; i < n; i++) {
    const k = ease(i / (n - 1));
    await setCamera(page, {
      lat: lerp(from.lat, to.lat, k),
      lon: lerp(from.lon, to.lon, k),
      alt: lerpLog(from.alt, to.alt, k),
      heading: lerp(from.heading ?? 0, to.heading ?? 0, k),
      pitch: lerp(from.pitch ?? -90, to.pitch ?? -90, k),
    });
    await waitMapIdle(page, 2500);
    await shot(dir, i);
  }
  log(name, n, 'quadros');
}

async function still(name, { frames = 1, settle = 1500 } = {}) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  await sleep(settle);
  await waitMapIdle(page, 10_000);
  for (let i = 0; i < frames; i++) {
    await shot(dir, i);
    if (frames > 1) await sleep(1000 / FPS);
  }
  log(name, frames, 'quadros (still)');
}

const layersOn = async (ids) => { for (const id of ids) await setLayer(page, id, true); await sleep(1500); await waitMapIdle(page, 20_000); };
const layersOff = async (ids) => { for (const id of ids) await setLayer(page, id, false); await sleep(400); };
// Visão limpa do app + o que ela deixa na tela e o reel não quer (botão de sair, vigilância, ticker). A atribuição do mapa fica.
const cleanView = (on) => page.evaluate((v) => {
  window.__godsEyeView.styleManager.toggleCleanView?.(v) ?? document.body.classList.toggle('ui-clean-view', v);
  let st = document.getElementById('reel-clean');
  if (!st) { st = document.createElement('style'); st.id = 'reel-clean'; document.head.append(st); }
  st.textContent = v ? '#clean-view-exit, #datageo-area-watch, #datageo-ticker, #toast, #scene-runtime { display: none !important; }' : '';
}, on);
const run = (name) => !only?.length || only.includes(name);

const PR = { lat: -24.7, lon: -51.6, alt: 900_000, heading: 0, pitch: -90 };
const GLOBO = { lat: -15, lon: -45, alt: 14_000_000, heading: 0, pitch: -90 };
const PRUD = { lat: -25.2, lon: -51.0, alt: 70_000, heading: 0, pitch: -90 };

try {
  await openApp(page, url);
  await sleep(2500);
  await page.evaluate(() => document.getElementById('first-run-launcher')?.remove());
  await cleanView(true);

  // A — do globo ao Paraná (municípios).
  if (run('A_globo_parana')) await flight('A_globo_parana', GLOBO, PR, 8);

  // B — a rede no território: regionais do IDR, unidades da ADAPAR, CEASAs.
  const REDE = ['datageo-regionais-idr', 'datageo-adapar-unidades', 'datageo-ceasas'];
  if (run('B_rede')) {
    await layersOn(REDE);
    await flight('B_rede', { ...PR, alt: 950_000, heading: -4 }, { ...PR, alt: 780_000, heading: 4, lat: -24.9 }, 6);
    await layersOff(REDE);
  }

  // C — logística: rodovias, ferrovias, armazéns, CEASAs, transmissão.
  const LOG = ['datageo-rodovias', 'datageo-ferrovias', 'datageo-armazens', 'datageo-ceasas', 'datageo-transmissao'];
  if (run('C_logistica')) {
    await layersOn(LOG);
    await flight('C_logistica', { lat: -24.2, lon: -52.6, alt: 620_000, heading: 0, pitch: -90 }, { lat: -25.3, lon: -50.2, alt: 520_000, heading: 0, pitch: -90 }, 6);
    await layersOff(LOG);
  }

  // I — territórios e povos: terras indígenas, quilombolas, assentamentos, faxinais, UCs.
  const TERR = ['datageo-terras-indigenas', 'datageo-quilombolas', 'datageo-assentamentos', 'datageo-faxinais-territorios', 'datageo-ucs-federais', 'datageo-ucs-estaduais'];
  if (run('I_territorios')) {
    await layersOn(TERR);
    await flight('I_territorios', { ...PR, alt: 900_000 }, { ...PR, alt: 700_000, lon: -51.9 }, 5);
    await layersOff(TERR);
  }

  // J — energia e conectividade: distribuição + subestações + usinas, descendo sobre Curitiba.
  const ENE = ['datageo-transmissao', 'datageo-distribuicao', 'datageo-subestacoes', 'datageo-geracao'];
  if (run('J_energia')) {
    await layersOn(ENE);
    await flight('J_energia', { lat: -25.45, lon: -49.3, alt: 400_000, heading: 0, pitch: -90 }, { lat: -25.45, lon: -49.3, alt: 60_000, heading: 0, pitch: -90 }, 5);
    await layersOff(ENE);
  }

  // F — pesquisa de localização: do Paraná a Prudentópolis com CAR, estradas, rodovias.
  const MUN = ['datageo-rodovias', 'datageo-estradas', 'datageo-estradas-conveniadas', 'datageo-car'];
  if (run('F_prudentopolis')) {
    await layersOn(MUN);
    await flight('F_prudentopolis', PR, { ...PRUD, alt: 60_000 }, 8);
  }

  // H — ambiente de perto: faxinais, UCs, clima histórico, outorgas (IAT ao vivo), com giro.
  const AMB = ['datageo-faxinais', 'datageo-faxinais-territorios', 'datageo-ucs-estaduais', 'datageo-outorgas'];
  if (run('H_ambiente')) {
    await layersOff(MUN);
    await layersOn(AMB);
    await flight('H_ambiente', { ...PRUD, alt: 90_000, heading: -10, pitch: -72 }, { ...PRUD, alt: 75_000, heading: 14, pitch: -66 }, 6);
    await layersOff(AMB);
  }

  // K — estilos visuais 1–7 sobre o Paraná (normal, retro/CRT, surveillance/NVG, thermal/FLIR, anime, noir, snow).
  if (run('K_estilos')) {
    await layersOn(['datageo-regionais-idr']);
    const dir = path.join(OUT, 'K_estilos');
    fs.mkdirSync(dir, { recursive: true });
    let i = 0;
    for (const s of ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow']) {
      await page.evaluate((st) => window.__godsEyeView.styleManager.setStyle(st), s);
      await sleep(1200);
      for (let f = 0; f < 16; f++) {
        await setCamera(page, { ...PR, alt: 900_000 - i * 400, heading: i * 0.03 });
        await waitMapIdle(page, 1500);
        await shot(dir, i++);
      }
    }
    await page.evaluate(() => window.__godsEyeView.styleManager.setStyle('normal'));
    await layersOff(['datageo-regionais-idr']);
    log('K_estilos', i, 'quadros');
  }

  // ---- telas da interface (visão normal) ----
  await cleanView(false);
  await setCamera(page, PR);
  await waitMapIdle(page, 10_000);

  // D — painel de camadas aberto, modo grupos.
  if (run('D_painel')) {
    await page.evaluate(() => {
      const panel = document.getElementById('data-panel');
      panel.classList.add('active');
      if (panel.classList.contains('collapsed')) panel.querySelector('.panel-collapse-btn[data-collapse-target="data-panel"]')?.click();
      window.__godsEyeView.dataManager.setPanelView('grupos');
    });
    await still('D_painel');
    await page.evaluate(() => window.__godsEyeView.dataManager.setPanelView('grade'));
    await still('D_painel_grade', { settle: 800 });
    await page.evaluate(() => window.__godsEyeView.dataManager.setPanelView('grupos'));
  }

  // E — busca com sugestões ("Prud").
  if (run('E_busca')) {
    await page.evaluate(() => {
      const input = document.getElementById('location-search');
      if (!input.classList.contains('expanded')) document.getElementById('search-toggle')?.click();
      input.focus();
      input.value = 'Prud';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await still('E_busca', { settle: 1200 });
  }

  // G — ficha municipal de Prudentópolis aberta, município enquadrado com CAR e estradas.
  if (run('G_ficha')) {
    await layersOn(MUN);
    await page.evaluate((ibge) => window.__godsEyeView.styleManager.flyToMunicipioIbge(ibge), IBGE);
    await sleep(6000);
    await still('G_ficha', { settle: 2000 });
    await page.evaluate(() => window.__godsEyeView.styleManager.focusSelectedMunicipio());
    await sleep(4000);
    await still('G_ficha_foco', { settle: 1500 });
  }

  // L — vigilância com o município vigiado.
  if (run('L_vigilancia')) {
    await page.evaluate((ibge) => { window.__dgpAreaWatch.watchMunicipio(ibge, 'Prudentópolis'); window.__dgpAreaWatch.open(); }, IBGE);
    await still('L_vigilancia', { settle: 1500 });
    await page.evaluate(() => window.__dgpAreaWatch.close());
  }

  // M — atalhos de teclado (tecla ?).
  if (run('M_atalhos')) {
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('?');
    await still('M_atalhos', { settle: 800 });
    await page.keyboard.press('Escape');
  }

  log('erros de página:', errors.filter((e) => !/401|403|privado|HTTP 4|acesso restrito|LOAD FAILED|could not start/i.test(e)).slice(0, 5));
} finally {
  await browser.close();
}
