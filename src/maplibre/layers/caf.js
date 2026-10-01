// src/maplibre/layers/caf.js
//
// Agricultura familiar (CAF/MDA): um ponto por família, no imóvel principal
// declarado (scripts/build_caf.py corrige coordenadas com vírgula perdida,
// sinal ou lat/lon trocados). Cor = produto principal (maior renda dentro do
// estabelecimento); ponto VAZADO = coordenada fora do município declarado da
// área (o técnico confere); CAF inativa mais apagada.
//
// Hover: nome, produto, renda e área. Clique: o cadastro completo da família
// no painel da ficha (caf/<ibge>.json, só no clique) e, com a camada CAR
// ligada, o perímetro do imóvel do CAR que contém o ponto destacado.
//
// Tudo do bucket privado (LGPD): sem usuário liberado a camada não carrega.

import { CAF_CORES, loadCafFamilias, loadCafPontos, periodo } from '../../data/cafFamilias.js';
import { familiaHtml } from '../../datageoCaf.js';
import { openPainel } from '../../datageoFicha.js';
import { EMPTY_FC, defineLayer, fc, fmtInt, fmtNum, tipCard } from '../kit.js';
import { carImovelEm } from './territorios.js';

const SRC = 'dg-caf';
const PT = 'dg-caf-pt';
const SEL = 'dg-caf-sel';
const LOCAL = ['ok', 'corrigida', 'fora_municipio'];

let dados = null; // caf-pontos.json
let legenda = [];
let selecao = 0; // clique mais recente: resposta atrasada de outro clique não redesenha

/** Features dos pontos (id = índice da linha em `p`) e contagem por grupo. */
export function cafFeatures(d) {
  const counts = new Array(d?.grupos?.length ?? 0).fill(0);
  const features = (d?.p ?? []).map(([lon, lat, , , g, , , , local, inativa], id) => {
    counts[g] = (counts[g] ?? 0) + 1;
    return {
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { g, fora: d.status[local] === 'fora_municipio' ? 1 : 0, inativa },
    };
  });
  return { features, counts };
}

const cor = ['match', ['get', 'g'], ...CAF_CORES.flatMap((c, i) => [i, c]), '#94a3b8'];

function linha(id) {
  const r = dados?.p?.[id];
  if (!r) return null;
  const [lon, lat, caf, ibge, g, nome, renda, ha, local, inativa] = r;
  return { lon, lat, caf: String(caf), ibge, g, nome, renda, ha, local: dados.status[local] ?? LOCAL[local], inativa };
}

function destacar(ctx, f, imovel) {
  const feats = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lon, f.lat] }, properties: {} }];
  if (imovel) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: imovel.ring }, properties: {} });
  ctx.setData(SEL, fc(feats));
}

export default [defineLayer({
  id: 'datageo-caf',
  name: 'Agricultura familiar (CAF)',
  category: 'Território',
  icon: '👨‍🌾',
  source: 'MDA · CAF',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC }, [SEL]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: PT,
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 10, 3.5, 14, 6],
        'circle-color': ['case', ['==', ['get', 'fora'], 1], 'rgba(0,0,0,0)', cor],
        'circle-stroke-color': ['case', ['==', ['get', 'fora'], 1], cor, 'rgba(0,0,0,0.55)'],
        'circle-stroke-width': ['case', ['==', ['get', 'fora'], 1], 1.4, 0.6],
        'circle-opacity': ['case', ['==', ['get', 'inativa'], 1], 0.35, 0.9],
        'circle-stroke-opacity': ['case', ['==', ['get', 'inativa'], 1], 0.35, 1],
      },
    },
    {
      id: 'dg-caf-sel-car',
      type: 'line',
      source: SEL,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#fde047', 'line-width': 3 },
    },
    {
      id: 'dg-caf-sel-pt',
      type: 'circle',
      source: SEL,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#fde047', 'circle-stroke-width': 2.5 },
    },
  ],
  interactive: [PT],
  async load(ctx) {
    dados = await loadCafPontos();
    if (!dados) throw new Error('acesso restrito: entre com usuário liberado');
    const { features, counts } = cafFeatures(dados);
    legenda = counts.map((count, i) => ({ label: dados.grupos[i], color: CAF_CORES[i], count }));
    ctx.setData(SRC, fc(features));
    const fora = features.filter((f) => f.properties.fora).length;
    return { count: features.length, info: `${periodo(dados.referencia)} · ${fmtInt(fora)} fora do município declarado (vazados)` };
  },
  onDisable: (ctx) => {
    selecao++;
    ctx.setData(SEL, EMPTY_FC);
  },
  tooltip: (_p, feature) => {
    const f = linha(feature?.id);
    if (!f) return '';
    return tipCard({
      icon: '👨‍🌾',
      title: f.nome || `CAF ${f.caf}`,
      subtitle: `CAF ${f.caf}${f.inativa ? ' · inativa' : ''}`,
      rows: [
        ['Produto principal', dados.grupos[f.g]],
        ['Renda declarada', f.renda ? `R$ ${fmtInt(f.renda)}` : ''],
        ['Área', f.ha ? fmtNum(f.ha, 1, ' ha') : ''],
        ['Renda/ha', f.ha > 0 && f.renda ? `R$ ${fmtInt(f.renda / f.ha)}` : ''],
        f.local === 'fora_municipio' ? ['Localização', 'fora do município declarado', 'warn'] : null,
        f.local === 'corrigida' ? ['Localização', 'coordenada corrigida', 'warn'] : null,
      ],
      note: 'Clique para o cadastro completo',
      source: `MDA · CAF ${periodo(dados.referencia)}`,
    });
  },
  click: (_p, feature, ctx) => {
    const f = linha(feature?.id);
    if (!f) return;
    const meu = ++selecao;
    destacar(ctx, f, null);
    openPainel({
      nome: f.nome || `CAF ${f.caf}`,
      meta: `CAF ${f.caf} · MDA ${periodo(dados.referencia)} · acesso restrito`,
      carregar: async () => {
        const ligado = ctx.isOn('datageo-car');
        const [mun, imovel] = await Promise.all([
          loadCafFamilias(f.ibge),
          ligado ? carImovelEm(f.lon, f.lat).catch(() => null) : null,
        ]);
        const fam = mun?.familias?.[f.caf];
        if (!fam) return null;
        if (meu === selecao && ctx.isOn('datageo-caf')) destacar(ctx, f, imovel);
        return familiaHtml(fam, { car: { ligado, imovel }, grupos: dados.grupos, grupo: f.g });
      },
    });
  },
  rowControls: () => ({ legend: legenda }),
})];
