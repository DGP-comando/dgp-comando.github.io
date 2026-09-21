// src/data/torreCobertura.js
//
// Tooltip e área de cobertura ESTIMADA de uma torre (ERB) da camada
// Conectividade. O levantamento (IDR-PR sobre o licenciamento ANATEL) traz
// posição, operadora e tecnologias, mas não altura, potência nem azimute: não
// há como desenhar a cobertura real de UMA torre. O que se desenha é o alcance
// NOMINAL de uma macrocélula rural em cada faixa usada no Brasil, um anel por
// geração que a torre oferece, e o tooltip diz com todas as letras que é
// estimativa. A mancha cinza da camada (área sem 3G+) segue sendo o dado
// medido; os anéis só ajudam a ler de onde o sinal sai.
//
// Puro (sem Cesium): testável em node.

import { escapeHtml } from './vesselTooltip.js';

/**
 * Alcance nominal por geração, em km, macrocélula em área rural:
 *   2G — GSM 850/900 MHz, faixa baixa e modulação robusta: dezenas de km;
 *   3G — WCDMA 850 MHz / 2,1 GHz;
 *   4G — LTE, no interior do PR sobretudo 700 MHz, que vai mais longe que o 3G;
 *   5G — NR 3,5 GHz: célula pequena, pouco mais de 1 km.
 * Relevo, altura da antena, potência e carga mudam o alcance real para mais ou
 * para menos; em cidade a célula é bem menor que isto.
 */
export const ALCANCE_NOMINAL_KM = Object.freeze({ '2G': 15, '3G': 7, '4G': 9, '5G': 1.5 });
const TEC_ORDEM = Object.freeze([['5G', 8], ['4G', 4], ['3G', 2], ['2G', 1]]);

/** Gerações da máscara de bits, da mais nova para a mais antiga. */
export function tecnologias(mask) {
  const bits = Number(mask) || 0;
  return TEC_ORDEM.filter(([, bit]) => bits & bit).map(([tec]) => tec);
}

/**
 * Anéis a desenhar, do MAIOR para o menor (o menor por cima, visível).
 * @returns {{tec: string, km: number}[]}
 */
export function aneisDeCobertura(mask) {
  return tecnologias(mask)
    .map((tec) => ({ tec, km: ALCANCE_NOMINAL_KM[tec] }))
    .sort((a, b) => b.km - a.km);
}

/** Chave de estrutura compartilhada: ~11 m de tolerância (4 casas decimais). */
export function chaveDeSite(lat, lon) {
  return `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

const kmFmt = (km) => `${String(km).replace('.', ',')} km`;

/**
 * HTML do tooltip. `props`: {operadora, mask, municipio, lat, lon, vizinhas,
 * vintage}, onde `vizinhas` são as outras operadoras na mesma estrutura.
 */
export function torreTooltipHtml(props) {
  const tecs = tecnologias(props.mask);
  const aneis = aneisDeCobertura(props.mask);
  const linhas = [
    `<div class="vt-nome">📡 ${escapeHtml(props.operadora)} · ${escapeHtml(tecs.join(' / ') || 'sem tecnologia declarada')}</div>`,
  ];
  if (props.municipio) linhas.push(`<div>${escapeHtml(props.municipio)} - PR</div>`);
  if (props.vizinhas?.length) {
    linhas.push(`<div>Mesma estrutura: ${props.vizinhas.map(escapeHtml).join(', ')}</div>`);
  }
  if (aneis.length) {
    const alcance = tecs.map((tec) => `${tec} ${kmFmt(ALCANCE_NOMINAL_KM[tec])}`).join(' · ');
    linhas.push(`<div>Alcance nominal: ${alcance}</div>`);
  }
  linhas.push(`<div class="vt-dim">${Number(props.lat).toFixed(5)}, ${Number(props.lon).toFixed(5)}</div>`);
  linhas.push(`<div class="vt-dim">Anéis = alcance ESTIMADO de macrocélula rural, não medição;`
    + ` a mancha cinza é a área sem 3G+ medida. Levantamento ANATEL ${escapeHtml(props.vintage ?? '')}</div>`);
  return linhas.join('');
}
