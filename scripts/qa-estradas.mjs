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
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const url = arg('--url', 'http://localhost:5173');
const shot = arg('--shot', 'qa-estradas.png');
const LAYER_ID = 'datageo-estradas';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: ['--no-sandbox', '--window-size=1440,900', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (/datageo-estradas/.test(m.text())) console.log('   console:', m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await sleep(10_000);

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

  const setView = (height) => page.evaluate((h) => {
    const v = window.__godsEyeView.viewer;
    v.camera.cancelFlight();
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: -49.27 * Math.PI / 180, latitude: -25.45 * Math.PI / 180, height: h,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }, height);

  // Conta os primitives VISÍVEIS da coleção da camada, por profundidade: só a
  // raiz das estradas guarda COLEÇÕES (uma por célula), e cada célula guarda um
  // primitive por classe. Um primitive é reconhecido por NÃO ser coleção:
  // `geometryInstances` não serve, porque o Cesium libera as instâncias assim
  // que o primitive fica pronto e o getter passa a devolver undefined.
  const visibleGroups = () => page.evaluate(() => {
    const gp = window.__godsEyeView.viewer.scene.groundPrimitives;
    const isCollection = (x) => !!x && typeof x.get === 'function' && typeof x.length === 'number';
    let cells = 0; let shown = 0; let hidden = 0;
    for (let i = 0; i < gp.length; i++) {
      const root = gp.get(i);
      if (!root?.show || !isCollection(root)) continue;
      for (let j = 0; j < root.length; j++) {
        const cell = root.get(j);
        if (!isCollection(cell)) continue;
        cells++;
        for (let k = 0; k < cell.length; k++) {
          const p = cell.get(k);
          if (!p || isCollection(p)) continue;
          if (p.show) shown++; else hidden++;
        }
      }
    }
    return { cells, shown, hidden };
  });

  await setView(20_000);
  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, true, { origin: 'user' }), LAYER_ID);

  const loaded = await page.evaluate(async (id) => {
    const gev = window.__godsEyeView;
    const mod = gev.dataManager.layers.get(id)?.module;
    const t0 = performance.now();
    while (performance.now() - t0 < 120_000) {
      const stats = mod?.getStats?.() ?? {};
      if (stats.count > 0) {
        return { ms: Math.round(performance.now() - t0), count: stats.count, error: stats.error };
      }
      gev.viewer.scene.requestRender?.();
      await new Promise((r) => setTimeout(r, 250));
    }
    return { timedOut: true, stats: mod?.getStats?.() };
  }, LAYER_ID);
  check('células carregadas em Curitiba', !loaded.timedOut && loaded.count > 5_000, loaded);

  const perto = await visibleGroups();
  check('a 20 km urbanas e rurais estão visíveis', perto.shown > 0 && perto.hidden === 0, perto);
  await sleep(2_000);
  await page.screenshot({ path: shot });
  console.log('   screenshot:', shot);

  await setView(60_000);
  await sleep(1_500);
  const medio = await visibleGroups();
  check('a 60 km as urbanas se escondem e as rurais ficam', medio.hidden > 0 && medio.shown > 0, medio);

  await setView(400_000);
  await sleep(1_500);
  const longe = await page.evaluate(() => {
    const gp = window.__godsEyeView.viewer.scene.groundPrimitives;
    const shows = [];
    for (let i = 0; i < gp.length; i++) shows.push(gp.get(i).show);
    return shows;
  });
  check('acima do teto a coleção inteira fica oculta', longe.includes(false), longe);

  // Foco num município GRANDE: Guarapuava (3.117 km²) só cabe na tela acima do
  // teto de 90 km das rurais, então é o caso que o botão precisa resolver.
  await page.evaluate(() => window.__godsEyeView.dataManager.layers
    .get('datageo-municipios')?.module?.openMunicipioFicha({ ibge: '4109401', nome: 'Guarapuava' }));
  await sleep(1_500);
  const habilitado = await page.evaluate(() => ({
    disabled: document.getElementById('focus-municipio')?.disabled,
    title: document.getElementById('focus-municipio')?.title,
  }));
  check('selecionar um município habilita o botão de foco',
    habilitado.disabled === false && /Guarapuava/.test(habilitado.title ?? ''), habilitado);

  await page.click('#focus-municipio');
  await sleep(7_000);
  const foco = await page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera;
    return { heightKm: Math.round(c.positionCartographic.height / 1000) };
  });
  const noFoco = await visibleGroups();
  check('Guarapuava enquadrado fica ACIMA do teto de 90 km',
    foco.heightKm > 90, foco);
  check('mesmo assim as duas classes aparecem: o foco suspende os tetos',
    noFoco.shown > 0 && noFoco.hidden === 0, { ...foco, ...noFoco });

  // Sair da divisa desarma o foco sozinho: os tetos voltam a valer.
  await setView(120_000);
  await sleep(2_500);
  const foraDaDivisa = await page.evaluate(() => {
    const gp = window.__godsEyeView.viewer.scene.groundPrimitives;
    const shows = [];
    for (let i = 0; i < gp.length; i++) shows.push(gp.get(i).show);
    return shows;
  });
  check('fora da divisa o foco se desarma e o teto volta a valer',
    foraDaDivisa.includes(false), foraDaDivisa);

  // Reset: gira e inclina a câmera antes, para provar que o botão restaura
  // norte para cima e vista ortogonal, não só a altura.
  await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    v.camera.setView({
      destination: v.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: -49.27 * Math.PI / 180, latitude: -25.45 * Math.PI / 180, height: 15_000,
      }),
      orientation: { heading: 2.1, pitch: -0.5, roll: 0 },
    });
  });
  await page.click('#reset-parana-view');
  await sleep(6_000);
  const reset = await page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera;
    const carto = c.positionCartographic;
    return {
      heightKm: Math.round(carto.height / 1000),
      lat: +(carto.latitude * 180 / Math.PI).toFixed(2),
      lon: +(carto.longitude * 180 / Math.PI).toFixed(2),
      headingDeg: +(c.heading * 180 / Math.PI).toFixed(1),
      pitchDeg: +(c.pitch * 180 / Math.PI).toFixed(1),
    };
  });
  const norteCima = reset.headingDeg < 0.5 || reset.headingDeg > 359.5;
  check('reset volta ao Paraná inteiro, norte para cima e ortogonal',
    Math.abs(reset.heightKm - 900) < 20 && norteCima && Math.abs(reset.pitchDeg + 90) < 1
      && Math.abs(reset.lat + 24.7) < 0.2 && Math.abs(reset.lon + 51.6) < 0.2,
    reset);

  await page.evaluate((id) => window.__godsEyeView.dataManager.setEnabled(id, false, { origin: 'user' }), LAYER_ID);
  check('sem erros de página', errors.length === 0, errors.slice(0, 3));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-estradas: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
