// src/processing/geolibrePanel.js
//
// Spike: ferramentas de geoprocessamento do GeoLibre (geolibre-wasm) sobre as
// fontes GeoJSON já carregadas no mapa. Entrada vira /work/in.geojson (e
// /work/overlay.geojson quando a ferramenta pede sobreposição); a saída
// /work/out.geojson entra como fonte `proc-N` com preenchimento, linha e ponto.
// A lista de ferramentas vem do próprio binário (listTools), sem catálogo local.

const RESULT_COLOR = '#ffb347';
const enc = new TextEncoder();
const dec = new TextDecoder();

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./geolibreWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data);
  };
  return worker;
}

function call(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...msg }, transfer);
  });
}

/** Fontes GeoJSON do estilo atual: [{id, data}] com `data` objeto ou URL. */
function geojsonSources(map) {
  const sources = map.getStyle()?.sources ?? {};
  return Object.entries(sources)
    .filter(([, s]) => s.type === 'geojson')
    .map(([id]) => ({ id, data: map.getSource(id)?.serialize?.().data }))
    .filter((s) => s.data);
}

async function sourceBytes(data) {
  if (typeof data === 'string') {
    const r = await fetch(data);
    if (!r.ok) throw new Error(`fonte ${data}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  return enc.encode(JSON.stringify(data));
}

function addResult(map, geojson) {
  const id = `proc-${Date.now()}`;
  map.addSource(id, { type: 'geojson', data: geojson });
  map.addLayer({ id: `${id}-fill`, type: 'fill', source: id, filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': RESULT_COLOR, 'fill-opacity': 0.25 } });
  map.addLayer({ id: `${id}-line`, type: 'line', source: id,
    paint: { 'line-color': RESULT_COLOR, 'line-width': 1.5 } });
  map.addLayer({ id: `${id}-pt`, type: 'circle', source: id, filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-color': RESULT_COLOR, 'circle-radius': 4 } });
  return id;
}

/** Monta o painel dentro de `root` (um <details>) e liga ao mapa MapLibre. */
export function initGeolibrePanel(root, map) {
  if (!root || !map) return;
  root.innerHTML = `
    <summary>PROCESSAMENTO <span class="proc-badge">GeoLibre WASM</span></summary>
    <label>Entrada <select data-f="input"></select></label>
    <label>Sobreposição <select data-f="overlay"><option value="">(nenhuma)</option></select></label>
    <label>Ferramenta <input data-f="tool" list="proc-tools" placeholder="buffer_vector" autocomplete="off" spellcheck="false"></label>
    <datalist id="proc-tools"></datalist>
    <label>Parâmetros <input data-f="args" placeholder="--distance=0.05 --dissolve=true" spellcheck="false"></label>
    <div class="proc-row"><button type="button" data-f="run">Executar</button><span data-f="status">—</span></div>`;
  const f = (k) => root.querySelector(`[data-f="${k}"]`);
  const status = (t) => { f('status').textContent = t; };

  const refreshSources = () => {
    const opts = geojsonSources(map).map((s) => `<option value="${s.id}">${s.id}</option>`).join('');
    for (const [k, prefix] of [['input', ''], ['overlay', '<option value="">(nenhuma)</option>']]) {
      const sel = f(k);
      const was = sel.value;
      sel.innerHTML = prefix + opts;
      sel.value = was;
    }
  };

  let listed = false;
  root.addEventListener('toggle', async () => {
    if (!root.open) return;
    refreshSources();
    if (listed) return;
    status('carregando WASM…');
    const t0 = performance.now();
    try {
      const { tools } = await call({ cmd: 'list' });
      root.querySelector('#proc-tools').innerHTML = tools.map((t) => `<option value="${t}">`).join('');
      listed = true;
      status(`${tools.length} ferramentas em ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      status(`falha: ${err.message}`);
    }
  });

  f('run').addEventListener('click', async () => {
    const tool = f('tool').value.trim();
    const inputId = f('input').value;
    if (!tool || !inputId) { status('escolha entrada e ferramenta'); return; }
    const byId = Object.fromEntries(geojsonSources(map).map((s) => [s.id, s.data]));
    const input = { 'in.geojson': await sourceBytes(byId[inputId]) };
    const args = [`--input=/work/in.geojson`, `--output=/work/out.geojson`, ...f('args').value.split(/\s+/).filter(Boolean)];
    const overlayId = f('overlay').value;
    if (overlayId) {
      input['overlay.geojson'] = await sourceBytes(byId[overlayId]);
      args.push('--overlay=/work/overlay.geojson');
    }
    status(`${tool}…`);
    f('run').disabled = true;
    const t0 = performance.now();
    try {
      const r = await call({ cmd: 'run', tool, args, input }, Object.values(input).map((u) => u.buffer));
      const ms = Math.round(performance.now() - t0);
      if (r.exitCode !== 0) { status(`erro ${r.exitCode}: ${r.stdout.slice(-2).join(' ')}`); return; }
      const out = r.files['out.geojson'];
      if (!out) { status(`ok (${ms} ms), saída: ${Object.keys(r.files).join(', ') || 'nenhuma'}`); return; }
      const geojson = JSON.parse(dec.decode(out));
      const id = addResult(map, geojson);
      status(`${geojson.features?.length ?? 0} feições → ${id} (${ms} ms)`);
      refreshSources();
    } catch (err) {
      status(`falha: ${err.message}`);
    } finally {
      f('run').disabled = false;
    }
  });
}
