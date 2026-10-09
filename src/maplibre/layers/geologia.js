// src/maplibre/layers/geologia.js
//
// Geologia e recursos minerais na aba Aspectos físicos, quase tudo ao vivo do
// GeoPR (IAT, herdeiro da Mineropar) em imagem, com tooltip pela consulta da
// vista (geoprVista.js) onde o zoom deixa:
//
// - Litologia (litologia_pr, 3.193 polígonos, 185 unidades no padrão SGB):
//   cache de tiles do zoom 7 ao 16 (fora disso o GeoPR devolve 404).
// - Unidades geomorfológicas do ZEE-PR (50 polígonos).
// - Falhas e diques do ZEE-PR (17 mil linhas: só a partir do zoom 8).
// - Processos minerários ativos da ANM (9.615 poligonais). LGPD: o titular
//   (`nome`, pode ser pessoa física) não sai do servidor; só processo, fase,
//   substância e uso.
// - Ocorrências de recursos minerais do SGB/CPRM (233 pontos no PR), WFS
//   público com CORS aberto, lido inteiro ao ligar.

import { defineLayer, tipCard } from '../kit.js';
import { consultaDaVista, ringsParaGeojson } from './geoprVista.js';
import { geoprSpec } from './geoprRaster.js';

const CATEGORY = 'Aspectos físicos';
const txt = (v) => String(v ?? '').trim();

/** Polígono do ArcGIS -> feição GeoJSON com os `campos` como propriedades. */
const poligono = (campos) => (f) => {
  const geometry = ringsParaGeojson(f?.geometry?.rings);
  if (!geometry) return null;
  const a = f.attributes ?? {};
  return { type: 'Feature', id: Number(a.objectid), geometry, properties: Object.fromEntries(campos.map((c) => [c, a[c] ?? null])) };
};

/** Imagem do GeoPR + alvo invisível de hover da consulta da vista. */
function camadaComTooltip({ spec, servico, campos, minzoom, tooltip, oQue, legenda = [] }) {
  const src = `dg-${spec.id.replace(/^datageo-/, '')}-vista`;
  const vista = consultaDaVista({
    src,
    servico,
    campos: ['objectid', ...campos],
    minzoom,
    feicao: poligono(campos),
    tooltip,
    oQue,
    rotulo: spec.id,
    layers: [
      { id: `${src}-hit`, type: 'fill', source: src, minzoom, paint: { 'fill-color': '#000000', 'fill-opacity': 0 } },
      { id: `${src}-realce`, type: 'line', source: src, minzoom,
        paint: {
          'line-color': '#fde047',
          'line-width': 2.5,
          'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, 0],
        } },
    ],
  });
  return defineLayer({
    ...spec,
    sources: { ...spec.sources, ...vista.sources },
    layers: [...spec.layers, ...vista.layers],
    interactive: vista.interactive,
    hoverState: vista.hoverState,
    tooltip: vista.tooltip,
    onEnable: (ctx) => vista.ligar(ctx),
    onDisable: (ctx) => vista.desligar(ctx),
    rowControls: () => ({ legend: [...legenda, ...vista.legenda()] }),
  });
}

// --- litologia ---------------------------------------------------------------

export function litologiaTooltip(p) {
  const idade = [p.era_maxima, p.periodo_ma, p.epoca_max].map(txt).filter(Boolean).join(' · ');
  const ma = (v) => (txt(v) && Number.isFinite(Number(v)) ? `${Number(v).toLocaleString('pt-BR')} Ma` : '');
  return tipCard({
    icon: '🪨',
    title: txt(p.nome_unida) || txt(p.sigla_unid) || 'Unidade litoestratigráfica',
    subtitle: [txt(p.hierarquia), txt(p.sigla_unid)].filter(Boolean).join(' · '),
    rows: [
      ['Idade', idade],
      ['Intervalo', [ma(p.idade_max), ma(p.idade_min)].filter(Boolean).join(' a ')],
      ['Litotipos', [p.litotipo1, p.litotipo2].map(txt).filter(Boolean).join('; ')],
      ['Classe de rocha', txt(p.classe_roc)],
    ],
    source: 'IAT/GeoPR · litologia do Paraná (padrão SGB/CPRM), consulta ao vivo',
  });
}

export const litologiaLayer = camadaComTooltip({
  spec: geoprSpec({
    category: CATEGORY,
    id: 'datageo-litologia',
    sufixo: 'litologia',
    name: 'Geologia · litologia',
    icon: '🪨',
    source: 'IAT/GeoPR · litologia_pr, ao vivo · a partir do zoom 7',
    fontes: [{ servico: 'litologia_pr', cache: 16, minzoom: 7 }],
    opacity: 0.6,
  }),
  servico: 'litologia_pr',
  campos: ['sigla_unid', 'nome_unida', 'hierarquia', 'era_maxima', 'periodo_ma', 'epoca_max',
    'idade_max', 'idade_min', 'litotipo1', 'litotipo2', 'classe_roc'],
  minzoom: 9,
  tooltip: (p) => litologiaTooltip(p),
  oQue: 'polígonos',
});

// --- geomorfologia -----------------------------------------------------------

export function geomorfologiaTooltip(p) {
  const alt = [txt(p.altitude_m), txt(p.altitud_m0)].filter(Boolean);
  return tipCard({
    icon: '⛰️',
    title: txt(p.sub_unid_m) || 'Unidade geomorfológica',
    subtitle: [txt(p.nomenclat), txt(p.unid_morfo)].filter(Boolean).join(' · '),
    rows: [
      ['Morfoestrutura', txt(p.morfo_estrutura)],
      ['Dissecação', txt(p.dissecacao)],
      ['Topos · vertentes · vales', [p.topos, p.vertentes, p.vales].map(txt).filter(Boolean).join(' · ')],
      ['Altitude', alt.length === 2 ? `${alt[0]} a ${alt[1]} m` : alt.join('')],
    ],
    source: 'IAT/GeoPR · ZEE-PR (mapeamento geomorfológico Mineropar/UFPR), consulta ao vivo',
  });
}

export const geomorfologiaLayer = camadaComTooltip({
  spec: geoprSpec({
    category: CATEGORY,
    id: 'datageo-geomorfologia',
    sufixo: 'geomorfologia',
    name: 'Geomorfologia · ZEE-PR',
    icon: '⛰️',
    source: 'IAT/GeoPR · zee_unidades_geomorfologicas, ao vivo',
    fontes: [{ servico: 'zee_unidades_geomorfologicas' }],
    opacity: 0.45,
  }),
  servico: 'zee_unidades_geomorfologicas',
  campos: ['unid_morfo', 'nomenclat', 'sub_unid_m', 'morfo_estrutura', 'dissecacao', 'topos', 'vertentes', 'vales',
    'altitude_m', 'altitud_m0'],
  minzoom: 6,
  tooltip: (p) => geomorfologiaTooltip(p),
  oQue: 'unidades',
});

// --- falhas e diques ---------------------------------------------------------

export const estruturasLayer = defineLayer(geoprSpec({
  category: CATEGORY,
  id: 'datageo-estruturas-geologicas',
  sufixo: 'estruturas-geologicas',
  name: 'Falhas e diques · ZEE-PR',
  icon: '⚡',
  source: 'IAT/GeoPR · zee_falhas_geologicas e zee_diques_geologicos, ao vivo · a partir do zoom 8',
  fontes: [
    { servico: 'zee_diques_geologicos', minzoom: 8 },
    { servico: 'zee_falhas_geologicas', minzoom: 8 },
  ],
}));

// --- processos minerários (ANM) ----------------------------------------------

// Nome do serviço com acento: vai codificado na URL (o GeoPR dá 404 sem isso).
export const SERVICO_ANM = encodeURIComponent('Processos_Minerários_ANM');

// Cores do renderizador do próprio serviço (campo `fase`), só as fases presentes no PR.
const rgb = (r, g, b) => `rgb(${r},${g},${b})`;
export const FASES_ANM = Object.freeze([
  ['Autorização de pesquisa', rgb(0, 112, 255)],
  ['Requerimento de pesquisa', rgb(233, 255, 190)],
  ['Requerimento de lavra', rgb(255, 167, 127)],
  ['Direito de requerer a lavra', rgb(255, 211, 127)],
  ['Concessão de lavra', rgb(255, 0, 0)],
  ['Requerimento de licenciamento', rgb(255, 255, 190)],
  ['Licenciamento', rgb(255, 255, 0)],
  ['Requerimento de registro de extração', rgb(112, 168, 0)],
  ['Registro de extração', rgb(102, 205, 171)],
  ['Lavra garimpeira (e requerimento)', rgb(202, 122, 245)],
  ['Disponibilidade (e apto)', rgb(215, 194, 158)],
].map(([label, color]) => ({ label, color })));

export function processoMinerarioTooltip(p) {
  return tipCard({
    icon: '⛏️',
    title: `Processo ANM ${txt(p.processo)}`,
    subtitle: txt(p.fase),
    rows: [
      ['Substância', txt(p.subs)],
      ['Uso', txt(p.uso)],
      ['Ano do processo', txt(p.ano)],
      ['Último evento', txt(p.ult_evento)],
    ],
    source: 'ANM via IAT/GeoPR (processos minerários ativos), consulta ao vivo · sem titular',
  });
}

export const processosMinerariosLayer = camadaComTooltip({
  spec: geoprSpec({
    category: CATEGORY,
    id: 'datageo-processos-minerarios',
    sufixo: 'processos-minerarios',
    name: 'Mineração · processos ANM',
    icon: '⛏️',
    source: 'ANM via IAT/GeoPR (Processos_Minerários_ANM), ao vivo',
    fontes: [{ servico: SERVICO_ANM }],
    opacity: 0.7,
  }),
  servico: SERVICO_ANM,
  // Sem `nome` (titular): LGPD.
  campos: ['processo', 'ano', 'fase', 'subs', 'uso', 'ult_evento'],
  minzoom: 10,
  tooltip: (p) => processoMinerarioTooltip(p),
  oQue: 'processos',
  legenda: FASES_ANM,
});

// --- ocorrências minerais (SGB) ----------------------------------------------

const SGB_WFS = 'https://geoservicos.sgb.gov.br/geoserver/ows?service=WFS&version=1.1.0&request=GetFeature'
  + '&typeName=geosgb:ocorrencias_recursos_minerais&outputFormat=application/json&srsName=EPSG:4326'
  + `&CQL_FILTER=${encodeURIComponent("uf='PR'")}`
  + '&propertyName=geom,toponimia,municipio,substancias,status_economico,importancia,classes_utilitarias,rochas_hospedeiras';
const OCORR_SRC = 'dg-ocorrencias-minerais';

/** status_economico -> cor (mina em destaque, não explotado ao fundo). Valores do GeoSGB. */
export const STATUS_MINERAL = Object.freeze([
  { key: 'Mina', label: 'Mina', color: '#f97316' },
  { key: 'Garimpo', label: 'Garimpo', color: '#facc15' },
  { key: 'Não explotado', label: 'Não explotado', color: '#a78bfa' },
  { key: 'Indeterminado', label: 'Indeterminado', color: '#94a3b8' },
]);

export function ocorrenciaTooltip(p) {
  return tipCard({
    icon: '💎',
    title: txt(p.substancias) || 'Ocorrência mineral',
    subtitle: [txt(p.status_economico), txt(p.importancia)].filter(Boolean).join(' · '),
    rows: [
      ['Local', [txt(p.toponimia), txt(p.municipio)].filter(Boolean).join(', ')],
      ['Classe utilitária', txt(p.classes_utilitarias)],
      ['Rocha hospedeira', txt(p.rochas_hospedeiras)],
    ],
    source: 'SGB/CPRM · GeoSGB, ocorrências de recursos minerais',
  });
}

export const ocorrenciasMineraisLayer = defineLayer({
  id: 'datageo-ocorrencias-minerais',
  name: 'Ocorrências minerais · SGB',
  category: CATEGORY,
  icon: '💎',
  source: 'SGB/CPRM · GeoSGB (WFS), ao vivo',
  sources: { [OCORR_SRC]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, generateId: true,
    attribution: 'SGB/CPRM' } },
  layers: [
    { id: `${OCORR_SRC}-pt`, type: 'circle', source: OCORR_SRC,
      paint: {
        'circle-color': ['match', ['get', 'status_economico'], ...STATUS_MINERAL.flatMap((s) => [s.key, s.color]), '#94a3b8'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 12, 7],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#fde047', '#0f172a'],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 1],
      } },
  ],
  interactive: [`${OCORR_SRC}-pt`],
  hoverState: OCORR_SRC,
  legendFilter: 'status_economico',
  async load(ctx) {
    const r = await fetch(SGB_WFS);
    if (!r.ok) throw new Error(`SGB WFS: HTTP ${r.status}`);
    const fc = await r.json();
    ctx.setData(OCORR_SRC, fc);
    return fc.features.length;
  },
  tooltip: (p) => ocorrenciaTooltip(p),
  rowControls: () => ({ legend: STATUS_MINERAL.map(({ key, label, color }) => ({ key, label, color })) }),
});

export default [litologiaLayer, geomorfologiaLayer, estruturasLayer, processosMinerariosLayer, ocorrenciasMineraisLayer];
