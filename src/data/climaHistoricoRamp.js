// src/data/climaHistoricoRamp.js
//
// Indicadores e escalas de cor da camada de clima historico (BR-DWGD). Registro
// unico, no formato de precipitacaoRamp.js: chip, preenchimento no mapa e
// legenda leem a MESMA tabela.
//
// POR QUE CIVIDIS, E NAO VIRIDIS
//
// O app ja gastou quase todas as familias de cor: ciano e dos municipios e do
// vento, violeta/fucsia da precipitacao ao vivo, verde/lima da conectividade,
// amarelo-laranja-vermelho do FIRMS e da severidade. Viridis passa por violeta,
// ciano e lima, ou seja, colide com tres camadas. Cividis (Nunez et al. 2018) vai
// de azul-marinho a cinza e ocre: foi desenhada para ser igual sob protanopia e
// deuteranopia e nao entra em nenhuma dessas familias. O topo PARA num ocre
// dessaturado (#c9b86a) em vez do amarelo #ffe945 original, para nao ler como
// foco de calor.
//
// Indicadores de sinal (balanco hidrico) usam divergente marrom <-> azul-marinho
// com cinza no zero: deficit e marrom, excedente e azul, e o zero e neutro.
//
// As QUEBRAS nao moram aqui: vem do JSON (quantis calculados no build), para a
// legenda sempre caber no dado real, qualquer que seja a regeneracao.

const SEQ = Object.freeze(['#1d2f5c', '#44506e', '#75757a', '#a39875', '#c9b86a']);
const DIV = Object.freeze(['#7a4a12', '#b0844a', '#8f8f8f', '#4d6a96', '#1f3a73']);

/** Opacidade unica do campo: o basemap tem que continuar legivel por baixo. */
export const CAMPO_ALPHA = 0.62;

export const INDICADORES = Object.freeze([
  Object.freeze({ key: 'pr', chip: 'CHUVA', unidade: 'mm/ano', casas: 0, rampa: SEQ,
    titulo: 'Chuva anual média, normal 1990–2019' }),
  Object.freeze({ key: 'tmed', chip: 'TEMP', unidade: '°C', casas: 1, rampa: SEQ,
    titulo: 'Temperatura média anual, normal 1990–2019' }),
  Object.freeze({ key: 'geada3', chip: 'GEADA', unidade: 'dias/ano', casas: 0, rampa: SEQ,
    titulo: 'Dias por ano com Tmín ≤ 3 °C (geada provável), normal 1990–2019' }),
  Object.freeze({ key: 'balanco', chip: 'BALANÇO', unidade: 'mm/ano', casas: 0, rampa: DIV, divergente: true,
    titulo: 'Balanço hídrico climático P − ETo, normal 1990–2019' }),
  Object.freeze({ key: 'calor35', chip: 'CALOR', unidade: 'dias/ano', casas: 0, rampa: SEQ,
    titulo: 'Dias por ano com Tmáx ≥ 35 °C, normal 1990–2019' }),
  Object.freeze({ key: 'tendTmed', chip: 'ΔT/DÉC', unidade: '°C/década', casas: 2, rampa: SEQ,
    titulo: 'Tendência da temperatura média 1961–2019 (°C por década)' }),
]);

export const INDICADOR_PADRAO = 'pr';

export function indicador(key) {
  return INDICADORES.find((i) => i.key === key) || INDICADORES[0];
}

function hexBytes(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * Classe (0..n) de um valor dadas as quebras crescentes. So vale para os
 * sequenciais: as quebras por quantil nao garantem o zero, entao o divergente
 * classifica pelo SINAL (ver corDe).
 * @param {number} value
 * @param {number[]} quebras
 */
export function classeDe(value, quebras) {
  let k = 0;
  while (k < quebras.length && value >= quebras[k]) k += 1;
  return k;
}

/**
 * Valor -> [r,g,b,a] 0-255, ou transparente para celula sem dado.
 * Sequencial: 5 classes por quantil. Divergente: negativos nos dois marrons,
 * |valor| pequeno no cinza, positivos nos dois azuis, com o limiar do cinza em
 * 10% do maior modulo, para "quase zero" nao ganhar cor de extremo.
 * @param {number|null} value
 * @param {object} ind entrada de INDICADORES
 * @param {number[]} quebras
 * @param {number} [maxAbs]
 */
export function corDe(value, ind, quebras, maxAbs = 0) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return [0, 0, 0, 0];
  const v = Number(value);
  let idx;
  if (ind.divergente) {
    const neutro = Math.max(1e-9, 0.1 * maxAbs);
    if (Math.abs(v) < neutro) idx = 2;
    else if (v < 0) idx = v < -0.5 * maxAbs ? 0 : 1;
    else idx = v > 0.5 * maxAbs ? 4 : 3;
  } else {
    idx = Math.min(ind.rampa.length - 1, classeDe(v, quebras));
  }
  return [...hexBytes(ind.rampa[idx]), Math.round(255 * CAMPO_ALPHA)];
}

const fmt = (v, casas) => Number(v).toLocaleString('pt-BR', {
  minimumFractionDigits: casas, maximumFractionDigits: casas,
});

/**
 * Legenda no contrato do manager ({label, color, blurb, count}). Classes sem
 * celula ficam de fora: a legenda nunca anuncia o que nao esta na tela.
 * @param {Array<number|null>} valores
 * @param {object} ind
 * @param {number[]} quebras
 */
export function legendaDe(valores, ind, quebras) {
  const maxAbs = maiorModulo(valores);
  const counts = new Array(ind.rampa.length).fill(0);
  for (const value of valores) {
    if (value === null || value === undefined) continue;
    const [r, g, b] = corDe(value, ind, quebras, maxAbs);
    const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    counts[ind.rampa.indexOf(hex)] += 1;
  }
  const rotulos = ind.divergente
    ? ['DÉFICIT ALTO', 'DÉFICIT', '≈ 0', 'EXCEDENTE', 'EXCEDENTE ALTO']
    : ind.rampa.map((_, k) => {
      if (k === 0) return `< ${fmt(quebras[0], ind.casas)}`;
      if (k >= quebras.length) return `≥ ${fmt(quebras[quebras.length - 1], ind.casas)}`;
      return `${fmt(quebras[k - 1], ind.casas)}–${fmt(quebras[k], ind.casas)}`;
    });
  return ind.rampa
    .map((color, k) => ({ label: rotulos[k], color, blurb: `${rotulos[k]} ${ind.unidade}`, count: counts[k] }))
    .filter((item) => item.count > 0);
}

export function maiorModulo(valores) {
  let m = 0;
  for (const v of valores) if (v !== null && v !== undefined && Math.abs(v) > m) m = Math.abs(v);
  return m;
}
