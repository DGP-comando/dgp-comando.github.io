#!/usr/bin/env node
/**
 * qa-estradas — liga as estradas municipais sobre Curitiba e confere que as
 * células carregam, que as urbanas respeitam o teto próprio de 30 km, que a
 * camada some acima de 90 km e que o botão de reset volta ao Paraná inteiro
 * com norte para cima e vista ortogonal. Salva screenshot.
 *
 * Cobre também o par que só existe junto com essa camada: o HUD desligado por
 * padrão e o botão "aproximar ao município selecionado", que precisa mostrar a
 * malha mesmo num município grande demais para caber abaixo do teto de altura.
 *
 * Uso: node scripts/qa-estradas.mjs [--url http://localhost:5173] [--shot out.png]
 * Requer dev server rodando.
 */
import {
  argValue, createReport, launchQaBrowser, openApp, setCamera, sleep, waitMapIdle, zoomGatedLayers,
} from './lib/qaBrowser.mjs';

const url = argValue('--url', process.env.QA_BASE_URL || 'http://localhost:5173');
const shot = argValue('--shot', 'qa-estradas.png');
const LAYER_ID = 'datageo-estradas';
// Só os layers da malha municipal (dg-estradas-0/1/outros), não os das conveniadas.
const MALHA = '^dg-estradas-(\\d+|outros)$';

const { check, finish } = createReport('qa-estradas');
const { browser, page, errors } = await launchQaBrowser({ viewport: { width: 1440, height: 860 } });

try {
  page.on('console', (m) => { if (/datageo-estradas/.test(m.text())) console.log('   console:', m.text()); });
  await openApp(page, url);

  // Antes de qualquer interação: é isto que o operador encontra ao abrir.
  // O HUD é construído sempre; quem liga e desliga é a classe `active` em
  // #intel-hud (IntelHUD.show/hide), espelhada no botão. Checar as DUAS é o
  // ponto: um botão aceso sobre um HUD escondido é a falha clássica de default.
  const primeiroFrame = await page.evaluate(() => ({
    hudAtivo: document.getElementById('intel-hud')?.classList.contains('active') ?? null,
    botaoAceso: document.getElementById('hud-toggle')?.classList.contains('active') ?? null,
    focoDesabilitado: document.getElementById('focus-municipio')?.disabled ?? null,
  }));
  check('HUD desligado por padrão, com o botão apagado',
    primeiroFrame.hudAtivo === false && primeiroFrame.botaoAceso === false, primeiroFrame);
  check('botão de foco começa desabilitado, sem município selecionado',
    primeiroFrame.focoDesabilitado === true, primeiroFrame);

  const setView = (alt) => setCamera(page, { lat: -25.45, lon: -49.27, alt });

  await setView(20_000);
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);

  const loaded = await page.evaluate(async (id) => {
    const mod = window.__godsEyeView.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 120_000) {
      const stats = mod?.getStats?.() ?? {};
      if (stats.count > 0) return { ms: Math.round(performance.now() - t0), count: stats.count, error: stats.error };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true, stats: mod?.getStats?.() };
  }, LAYER_ID);
  check('células carregadas em Curitiba', !loaded.timedOut && loaded.count > 5_000, loaded);

  const perto = await zoomGatedLayers(page, MALHA);
  check('a 20 km urbanas e rurais estão visíveis', perto.shown.length >= 2 && perto.gated.length === 0, perto);
  await waitMapIdle(page);
  await sleep(1_000);
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);

  await setView(60_000);
  await sleep(800);
  const medio = await zoomGatedLayers(page, MALHA);
  check('a 60 km as urbanas se escondem e as rurais ficam', medio.gated.length > 0 && medio.shown.length > 0, medio);

  await setView(400_000);
  await sleep(800);
  const longe = await zoomGatedLayers(page, MALHA);
  check('acima do teto a camada inteira fica oculta', longe.shown.length === 0 && longe.gated.length > 0, longe);

  // Foco num município GRANDE: Guarapuava (3.117 km²) só cabe na tela acima do
  // teto de 90 km das rurais, então é o caso que o botão precisa resolver.
  // Mesmo caminho da busca de município (ui.js): o dev server devolve a
  // instância do próprio app do módulo.
  await page.evaluate(async () => {
    const { openMunicipioFicha } = await import('/src/maplibre/layers/municipios.js');
    await openMunicipioFicha('4109401', 'Guarapuava');
  });
  await sleep(1_500);
  const habilitado = await page.evaluate(() => ({
    disabled: document.getElementById('focus-municipio')?.disabled,
    title: document.getElementById('focus-municipio')?.title,
  }));
  check('selecionar um município habilita o botão de foco',
    habilitado.disabled === false && /Guarapuava/.test(habilitado.title ?? ''), habilitado);

  await page.click('#focus-municipio');
  await sleep(7_000);
  const foco = await page.evaluate(() => ({ heightKm: Math.round(window.__godsEyeView.engine.getCameraView().alt / 1000) }));
  const noFoco = await zoomGatedLayers(page, MALHA);
  check('Guarapuava enquadrado fica ACIMA do teto de 90 km', foco.heightKm > 90, foco);
  check('mesmo assim as duas classes aparecem: o foco suspende os tetos',
    noFoco.shown.length >= 2 && noFoco.gated.length === 0, { ...foco, ...noFoco });

  // Sair da divisa desarma o foco sozinho: os tetos voltam a valer.
  await setView(120_000);
  await sleep(2_500);
  const foraDaDivisa = await zoomGatedLayers(page, MALHA);
  check('fora da divisa o foco se desarma e o teto volta a valer', foraDaDivisa.gated.length > 0, foraDaDivisa);

  // Reset: gira e inclina a câmera antes, para provar que o botão restaura
  // norte para cima e vista ortogonal, não só a altura.
  await setCamera(page, { lat: -25.45, lon: -49.27, alt: 15_000, heading: 120, pitch: -30 });
  await page.click('#reset-parana-view');
  await sleep(6_000);
  const reset = await page.evaluate(() => {
    const v = window.__godsEyeView.engine.getCameraView();
    return {
      heightKm: Math.round(v.alt / 1000),
      lat: +v.targetLat.toFixed(2),
      lon: +v.targetLon.toFixed(2),
      headingDeg: +(((v.heading % 360) + 360) % 360).toFixed(1),
      pitchDeg: +v.pitch.toFixed(1),
    };
  });
  const norteCima = reset.headingDeg < 0.5 || reset.headingDeg > 359.5;
  // O enquadramento é o bbox do PR (flyToBounds com folga): o centro fica em
  // torno de (-24.6, -51.3) e a altura depende do tamanho da janela.
  check('reset volta ao Paraná inteiro, norte para cima e ortogonal',
    reset.heightKm > 300 && reset.heightKm < 2_500 && norteCima && Math.abs(reset.pitchDeg + 90) < 1
      && Math.abs(reset.lat + 24.62) < 0.5 && Math.abs(reset.lon + 51.32) < 0.5,
    reset);

  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), LAYER_ID);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

finish();
