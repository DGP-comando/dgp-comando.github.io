// src/maplibre/layers/elNino.js
//
// Perspectiva El Niño no PR: os próximos 6 meses de chuva e temperatura por
// célula de 0,1° (~11 km), com o que o El Niño costuma fazer em cada lugar.
// Dois JSONs estáticos (contrato em docs/EL_NINO.md):
//   el-nino-previsao-pr.json   mensal (Actions): ECMWF SEAS5 calibrado na
//                              normal CHIRPS, 51 membros, tercis do NMME, ONI.
//   el-nino-historico-pr.json  anual: sinal do ENSO 1981-2025 (CHIRPS, ERA5-Land).
//
// Chips: uma VARIÁVEL (chuva, excesso, temperatura, sinal histórico) e um MÊS.
// Células onde as fontes não concordam (confiança <= 1 de 3) ou o sinal
// histórico não é significativo ganham um véu cinza: a cor diz "pouco a
// afirmar aqui", como no explorer da Morfo.

import { EMPTY_FC, defineLayer, fc, fmtCoord, fmtNum, tipCard } from '../kit.js';
import { gridCellFeatures } from './gradesClima.js';
import { cursorContext, trackCursor } from './transporte.js';

const ID = 'datageo-el-nino';
const SRC = 'dg-el-nino';
const FILL = `${SRC}-fill`;
const VEU = `${SRC}-veu`;

const MES_CURTO = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const MES_NOME = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro',
  'outubro', 'novembro', 'dezembro'];

// BrBG: seco marrom, normal areia, úmido verde-azulado (mesma leitura da umidade do solo).
const ANOM_CLASSES = Object.freeze([
  { max: -25, label: 'Muito abaixo (< −25%)', color: '#8c510a' },
  { max: -10, label: 'Abaixo (−25 a −10%)', color: '#d8b365' },
  { max: 10, label: 'Perto do normal (±10%)', color: '#e6e0c8' },
  { max: 25, label: 'Acima (+10 a +25%)', color: '#80cdc1' },
  { max: 50, label: 'Bem acima (+25 a +50%)', color: '#35978f' },
  { max: 100, label: 'Muito acima (+50 a +100%)', color: '#01665e' },
  { max: Infinity, label: 'O dobro ou mais (> +100%)', color: '#003c30' },
]);

export const VARIAVEIS = Object.freeze([
  Object.freeze({
    key: 'chuva', chip: 'CHUVA', titulo: 'Chuva prevista frente à normal',
    classes: ANOM_CLASSES,
    valor: (P, H, im, ih, n) => P.campos.anom[im][n],
  }),
  Object.freeze({
    key: 'excesso', chip: 'EXCESSO', titulo: 'Chance de o mês fechar no terço mais chuvoso',
    classes: Object.freeze([
      { max: 33.5, label: 'Até 33% (chance normal)', color: '#e6e0c8' },
      { max: 50, label: '34 a 50%', color: '#9ecae1' },
      { max: 70, label: '50 a 70%', color: '#4292c6' },
      { max: Infinity, label: 'Acima de 70%', color: '#08519c' },
    ]),
    valor: (P, H, im, ih, n) => P.campos.pAcima[im][n],
  }),
  Object.freeze({
    key: 'temp', chip: 'TEMP', titulo: 'Temperatura prevista frente à normal',
    classes: Object.freeze([
      { max: 0, label: 'Abaixo do normal', color: '#6b8fb8' },
      { max: 0.5, label: '0 a +0,5 °C', color: '#e6e0c8' },
      { max: 1, label: '+0,5 a +1 °C', color: '#fdb863' },
      { max: 1.5, label: '+1 a +1,5 °C', color: '#e08214' },
      { max: Infinity, label: 'Acima de +1,5 °C', color: '#b35806' },
    ]),
    valor: (P, H, im, ih, n) => (P.campos.tAnom[im][n] == null ? null : P.campos.tAnom[im][n] / 10),
  }),
  Object.freeze({
    key: 'sinal', chip: 'SINAL', titulo: 'Chuva nos El Niños de 1981–2025 (mediana)',
    classes: ANOM_CLASSES,
    valor: (P, H, im, ih, n) => H.campos.forteMed[ih][n],
  }),
]);

export const classeDe = (classes, v) => (v == null || !Number.isFinite(Number(v)) ? -1 : classes.findIndex((c) => Number(v) < c.max));

const sinal = (v, casas = 0, un = '%') => (v == null ? '' : `${v > 0 ? '+' : ''}${fmtNum(v, casas)}${un}`);
const mesDe = (ym) => Number(ym.slice(5, 7));
export const rotuloMes = (ym) => `${MES_CURTO[mesDe(ym) - 1]}/${ym.slice(2, 4)}`;

/** Fase e intensidade do ENSO pelo ONI (classes da NOAA). */
export function faseEnso(oni) {
  if (oni == null) return null;
  if (oni >= 2) return { text: 'EL NIÑO MUITO FORTE', tone: 'alert' };
  if (oni >= 1.5) return { text: 'EL NIÑO FORTE', tone: 'alert' };
  if (oni >= 1) return { text: 'EL NIÑO MODERADO', tone: 'warn' };
  if (oni >= 0.5) return { text: 'EL NIÑO FRACO', tone: 'warn' };
  if (oni <= -0.5) return { text: 'LA NIÑA', tone: 'info' };
  return { text: 'NEUTRO', tone: 'muted' };
}

/**
 * Leitura agronômica do mês para o PR (calendário de soja, milho, trigo e
 * feijão). Regras explícitas e conservadoras, não substituem o ZARC.
 */
export function leituraAgro(mes, { anom, pAcima, tAnom } = {}) {
  const umido = (anom != null && anom >= 25) || (pAcima != null && pAcima >= 60);
  const seco = anom != null && anom <= -15;
  const out = [];
  if (umido && [9, 10, 11].includes(mes)) {
    out.push('Excesso de chuva: risco à colheita e à qualidade do trigo, atraso e replantio na semeadura da soja '
      + 'e do milho verão. Aproveitar janelas secas e evitar máquinas em solo encharcado (compactação, erosão).');
  } else if (umido && [12, 1, 2].includes(mes)) {
    out.push('Umidade alta na fase reprodutiva: mais pressão de doenças (ferrugem asiática, mofo-branco); '
      + 'reforçar o monitoramento e o manejo de solo contra erosão.');
  } else if (umido && [3, 4, 5].includes(mes)) {
    out.push('Colheita da soja e semeadura da segunda safra sob chuva: risco de grão ardido e de atraso no milho safrinha.');
  } else if (umido) {
    out.push('Mês mais chuvoso que o normal: planejar operações de campo pelas janelas de tempo seco.');
  }
  if (seco && [12, 1, 2].includes(mes)) {
    out.push('Risco de veranico na floração e no enchimento de grãos da soja e do milho.');
  } else if (seco) {
    out.push('Mês mais seco que o normal: atenção à umidade do solo na semeadura.');
  }
  if (tAnom != null && tAnom >= 1) out.push('Calor acima do normal: mais demanda de água pelas plantas e estresse térmico na floração.');
  return out.length ? out : ['Sem desvio forte previsto: manter o calendário do ZARC.'];
}

/** Confiança 0-3 em texto. */
export function textoConfianca(c) {
  if (c == null) return '';
  return ['sem sinal claro no SEAS5', 'só o SEAS5 aponta o desvio', 'duas de três fontes concordam',
    'SEAS5, NMME e o histórico concordam'][c] ?? '';
}

// ------------------------------------------------------------------ estado

let P = null; // previsão
let H = null; // histórico
let celulasPick = [];
let params = { variavel: 'chuva', mes: 0 };
let legenda = [];

const varAtual = () => VARIAVEIS.find((v) => v.key === params.variavel) ?? VARIAVEIS[0];
const ihDe = (im) => H.meses.indexOf(mesDe(P.meses[im]));

/** Feições das células com a classe `c` e o véu `v` da variável e do mês ativos. */
export function elNinoFeatures(prev, hist, { variavel = 'chuva', mes = 0 } = {}) {
  const vari = VARIAVEIS.find((v) => v.key === variavel) ?? VARIAVEIS[0];
  const im = Math.min(mes, prev.meses.length - 1);
  const ih = hist.meses.indexOf(mesDe(prev.meses[im]));
  const pos = new Map(hist.celulas.map((k, n) => [k, n]));
  const counts = new Array(vari.classes.length).fill(0);
  const rCrit = hist.rCritico * (hist.escala?.r ?? 100);
  const features = gridCellFeatures(hist, (k) => pos.has(k)).flatMap((f) => {
    const n = pos.get(f.id);
    const c = classeDe(vari.classes, vari.valor(prev, hist, im, ih, n));
    if (c < 0) return [];
    counts[c] += 1;
    // A confiança é da chuva: a temperatura não ganha véu.
    let veu = false;
    if (vari.key === 'sinal') veu = Math.abs(hist.campos.r[ih][n] ?? 0) < rCrit;
    else if (vari.key !== 'temp') veu = (prev.campos.conf[im][n] ?? 0) <= 1;
    return [{ ...f, properties: { k: f.id, n, c, v: veu ? 1 : 0 } }];
  });
  return { features, counts };
}

function linhaMes(prev, im, n) {
  const c = prev.campos;
  const faixa = c.p10[im][n] == null ? '' : ` · ${c.p10[im][n]}–${c.p90[im][n]} mm`;
  const chance = c.pAcima[im][n] == null ? '' : ` · ${c.pAcima[im][n]}% de terço chuvoso`;
  return [rotuloMes(prev.meses[im]), `${c.esperado[im][n]} mm (${sinal(c.anom[im][n])})${faixa}${chance}`,
    (c.anom[im][n] ?? 0) >= 25 ? 'info' : null];
}

/** Tooltip da célula (n = posição em `celulas`) no mês im. */
export function elNinoTooltip(prev, hist, n, im, { cur = {}, k } = {}) {
  if (!prev || !hist || n == null) return '';
  const c = prev.campos;
  const h = hist.campos;
  const ih = hist.meses.indexOf(mesDe(prev.meses[im]));
  const esc = hist.escala ?? {};
  const oni = prev.enso?.oni?.at(-1);
  const roni = prev.enso?.roni?.at(-1);
  const r = h.r[ih][n] / (esc.r ?? 100);
  const rSig = Math.abs(r) >= hist.rCritico;
  const oniAtual = oni?.valor;
  const regressao = oniAtual == null ? null : Math.round((h.incl[ih][n] / (esc.incl ?? 1)) * oniAtual);
  const tAnom = c.tAnom[im][n] == null ? null : c.tAnom[im][n] / (prev.escala?.tAnom ?? 10);
  const mes = mesDe(prev.meses[im]);
  const lat = hist.bounds.south + Math.floor(k / hist.width) * hist.passoGraus;
  const lon = hist.bounds.west + (k % hist.width) * hist.passoGraus;
  return tipCard({
    icon: '🌊',
    title: cur.municipio || 'Perspectiva El Niño',
    subtitle: `${MES_NOME[mes - 1]} de ${prev.meses[im].slice(0, 4)} · célula de 0,1° (~11 km)`,
    badge: faseEnso(oniAtual),
    wide: true,
    rows: [
      ['Chuva esperada', `${c.esperado[im][n]} mm (${sinal(c.anom[im][n])} da normal)`, (c.anom[im][n] ?? 0) >= 25 ? 'info' : null],
      ['Faixa provável (p10–p90)', c.p10[im][n] == null ? '' : `${c.p10[im][n]} a ${c.p90[im][n]} mm (mediana ${c.p50[im][n]} mm)`],
      ['Normal 1991–2020', `${h.normal[ih][n]} mm`],
      ['Terço mais chuvoso (SEAS5)', c.pAcima[im][n] == null ? '' : `${c.pAcima[im][n]}% de chance (normal: 33%)`],
      ['Terço mais seco (SEAS5)', c.pAbaixo[im][n] == null ? '' : `${c.pAbaixo[im][n]}% de chance`],
      ['NMME (terço chuvoso / seco)', c.nmmeAcima[im][n] == null ? '' : `${c.nmmeAcima[im][n]}% / ${c.nmmeAbaixo[im][n]}%`],
      ['Temperatura', tAnom == null ? '' : `${sinal(tAnom, 1, ' °C')} da normal${c.nmmeTAcima[im][n] == null ? '' : ` · NMME ${c.nmmeTAcima[im][n]}% de terço quente`}`,
        tAnom != null && tAnom >= 1 ? 'warn' : null],
      ['Confiança', `${c.conf[im][n]}/3 · ${textoConfianca(c.conf[im][n])}`, c.conf[im][n] >= 2 ? 'ok' : 'muted'],
    ],
    sections: [
      {
        title: `Leitura para o campo em ${MES_NOME[mes - 1]}`,
        rows: leituraAgro(mes, { anom: c.anom[im][n], pAcima: c.pAcima[im][n], tAnom }).map((t, i) => [i ? '' : 'Atenção', t]),
      },
      {
        title: `O que o El Niño costuma fazer aqui em ${MES_NOME[mes - 1]} (1981–2025)`,
        rows: [
          ['Chuva nos El Niños', `${sinal(h.forteMed[ih][n])} (metade dos anos entre ${sinal(h.forteP25[ih][n])} e ${sinal(h.forteP75[ih][n])})`],
          ['Anos no terço chuvoso', `${h.forteAcima[ih][n]}% de ${hist.fortes.length} El Niños (normal: 33%)`],
          ['Correlação com o ONI', `r = ${fmtNum(r, 2)} ${rSig ? '(significativa)' : '(fraca, não significativa)'}`, rSig ? 'ok' : 'muted'],
          ['Pela regressão, com o ONI atual', regressao == null || !rSig ? '' : `${sinal(regressao)} de chuva`],
          ['Dias com ≥ 50 mm', `${fmtNum(h.h50Normal[ih][n] / (esc.h50Normal ?? 100), 1)} no normal · ${fmtNum(h.h50Forte[ih][n] / (esc.h50Forte ?? 100), 1)} nos El Niños`],
          ['Temperatura nos El Niños', h.tForte[ih][n] == null ? '' : sinal(h.tForte[ih][n] / (esc.tForte ?? 100), 1, ' °C')],
        ],
      },
      { title: 'Próximos meses', rows: prev.meses.map((_, i) => linhaMes(prev, i, n)) },
      {
        title: 'ENSO',
        rows: [
          ['ONI (oficial)', oni ? `${sinal(oni.valor, 2, '')} em ${oni.tri}/${oni.ano}` : ''],
          ['RONI (relativo)', roni ? `${sinal(roni.valor, 2, '')} em ${roni.tri}/${roni.ano}` : ''],
          ['Centro da célula', fmtCoord(lat, lon, 2)],
        ],
      },
    ],
    note: 'Perspectiva probabilística (modelo + histórico), não previsão do tempo. Faixa e chances vêm dos 51 membros '
      + 'do SEAS5 ajustados à normal observada; o mês corrente só tem a média.',
    source: 'ECMWF SEAS5 (Open-Meteo) · NMME e ONI (NOAA CPC) · CHIRPS · ERA5-Land',
    updated: prev.gerado,
  });
}

// ------------------------------------------------------------------ camada

function render(ctx) {
  if (!P || !H) return;
  const { features, counts } = elNinoFeatures(P, H, params);
  celulasPick = features;
  const vari = varAtual();
  legenda = counts.map((count, i) => ({ key: i, label: vari.classes[i].label, color: vari.classes[i].color, count }))
    .filter((l) => l.count > 0);
  // EXCESSO no mês corrente: os membros diários só cobrem meses completos.
  if (!features.length) legenda = [{ key: 'x', label: 'Sem dado neste mês: escolha um mês seguinte', color: '#94a3b8', count: 0 }];
  ctx.setData(SRC, fc(features));
}

async function carregar(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return resp.json();
}

export const elNinoLayer = defineLayer({
  id: ID,
  name: 'Perspectiva El Niño (6 meses)',
  category: 'Clima',
  icon: '🌊',
  source: 'SEAS5 · NMME · CHIRPS',
  sources: { [SRC]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: FILL,
      type: 'fill',
      source: SRC,
      paint: {
        'fill-color': ['match', ['get', 'c'], 0, '#000', '#000'], // trocada a cada render (setPaintProperty)
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.9, 0.75],
        // Sem contorno: a borda antialiasing desenhava a grade de 0,1° por cima do campo.
        'fill-antialias': false,
      },
    },
    {
      id: VEU,
      type: 'fill',
      source: SRC,
      // Sem 'dg:legenda': false: o filtro da legenda esconde o véu junto.
      filter: ['==', ['get', 'v'], 1],
      paint: { 'fill-color': '#9aa3ad', 'fill-opacity': 0.5 },
    },
  ],
  interactive: [FILL],
  legendFilter: 'c',
  underlay: true,
  refreshMs: 6 * 3600_000,
  onEnable(ctx) {
    trackCursor(ctx.map);
  },
  async load(ctx) {
    trackCursor(ctx.map);
    const [prev, hist] = await Promise.all([carregar('/data/el-nino-previsao-pr.json'), carregar('/data/el-nino-historico-pr.json')]);
    alinhados(prev, hist);
    [P, H] = [prev, hist];
    params = { ...params, mes: Math.min(params.mes, P.meses.length - 1) };
    pintar(ctx);
    const oni = P.enso?.oni?.at(-1);
    return {
      count: celulasPick.length,
      info: `${rotuloMes(P.meses[params.mes])}${oni ? ` · ONI ${oni.tri} ${sinal(oni.valor, 2, '')}` : ''}`,
    };
  },
  tooltip: (p, _f, ctx) => elNinoTooltip(P, H, Number(p.n), Math.min(params.mes, (P?.meses.length ?? 1) - 1),
    { cur: cursorContext(ctx), k: Number(p.k) }),
  rowControls: () => ({
    chips: [
      ...VARIAVEIS.map((v) => ({ id: `v-${v.key}`, label: v.chip, active: v.key === params.variavel })),
      ...(P?.meses ?? []).map((m, i) => ({ id: `m-${i}`, label: MES_CURTO[mesDe(m) - 1], active: i === params.mes })),
    ],
    legend: legenda,
  }),
  onChip(chipId, ctx) {
    const [tipo, valor] = String(chipId).split('-');
    if (tipo === 'v' && VARIAVEIS.some((v) => v.key === valor)) params = { ...params, variavel: valor };
    else if (tipo === 'm' && Number.isInteger(Number(valor))) params = { ...params, mes: Number(valor) };
    else return;
    ctx.setLegendHidden?.(ID, []);
    pintar(ctx);
  },
});

/**
 * A previsão é indexada pela posição em `hist.celulas`: arquivos de gerações
 * diferentes (cache, commit parcial) pintariam a célula errada sem erro.
 */
export function alinhados(prev, hist) {
  const ref = prev?.historico;
  if (!ref || ref.nCelulas !== hist?.celulas?.length || ref.gerado !== hist.gerado) {
    throw new Error('previsão e histórico do El Niño fora de sincronia; regenere a previsão');
  }
  return true;
}

/** Cor da variável ativa + dados. */
function pintar(ctx) {
  const vari = varAtual();
  ctx.map?.getLayer?.(FILL) && ctx.map.setPaintProperty(FILL, 'fill-color',
    ['match', ['get', 'c'], ...vari.classes.flatMap((cl, i) => [i, cl.color]), '#94a3b8']);
  render(ctx);
}

export default [elNinoLayer];
