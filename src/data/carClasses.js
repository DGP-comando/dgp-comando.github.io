// src/data/carClasses.js
//
// Estilo das divisas do CAR por CLASSE DE MÓDULOS FISCAIS (ver o cabeçalho de
// datageoCar.js), sem dependência de engine de mapa: usado pela camada Cesium
// e pelo protótipo MapLibre (src/maplibre/layers/territorios.js).
//
// Escala sequencial por porte: claro e fino nos pequenos (que são a maioria e
// virariam uma mancha se tivessem o mesmo peso), forte e grosso nos grandes.
// `width` em pixels de tela.

import { fmtInt, fmtNum, fmtPct, tipCard } from '../maplibre/tooltipCard.js';

export const CAR_CLASSE_STYLES = Object.freeze({
  '0-4': Object.freeze({ css: '#fef08a', alpha: 0.45, width: 0.8 }),
  '4-10': Object.freeze({ css: '#fde047', alpha: 0.55, width: 1.0 }),
  '10-20': Object.freeze({ css: '#fb923c', alpha: 0.65, width: 1.2 }),
  '20-50': Object.freeze({ css: '#f97316', alpha: 0.75, width: 1.4 }),
  '>50': Object.freeze({ css: '#ef4444', alpha: 0.85, width: 1.8 }),
});

/** Teto de altura de câmera (m) da camada: o enquadramento de um município. */
export const CAR_MAX_HEIGHT = 90_000;

// ------------------------------------------------------------------ tooltip

/** Faixa legível da classe de módulos fiscais. */
export const CAR_CLASSE_FAIXA = Object.freeze({
  '0-4': 'até 4 módulos fiscais',
  '4-10': '4 a 10 módulos fiscais',
  '10-20': '10 a 20 módulos fiscais',
  '20-50': '20 a 50 módulos fiscais',
  '>50': 'mais de 50 módulos fiscais',
});

// Porte fundiário da Lei 8.629/1993: pequena até 4 MF, média de 4 a 15, grande
// acima de 15. A classe 10-20 atravessa o limite de 15 MF.
const PORTE = Object.freeze({
  '0-4': { text: 'Pequena propriedade', tone: 'ok' },
  '4-10': { text: 'Média propriedade', tone: 'info' },
  '10-20': { text: 'Média a grande', tone: 'warn' },
  '20-50': { text: 'Grande propriedade', tone: 'alert' },
  '>50': { text: 'Grande propriedade', tone: 'alert' },
});

/**
 * Tooltip de uma divisa do CAR. As células fatiadas só guardam a CLASSE de
 * módulos fiscais de cada trecho; o resto vem do agregado car-municipios.json
 * (`stats`), para o estado e para o município sob o cursor (`municipio`).
 * @param {string} classe
 * @param {{stats?: object|null, municipio?: {ibge: string, nome: string}|null}} [x]
 */
export function carTooltip(classe, { stats = null, municipio = null } = {}) {
  const k = stats?.classes?.indexOf(classe) ?? -1;
  const porte = PORTE[classe];
  const mun = municipio && k >= 0 ? stats?.municipios?.[String(municipio.ibge)] : null;
  const est = k >= 0 ? stats?.estado : null;
  const soma = (arr) => (arr ?? []).reduce((a, b) => a + (Number(b) || 0), 0);
  const linhas = (o) => {
    if (!o) return [];
    const n = Number(o.n?.[k]) || 0;
    const tot = soma(o.n);
    return [
      ['Imóveis na classe', n ? `${fmtInt(n)}${tot ? ` de ${fmtInt(tot)} (${fmtPct(n / tot, 1)})` : ''}` : '0'],
      ['Área declarada', Number(o.ha?.[k]) > 0 ? `${fmtInt(o.ha[k], 'ha')}${soma(o.ha) ? ` (${fmtPct(o.ha[k] / soma(o.ha), 1)} da área)` : ''}` : ''],
      ['Média por imóvel', n && Number(o.ha?.[k]) > 0 ? fmtNum(o.ha[k] / n, 1, 'ha') : ''],
    ];
  };
  return tipCard({
    icon: '🌱',
    title: 'Imóvel rural (CAR)',
    subtitle: `Divisa de imóvel ativo · ${CAR_CLASSE_FAIXA[classe] ?? classe}`,
    badge: porte ?? null,
    rows: [
      ['Porte', CAR_CLASSE_FAIXA[classe] ?? classe],
      ['Situação', 'Ativo no SICAR'],
    ],
    sections: [
      { title: municipio?.nome ? `Em ${municipio.nome}` : 'No município', rows: linhas(mun) },
      { title: 'No Paraná', rows: linhas(est) },
    ],
    note: 'A malha fatiada guarda só a classe de cada divisa; código, área e situação do imóvel individual ficam no SICAR.',
    source: 'SICAR/SFB · DataGeo PR',
    updated: stats?.geradoEm ?? null,
  });
}
