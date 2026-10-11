// src/maplibre/layers/gdSolar.js
//
// Geração distribuída fotovoltaica no PR (ANEEL, atualizada todo mês pelo
// GitHub Actions): ~336 mil sistemas, um ponto por empreendimento, cor pela
// classe de consumo e raio pela potência. JSON gzipado aberto
// (scripts/build_gd_solar.py), linhas em array com strings repetidas em
// dicionário (`campos`, `dic`). Pessoa física vem mascarada pela própria ANEEL.
// Posição do SIGEL, arredondada a 0,01° (empilhados em espiral); quem não está
// no SIGEL fica num ponto do município, VAZADO.

import { EMPTY_FC, defineLayer, fc, fmtInt, fmtNum, tipCard } from '../kit.js';

const SRC = 'dg-gd-solar';
const PT = `${SRC}-pt`;
const CORES = ['#facc15', '#84cc16', '#38bdf8', '#f97316', '#a78bfa', '#94a3b8'];

let dados = null;
let legenda = [];

/** Lê .gz já descomprimido pelo servidor (Content-Encoding) ou não. */
export async function lerJsonGz(resp) {
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(buf));
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
}

/** Linha em array -> objeto com os nomes de `campos` e os índices do dicionário resolvidos. */
export function registro(d, id) {
  const row = d?.p?.[id];
  if (!row) return null;
  const r = Object.fromEntries(d.campos.map((c, i) => [c, row[i]]));
  for (const k of Object.keys(d.dic)) r[k] = d.dic[k][r[k]] ?? '';
  return r;
}

export function gdFeatures(d) {
  const counts = new Array(d?.classes?.length ?? 0).fill(0);
  const features = (d?.p ?? []).map((row, id) => {
    counts[row[3]] = (counts[row[3]] ?? 0) + 1;
    return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [row[0], row[1]] }, properties: { c: row[3], kw: row[2], aprox: row[21] ?? 0 } };
  });
  return { features, counts };
}

const dataBr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const kw = (v) => (v >= 1000 ? `${fmtNum(v / 1000, 2)} MW` : `${fmtNum(v, 2)} kW`);

export function gdTooltip(r, d) {
  if (!r) return '';
  const pf = r.tipoCons === 'PF';
  return tipCard({
    icon: '☀️',
    title: r.titular || (pf ? 'Sistema fotovoltaico (pessoa física)' : 'Sistema fotovoltaico'),
    subtitle: `${r.cod} · ${kw(r.kw)}`,
    badge: { text: d?.classes?.[r.c] ?? '', tone: 'info' },
    wide: true,
    rows: [
      ['Potência instalada', kw(r.kw)],
      ['Observação', r.obs, 'warn'],
      ['Porte', r.porte],
      ['Modalidade', r.mod],
      ['UCs que recebem crédito', r.qtdUC > 1 ? fmtInt(r.qtdUC) : ''],
      ['Classe de consumo', r.cls],
      ['Subgrupo tarifário', r.sub],
      ['Titular', pf ? 'Pessoa física (nome mascarado pela ANEEL)' : r.titular],
      [pf ? 'CPF' : 'CNPJ', r.doc],
      ['Conexão', dataBr(r.dtConex)],
      ['Atualização cadastral', dataBr(r.dtAtual)],
    ],
    sections: [{ title: 'Local e rede', rows: [
      ['Município · CEP', [r.mun, r.cep].filter(Boolean).join(' · ')],
      ['Área', r.local],
      ['Distribuidora', r.ag],
      ['Subestação', r.se],
      ['Posição no mapa', [
        r.aprox ? 'no município (fora do SIGEL, sem coordenada)' : 'aproximada (SIGEL arredonda a ~1 km)',
        r.nPonto > 1 ? `espalhado entre ${fmtInt(r.nPonto)} no mesmo ponto` : '',
      ].filter(Boolean).join('; '), 'warn'],
    ] }],
    source: d?.fonte ?? 'ANEEL',
  });
}

export const gdSolarLayer = defineLayer({
  id: 'datageo-gd-solar',
  name: 'Geração distribuída solar (ANEEL)',
  category: 'Energia e conectividade',
  icon: '☀️',
  source: 'ANEEL · GD (mensal)',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [{
    id: PT,
    type: 'circle',
    source: SRC,
    paint: {
      // Raio pela potência (log): 5 kW residencial ~ ponto, usina de MW bem maior.
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        6, ['interpolate', ['linear'], ['ln', ['max', ['get', 'kw'], 1]], 0, 0.8, 4.3, 1.4, 8.5, 5],
        12, ['interpolate', ['linear'], ['ln', ['max', ['get', 'kw'], 1]], 0, 2, 4.3, 3.5, 8.5, 12],
        16, ['interpolate', ['linear'], ['ln', ['max', ['get', 'kw'], 1]], 0, 4, 4.3, 6, 8.5, 18]],
      'circle-color': ['case', ['==', ['get', 'aprox'], 1], 'rgba(0,0,0,0)',
        ['match', ['get', 'c'], ...CORES.flatMap((cor, i) => [i, cor]), '#94a3b8']],
      'circle-stroke-color': ['case', ['==', ['get', 'aprox'], 1],
        ['match', ['get', 'c'], ...CORES.flatMap((cor, i) => [i, cor]), '#94a3b8'], 'rgba(0,0,0,0.5)'],
      'circle-stroke-width': ['case', ['==', ['get', 'aprox'], 1], 1.2, 0.4],
      'circle-opacity': 0.85,
    },
  }],
  interactive: [PT],
  legendFilter: 'c',
  async load(ctx) {
    const resp = await fetch('/data/gd-solar-pr.json.gz');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    dados = await lerJsonGz(resp);
    const { features, counts } = gdFeatures(dados);
    legenda = counts.map((count, i) => ({ key: i, label: dados.classes[i], color: CORES[i], count }));
    ctx.setData(SRC, fc(features));
    const mw = dados.p.reduce((s, row) => s + row[2], 0) / 1000;
    const noMun = dados.p.filter((row) => row[21]).length;
    return { count: features.length, info: `${fmtNum(mw, 0)} MW instalados; ${fmtInt(noMun)} no ponto do município (vazados)` };
  },
  tooltip: (_p, feature) => gdTooltip(registro(dados, feature?.id), dados),
  rowControls: () => ({ legend: legenda }),
});

export default [gdSolarLayer];
