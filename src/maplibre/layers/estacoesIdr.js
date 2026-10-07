// src/maplibre/layers/estacoesIdr.js
//
// Estações de pesquisa (polígonos dos KML), polos de pesquisa e unidades
// florestais (ponto na sede do município) do IDR-Paraná. O tooltip lista os
// servidores lotados na unidade (servidores-idr.json, chave `unidade`).
// Os dois arquivos saem do bucket privado (scripts/build_estacoes_idr.py e a
// Edge Function datageo-servidores do c2).

import { extensionistasDoMunicipio, loadServidoresIdr, normNome, servidoresDasUnidades } from '../../data/servidoresIdr.js';
import { dgFetchData } from '../../data/datageoClient.js';
import { gerenteDaRegional, loadGerentesIdr } from '../../data/gerentesIdr.js';
import { grupos, loadGetecGrupos, redeFeatures } from '../../data/getecGrupos.js';
import { escritorioHtml, extensionistaHtml } from '../../datageoGetec.js';
import { openPainel } from '../../datageoFicha.js';
import { extensao } from './cafPj.js';
import { EMPTY_FC, LABEL_PAINT, TEXT_FONT, defineLayer, fc, tipCard, zoomForHeight } from '../kit.js';
import { makePointsLayer } from './energiaLogistica.js';

const URL = '/privado/estacoes-idr-pr.geojson';
const COR = '#facc15';
const SRC = 'dg-estacoes-idr';
const FILL = 'dg-estacoes-idr-fill';
const PT = 'dg-estacoes-idr-pt';
const MAX_NOMES = 25;

const TIPO = { estacao: 'Estação de pesquisa', polo: 'Polo de pesquisa', 'unidade-florestal': 'Unidade florestal' };

let servidores = null; // payload de servidores-idr.json; null = indisponível
let gerentes = null; // payload de gerentes-idr.json; null = indisponível
let getec = null; // payload de getec-grupos.json; null = indisponível
let unidades = []; // features de unidades-idr-pr.geojson, na ordem (id = índice)
const REDE = 'dg-getec-rede';
const UNIDADES_URL = '/privado/unidades-idr-pr.geojson';

/** HTML do tooltip de uma estação/polo/unidade (exportado para o teste). */
export function estacaoTooltipHtml(p, dados) {
  const lista = dados ? servidoresDasUnidades(dados, p.unidade) : null;
  const tipos = String(p.tipo ?? '').split(',').map((t) => TIPO[t] ?? t).filter(Boolean);
  const nomes = (lista ?? []).slice(0, MAX_NOMES)
    .map((s) => [s.nome, s.formacao || 'formação não informada']);
  const resto = (lista?.length ?? 0) - nomes.length;
  const semUnidade = !p.unidade;
  const fmtHa = (v) => (Number(v) > 0 ? `${Number(v).toLocaleString('pt-BR')} ha` : '');
  return tipCard({
    icon: p.tipo === 'unidade-florestal' ? '🌲' : '🔬',
    title: p.nome,
    subtitle: `IDR-Paraná · ${p.unidade_nome || tipos.join(' · ')} · ${p.municipio}`,
    badge: lista && !semUnidade ? { text: `${lista.length} servidor${lista.length === 1 ? '' : 'es'}`, tone: 'info' } : null,
    rows: [['Uso', p.uso], ['Contrato', p.contrato], ['Área', fmtHa(p.area_ha)]],
    sections: nomes.length ? [{ title: 'Servidores (SisPont)', rows: nomes }] : [],
    note: [
      !lista ? 'Lista de servidores indisponível no momento.' : '',
      semUnidade ? 'Sem unidade florestal do SisPont neste município: servidores não vinculados.' : '',
      lista && !semUnidade && !lista.length ? 'Nenhum servidor lotado nesta unidade no SisPont.' : '',
      resto > 0 ? `+ ${resto} servidores.` : '',
      p.aproximado ? 'Localização aproximada: sede do município.' : '',
    ].filter(Boolean).join(' '),
    source: 'IDR-Paraná · SisPont + Portal da Transparência PR',
    wide: true,
  });
}

export const estacoesIdrLayer = defineLayer({
  id: 'datageo-estacoes-idr',
  name: 'Estações e polos de pesquisa (IDR)',
  category: 'IDR-Paraná',
  icon: '🔬',
  source: 'IDR-Paraná',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: FILL,
      type: 'fill',
      source: SRC,
      filter: ['!=', ['geometry-type'], 'Point'],
      paint: { 'fill-color': COR, 'fill-opacity': 0.35 },
    },
    {
      id: 'dg-estacoes-idr-line',
      type: 'line',
      source: SRC,
      filter: ['!=', ['geometry-type'], 'Point'],
      paint: { 'line-color': COR, 'line-width': 1.6 },
    },
    {
      id: PT,
      type: 'circle',
      source: SRC,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-color': COR,
        'circle-radius': 6,
        'circle-stroke-color': 'rgba(0,0,0,0.6)',
        'circle-stroke-width': 1,
      },
    },
    {
      // Estações são pequenas (poucos km²): rótulo só de perto.
      id: 'dg-estacoes-idr-label',
      type: 'symbol',
      source: SRC,
      minzoom: zoomForHeight(250_000),
      layout: {
        'text-field': ['get', 'nome'],
        'text-font': TEXT_FONT,
        'text-size': 11,
        'text-max-width': 14,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
      },
      paint: { ...LABEL_PAINT, 'text-color': COR },
    },
  ],
  interactive: [FILL, PT],
  async load(ctx) {
    const [gj, dados] = await Promise.all([
      dgFetchData(URL).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      loadServidoresIdr().catch((err) => {
        console.warn('[DataGeo] servidores IDR indisponíveis:', err?.message);
        return null;
      }),
    ]);
    servidores = dados;
    ctx.setData(SRC, gj);
    return gj.features?.length ?? 0;
  },
  tooltip: (p) => estacaoTooltipHtml(p, servidores),
});

// ------------------------------------------------ unidades (endereços)
//
// 447 unidades (UMEs, regionais, estações, polos, sede) com endereço do site
// do IDR (scripts/build_unidades_idr.py). Ponto que não fechava com o
// município foi para a sede municipal e vem marcado `aproximado`.

export const UNIDADE_LEGENDA = Object.freeze([
  { grupo: 'ume', label: 'Unidade municipal', color: '#38bdf8' },
  { grupo: 'regional', label: 'Unidade regional', color: '#f97316' },
  { grupo: 'pesquisa', label: 'Estação / polo de pesquisa', color: COR },
  { grupo: 'sede', label: 'Sede', color: '#f43f5e' },
]);
const UNIDADE_COR = Object.fromEntries(UNIDADE_LEGENDA.map((g) => [g.grupo, g.color]));
const UNIDADE_ROTULO = { ume: 'Unidade municipal de extensão', regional: 'Unidade regional de extensão',
  estacao: 'Estação de pesquisa', polo: 'Polo de pesquisa', sede: 'Sede' };

export function unidadeEstilo(p) {
  const grupo = p.tipo === 'estacao' || p.tipo === 'polo' ? 'pesquisa' : p.tipo;
  if (!UNIDADE_COR[grupo]) return null;
  const grande = grupo !== 'ume';
  return { grupo, size: grande ? 9 : 6, color: UNIDADE_COR[grupo], alpha: 0.95,
    label: String(p.nome ?? '').split(' · ').pop(), labelMaxDist: grande ? 400_000 : 60_000 };
}

/**
 * Tooltip do escritório. Na unidade municipal (UME) lista os extensionistas
 * lotados no município (`dados` = servidores-idr.json; null = indisponível);
 * na regional, o gerente (`ger` = gerentes-idr.json).
 */
export function unidadeTooltipHtml(p, dados = null, ger = null) {
  const ume = p.tipo === 'ume';
  const gerente = p.tipo === 'regional' ? gerenteDaRegional(ger, p.regional) : null;
  const ext = ume && dados ? extensionistasDoMunicipio(dados, p.municipio) : null;
  const todos = (ext?.grupos ?? []).flatMap((g) => g.servidores);
  const nomes = todos.slice(0, MAX_NOMES).map((s) => [s.nome, s.formacao || 'formação não informada']);
  return tipCard({
    icon: '🏢',
    title: p.nome,
    subtitle: `IDR-Paraná · ${UNIDADE_ROTULO[p.tipo] ?? p.tipo}${p.regional ? ` · Regional ${p.regional}` : ''}`,
    badge: ume && dados ? { text: `${todos.length} extensionista${todos.length === 1 ? '' : 's'}`, tone: 'info' } : null,
    rows: [...(gerente ? [['Gerente', gerente.nome]] : []), ['Endereço', p.endereco], ['Telefone', p.telefone], ['E-mail', p.email]],
    sections: nomes.length ? [{ title: 'Extensionistas (SisPont + Portal da Transparência)', rows: nomes }] : [],
    note: [
      ume && !dados ? 'Lista de extensionistas indisponível no momento.' : '',
      todos.length > nomes.length ? `+ ${todos.length - nomes.length} extensionistas.` : '',
      p.aproximado ? 'Localização aproximada (sede do município): o ponto da base não fechava com o endereço.' : '',
      p.no_site === false ? 'Não consta em "Endereços e Contatos" do site do IDR.' : '',
      ume ? 'Clique para ver os grupos de assistidos (GETEC) de cada extensionista.' : '',
    ].filter(Boolean).join(' '),
    source: `IDR-Paraná · Endereços e Contatos (28/09/2026) · SisPont${gerente ? ` · gerente: RH do IDR${gerente.referencia ? ` (${gerente.referencia})` : ''}` : ''}`,
    wide: nomes.length > 0,
  });
}

const unidadesBase = makePointsLayer({
  id: 'datageo-unidades-idr',
  name: 'Unidades do IDR (endereços)',
  category: 'IDR-Paraná',
  icon: '🏢',
  source: 'IDR-Paraná',
  url: UNIDADES_URL,
  estilo: unidadeEstilo,
  tooltip: (p) => unidadeTooltipHtml(p, servidores, gerentes),
  legend: UNIDADE_LEGENDA,
  labelDists: [400_000, 60_000],
});

// Os pontos do makePointsLayer + a lista de servidores para o tooltip das UMEs
// e os gerentes para o das regionais
// (falha da lista não derruba a camada: o tooltip avisa).
export const unidadesIdrLayer = defineLayer({
  ...unidadesBase,
  sources: { ...unidadesBase.sources, [REDE]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    // Rede do extensionista (escritório -> famílias dos grupos do GETEC), por baixo dos pontos.
    {
      id: 'dg-getec-rede-linha',
      type: 'line',
      source: REDE,
      filter: ['==', ['geometry-type'], 'LineString'],
      metadata: { 'dg:slot': 'point', 'dg:legenda': false },
      paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-opacity': 0.8 },
    },
    {
      id: 'dg-getec-rede-pt',
      type: 'circle',
      source: REDE,
      filter: ['==', ['geometry-type'], 'Point'],
      metadata: { 'dg:slot': 'label', 'dg:legenda': false },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 8],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    },
    ...unidadesBase.layers,
  ],
  async load(ctx) {
    const [n, dados, ger, gg, gj] = await Promise.all([
      unidadesBase.load(ctx),
      loadServidoresIdr().catch((err) => {
        console.warn('[DataGeo] servidores IDR indisponíveis:', err?.message);
        return null;
      }),
      loadGerentesIdr().catch((err) => {
        console.warn('[DataGeo] gerentes IDR indisponíveis:', err?.message);
        return null;
      }),
      loadGetecGrupos(),
      dgFetchData(UNIDADES_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    servidores = dados ?? servidores;
    gerentes = ger ?? gerentes;
    getec = gg ?? getec;
    // Mesmo filtro e ordem do pointFeatures: o id da feição é o índice aqui.
    unidades = (gj?.features ?? []).filter((f) => {
      const [lon, lat] = f?.geometry?.coordinates ?? [];
      return Number.isFinite(lon) && Number.isFinite(lat) && unidadeEstilo(f.properties ?? {});
    });
    return n;
  },
  onDisable: (ctx) => {
    ctx.setData(REDE, EMPTY_FC);
  },
  click: (_p, feature, ctx) => {
    const f = unidades[feature?.id];
    const p = f?.properties;
    if (!p || p.tipo !== 'ume') return;
    abrirEscritorio(p, f.geometry.coordinates, ctx);
  },
});

/**
 * Painel da UME: extensionistas do município com os grupos do GETEC; o clique
 * num nome lista os produtores e liga o escritório às famílias no mapa.
 */
function abrirEscritorio(p, origem, ctx, inicial = null) {
  const lista = (extensionistasDoMunicipio(servidores, p.municipio)?.grupos ?? []).flatMap((g) => g.servidores);
  let ativo = null;
  const html = () => escritorioHtml({ servidores: lista, getec, ativo }) + extensionistaHtml(grupos(getec, ativo));
  const selecionar = (id) => {
    ativo = id;
    const rede = redeFeatures(grupos(getec, ativo), origem);
    ctx.setData(REDE, fc(rede));
    const bb = extensao([{ geometry: { type: 'Point', coordinates: origem } }, ...rede]);
    if (bb && rede.length) ctx.map.fitBounds(bb, { padding: 80, maxZoom: 12, duration: 800 });
    else ctx.map.flyTo({ center: origem, zoom: 12, duration: 800 });
  };
  ctx.setData(REDE, EMPTY_FC);
  if (inicial != null) selecionar(String(inicial));
  openPainel({
    nome: p.nome,
    meta: `IDR-Paraná · ${UNIDADE_ROTULO[p.tipo] ?? p.tipo}${p.regional ? ` · Regional ${p.regional}` : ''} · acesso restrito`,
    carregar: async () => html(),
    aoMontar: (body) => {
      body.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-ext]');
        if (!btn) return;
        selecionar(btn.dataset.ext);
        body.innerHTML = html();
      });
    },
  });
}

/**
 * Abre o escritório municipal (UME) do extensionista já com a rede dele, para a
 * busca por pessoa. A camada de unidades precisa estar ligada (fonte REDE);
 * sem UME no município, abre só os grupos do GETEC.
 * @param {{id: string, nome: string, municipio: string}} s - servidor de servidores-idr.json
 */
export async function abrirExtensionista(s, ctx) {
  if (!unidades.length || !getec) await unidadesIdrLayer.load(ctx);
  const alvo = normNome(s.municipio);
  const ume = unidades.find((f) => f.properties?.tipo === 'ume' && normNome(f.properties.municipio) === alvo);
  if (ume) return abrirEscritorio(ume.properties, ume.geometry.coordinates, ctx, s.id);
  openPainel({
    nome: s.nome,
    meta: `IDR-Paraná · ${s.municipio ?? ''} · acesso restrito`,
    carregar: async () => extensionistaHtml(grupos(getec, s.id)) || '<div class="fx-dim">Sem grupos no GETEC.</div>',
  });
}

// Unidades (escritórios) primeiro no painel; estações e polos de pesquisa em seguida.
export default [unidadesIdrLayer, estacoesIdrLayer];
