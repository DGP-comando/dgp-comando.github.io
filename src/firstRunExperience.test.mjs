import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EXCLUSIVE_SURFACE_CLASSES,
  FIRST_RUN_SESSION_KEY,
  FIRST_RUN_STORAGE_KEY,
  FIRST_RUN_TOUR_STEPS,
  exclusiveSurfaceActive,
  rememberFirstRunSessionDismissed,
  setFirstRunSuppressed,
  shouldShowFirstRun,
  tourNavState,
} from './firstRunExperience.js';

const readModule = () => fs.readFileSync(new URL('./firstRunExperience.js', import.meta.url), 'utf8');
const readHtml = () => fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const readCss = () => fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');

function memoryStorage(key, value = null) {
  const values = new Map(value == null ? [] : [[key, value]]);
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, next) => values.set(name, next),
    removeItem: (name) => values.delete(name),
    read: () => values.get(key) ?? null,
  };
}

const fresh = () => ({
  storage: memoryStorage(FIRST_RUN_STORAGE_KEY),
  sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY),
  location: { search: '' },
});

// ── Política de exibição ─────────────────────────────────────────────────────

test('as chaves são do tutorial, não do antigo card de missões', () => {
  assert.equal(FIRST_RUN_STORAGE_KEY, 'gev:first-run-tour:v1');
  assert.equal(FIRST_RUN_SESSION_KEY, 'gev:first-run-tour-session:v1');
  // Quem suprimiu o card de missões ainda não viu o tutorial.
  assert.equal(shouldShowFirstRun({
    storage: memoryStorage('gev:first-run-mission:v1', 'suppressed'),
    sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY),
    location: { search: '' },
  }), true);
});

test('sessão nova recebe o tutorial, e continua recebendo', () => {
  assert.equal(shouldShowFirstRun(fresh()), true);
  const returning = fresh();
  returning.sessionStorageRef = memoryStorage(FIRST_RUN_SESSION_KEY);
  assert.equal(shouldShowFirstRun(returning), true);
});

test('fechar vale só para a sessão; só a caixa suprime de forma durável', () => {
  const session = memoryStorage(FIRST_RUN_SESSION_KEY);
  const storage = memoryStorage(FIRST_RUN_STORAGE_KEY);
  rememberFirstRunSessionDismissed(session);
  assert.equal(session.read(), 'dismissed');
  assert.equal(shouldShowFirstRun({ storage, sessionStorageRef: session, location: { search: '' } }), false);
  assert.equal(shouldShowFirstRun({
    storage,
    sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY),
    location: { search: '' },
  }), true);
  assert.equal(storage.read(), null);
});

test('a caixa grava e limpa a supressão durável', () => {
  const storage = memoryStorage(FIRST_RUN_STORAGE_KEY);
  assert.equal(setFirstRunSuppressed(true, storage), true);
  assert.equal(storage.read(), 'suppressed');
  assert.equal(shouldShowFirstRun({
    storage, sessionStorageRef: memoryStorage(FIRST_RUN_SESSION_KEY), location: { search: '' },
  }), false);
  assert.equal(setFirstRunSuppressed(false, storage), true);
  assert.equal(storage.read(), null);
});

test('?welcome funciona nos dois sentidos e o link compartilhado vence tudo', () => {
  const suppressed = memoryStorage(FIRST_RUN_STORAGE_KEY, 'suppressed');
  const dismissed = memoryStorage(FIRST_RUN_SESSION_KEY, 'dismissed');
  assert.equal(shouldShowFirstRun({
    storage: suppressed, sessionStorageRef: dismissed, location: { search: '?welcome=1' },
  }), true);
  assert.equal(shouldShowFirstRun({ ...fresh(), location: { search: '?welcome=0' } }), false);
  assert.equal(shouldShowFirstRun({ hasShareState: true, ...fresh(), location: { search: '?welcome=1' } }), false);
  assert.equal(shouldShowFirstRun({ hasShareState: true, ...fresh() }), false);
});

test('armazenamento bloqueado falha aberto e a escrita recusada é reportada', () => {
  const blocked = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.equal(shouldShowFirstRun({ storage: blocked, sessionStorageRef: blocked }), true);
  assert.equal(setFirstRunSuppressed(true, blocked), false);
  assert.equal(setFirstRunSuppressed(false, null), false);
  assert.doesNotThrow(() => rememberFirstRunSessionDismissed(blocked));
  const handler = readModule().slice(
    readModule().indexOf('const onSuppressChange = (event) => {'),
    readModule().indexOf('function onKeyDown(event) {'),
  );
  assert.match(handler, /if \(setFirstRunSuppressed\(wanted, storage\)\) return;/);
  assert.match(handler, /box\.checked = !wanted;/, 'escrita recusada devolve a marca');
});

test('getter de storage que LANÇA ainda falha aberto (Safari privado)', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const savedSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const hostile = { configurable: true, get() { throw new Error('SecurityError'); } };
  Object.defineProperty(globalThis, 'localStorage', hostile);
  Object.defineProperty(globalThis, 'sessionStorage', hostile);
  try {
    assert.equal(shouldShowFirstRun({ location: { search: '' } }), true);
    assert.doesNotThrow(() => setFirstRunSuppressed(true));
    assert.doesNotThrow(() => rememberFirstRunSessionDismissed());
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
    if (savedSession) Object.defineProperty(globalThis, 'sessionStorage', savedSession);
    else delete globalThis.sessionStorage;
  }
  const code = readModule().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /=\s*globalThis\.(local|session)Storage/);
  assert.equal([...code.matchAll(/globalThis\.(local|session)Storage/g)].length, 2);
});

// ── Passos e navegação ───────────────────────────────────────────────────────

test('ordem dos passos: início, camadas, localização e, por último e discreto, preferências', () => {
  assert.deepEqual(FIRST_RUN_TOUR_STEPS.map((s) => s.id), ['inicio', 'camadas', 'localizacao', 'preferencias']);
  assert.deepEqual(FIRST_RUN_TOUR_STEPS[1].targets, ['#data-panel']);
  assert.deepEqual(FIRST_RUN_TOUR_STEPS[2].targets, ['#location-bar']);
  assert.equal(FIRST_RUN_TOUR_STEPS.at(-1).minor, true);
  assert.equal(FIRST_RUN_TOUR_STEPS.filter((s) => s.minor).length, 1, 'só o último passo tem menor ênfase');
});

test('tourNavState limita o índice e rotula os botões', () => {
  assert.deepEqual(tourNavState(0, 4), { index: 0, canBack: false, isLast: false, counter: '1 / 4', nextLabel: 'Começar' });
  assert.deepEqual(tourNavState(1, 4), { index: 1, canBack: true, isLast: false, counter: '2 / 4', nextLabel: 'Próximo' });
  assert.deepEqual(tourNavState(3, 4), { index: 3, canBack: true, isLast: true, counter: '4 / 4', nextLabel: 'Concluir' });
  assert.equal(tourNavState(-5, 4).index, 0);
  assert.equal(tourNavState(99, 4).index, 3);
  assert.equal(tourNavState(Number.NaN).index, 0);
  assert.equal(tourNavState(2).counter, `3 / ${FIRST_RUN_TOUR_STEPS.length}`);
});

test('o tutorial não liga camada nem grava preferência de exibição', () => {
  const code = readModule();
  for (const forbidden of ['setEnabled', 'setContextMode', 'setPanelCollapsed', '_setDetection', '_setModels3d']) {
    assert.ok(!code.includes(forbidden), `o tutorial não pode chamar ${forbidden}`);
  }
  assert.doesNotMatch(readHtml(), /data-first-run-choice=/, 'nada do card de missões pode sobrar');
});

// ── Markup ───────────────────────────────────────────────────────────────────

test('markup: um section por passo, na mesma ordem, com alvos que existem na página', () => {
  const html = readHtml();
  assert.match(html, /id="first-run-launcher" role="dialog"[^>]*hidden/);
  const order = [...html.matchAll(/data-tour-step="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, FIRST_RUN_TOUR_STEPS.map((s) => s.id));
  for (const step of FIRST_RUN_TOUR_STEPS) {
    for (const selector of step.targets) {
      assert.match(html, new RegExp(`id="${selector.slice(1)}"`), `${selector} precisa existir no index.html`);
    }
    const section = html.slice(html.indexOf(`data-tour-step="${step.id}"`));
    const heading = section.slice(section.indexOf('<h2'), section.indexOf('</h2>'));
    assert.match(heading, /id="tour-title-/, `${step.id} sem título com id`);
  }
  // Só o primeiro passo nasce visível.
  assert.doesNotMatch(html.slice(html.indexOf('data-tour-step="inicio"'), html.indexOf('>', html.indexOf('data-tour-step="inicio"'))), /hidden/);
  for (const id of ['camadas', 'localizacao', 'preferencias']) {
    const tag = html.slice(html.indexOf(`data-tour-step="${id}"`), html.indexOf('>', html.indexOf(`data-tour-step="${id}"`)));
    assert.match(tag, /hidden/, `${id} deve nascer oculto`);
  }
  assert.equal((html.match(/data-tour-action=/g) || []).length, 2);
  assert.match(html, /data-tour-action="layers"/);
  assert.match(html, /data-tour-action="search"/);
  assert.match(html, /<input type="checkbox" data-first-run-suppress \/>/);
  assert.match(html, /data-first-run-status[^>]*role="status"[^>]*aria-live="polite"/);
  assert.equal((html.match(/class="tour-dots"[^>]*>(<span><\/span>){4}</g) || []).length, 1, 'um ponto por passo');
});

test('texto dos passos de destaque cita os atalhos e rótulos reais da interface', () => {
  const html = readHtml();
  const camadas = html.slice(html.indexOf('data-tour-step="camadas"'), html.indexOf('data-tour-step="localizacao"'));
  assert.match(camadas, /CAMADAS DE DADOS/);
  assert.match(camadas, /<kbd>L<\/kbd>/);
  const manager = fs.readFileSync(new URL('./data/manager.js', import.meta.url), 'utf8');
  const categorias = manager.slice(manager.indexOf('LAYER_CATEGORY_ORDER'), manager.indexOf(']);', manager.indexOf('LAYER_CATEGORY_ORDER')));
  for (const [, nome] of categorias.matchAll(/'([^']+)'/g)) {
    if (nome === 'Contexto global') continue;
    assert.ok(camadas.includes(nome), `categoria ${nome} ausente do passo de camadas`);
  }
  const loc = html.slice(html.indexOf('data-tour-step="localizacao"'), html.indexOf('data-tour-step="preferencias"'));
  assert.match(loc, /LOCALIZAÇÃO/);
  assert.match(loc, /<kbd>B<\/kbd>/);
  assert.match(loc, /<kbd>P<\/kbd>/);
  const keymap = fs.readFileSync(new URL('./data/shortcutsKeymap.js', import.meta.url), 'utf8');
  for (const [key, action] of [['L', 'toggleLayers'], ['B', 'openSearch'], ['P', 'resetCamera'], ['A', 'toggleWatch'], ['M', 'toggleFullscreen']]) {
    assert.match(keymap, new RegExp(`key: '${key}', action: '${action}'`));
  }
});

// ── Arbitragem de ESC e visibilidade ─────────────────────────────────────────

test('as listas JS e CSS de superfícies que tomam a tela andam juntas', () => {
  const css = readCss();
  assert.deepEqual([...EXCLUSIVE_SURFACE_CLASSES].sort(),
    ['cockpit-mode', 'recording-mode', 'scene-playback-mode', 'ui-clean-view']);
  const hideRule = css.slice(
    css.indexOf('body.ui-clean-view #first-run-launcher'),
    css.indexOf('display: none', css.indexOf('body.ui-clean-view #first-run-launcher')),
  );
  const inCss = [...hideRule.matchAll(/body\.([a-z-]+) #first-run-launcher/g)].map((m) => m[1]);
  assert.deepEqual(inCss.sort(), [...EXCLUSIVE_SURFACE_CLASSES].sort());
});

test('exclusiveSurfaceActive lê as classes vivas do body', () => {
  const make = (classes) => ({ body: { classList: { contains: (name) => classes.includes(name) } } });
  assert.equal(exclusiveSurfaceActive(make([])), false);
  for (const name of EXCLUSIVE_SURFACE_CLASSES) assert.equal(exclusiveSurfaceActive(make([name])), true);
  assert.equal(exclusiveSurfaceActive(undefined), false);
});

test('o teclado só age com o card no topo e com o foco nele (ou livre)', () => {
  const module = readModule();
  assert.match(module, /const isTopmost = \(\) => root\.isConnected/);
  assert.match(module, /return Boolean\(hit\) && !root\.contains\(hit\);/);
  const handler = module.slice(module.indexOf('function onKeyDown(event) {'));
  const beforeEsc = handler.slice(0, handler.indexOf("if (event.key === 'Escape')"));
  assert.match(beforeEsc, /if \(closing \|\| !isTopmost\(\)\) return;/);
  assert.match(beforeEsc, /if \(event\.defaultPrevented\) return;/);
  // Não modal: com o foco na busca que o próprio tutorial abriu, ESC é da busca.
  assert.match(beforeEsc, /if \(!focusInCard && !focusIdle\) return;/);
  assert.match(module, /addEventListener\('keydown', onKeyDown, true\)/);
});

test('cede a outra superfície e espera se ela já está na tela; sem timer', () => {
  const module = readModule();
  assert.match(module,
    /if \(revealed && blocked\) yieldToExclusiveSurface\(\);\s*\n\s*else if \(!revealed && !blocked\) reveal\(\);/);
  assert.match(module, /dismiss\(\{ restoreFocus: false \}\)/);
  assert.match(module, /attributes: true, attributeFilter: \['class'\]/);
  const accepted = module.slice(module.indexOf('ACCEPTED, DELIBERATELY NOT TIMED OUT'), module.indexOf('  const surfaceObserver'));
  assert.doesNotMatch(accepted.slice(accepted.indexOf('const syncToExclusiveSurfaces')), /setTimeout|setInterval/);
  assert.match(accepted, /docs\/CURRENT-STATE\.md/);
});

test('fechar limpa o realce dos painéis da página', () => {
  const module = readModule();
  const dismiss = module.slice(module.indexOf('const dismiss = ('), module.indexOf('const onNext'));
  assert.match(dismiss, /clearHighlight\(\);/);
  assert.match(readCss(), /\.tour-highlight \{/);
});

// ── CSS e inicialização ──────────────────────────────────────────────────────

test('CSS: inerte até aparecer, [hidden] respeitado e reduced-motion próprio', () => {
  const css = readCss();
  const base = css.slice(css.indexOf('#first-run-launcher {'), css.indexOf('#first-run-launcher.visible {'));
  assert.match(base, /pointer-events: none/);
  assert.match(base, /display: flex/);
  assert.match(css, /#first-run-launcher\[hidden\],\s*\n#first-run-launcher \[hidden\] \{\s*display: none;\s*\}/);
  assert.match(css, /#first-run-launcher\.visible \{[\s\S]*?pointer-events: auto/);
  assert.match(css, /\.tour-steps \{[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto/);
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  assert.ok(reduced.some((b) => b.includes('#first-run-launcher') && b.includes('.tour-highlight')));
  assert.doesNotMatch(css, /first-run-choices/);
});

test('main.js abre o tutorial depois da tela de carga, com as ações dos atalhos', () => {
  const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const startup = main.slice(main.indexOf('void Promise.all(['), main.indexOf('// Expose for debugging'));
  assert.ok(startup.indexOf("loadingScreen.classList.add('hidden')") < startup.indexOf('initFirstRunExperience'));
  assert.match(startup, /actions: \{ openLayers: openLayersPanel, openSearch: openLocationSearch \}/);
  const shortcuts = fs.readFileSync(new URL('./datageoShortcuts.js', import.meta.url), 'utf8');
  assert.match(shortcuts, /export function openLayersPanel\(\)/);
  assert.match(shortcuts, /export function openLocationSearch\(\)/);
});
