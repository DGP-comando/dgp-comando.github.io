// src/data/energiaLogisticaEstilos.js
//
// Estilo e tooltip dos pontos de Infraestrutura (subestações, usinas) e de
// Logística agro (armazéns, agroindústrias, cadastro IDR, rotas turísticas,
// CEASAs), SEM dependência de engine de mapa: usado pelas camadas Cesium
// (datageoEnergia.js / datageoLogistica.js, que convertem a cor) e pelo
// protótipo MapLibre (src/maplibre/layers/energiaLogistica.js).
//
// Cada `*Estilo(props)` devolve {grupo, size, color, alpha, label,
// labelMaxDist} com a cor em CSS (#rrggbb) + alpha separado, ou null para o
// ponto ser ignorado. `size` é o diâmetro em px; `labelMaxDist` a distância
// (m) da câmera acima da qual o rótulo some.

import { escapeHtml } from './vesselTooltip.js';

// ---------------------------------------------------------------- energia

/** Cores das linhas de transmissão e subestações por classe (CSS + alpha). */
export const ENERGIA_CORES = Object.freeze({
  kv525: Object.freeze({ css: '#c084fc', alpha: 0.9 }),
  kv230: Object.freeze({ css: '#38bdf8', alpha: 0.75 }),
  baixa: Object.freeze({ css: '#94a3b8', alpha: 0.55 }),
  planejada: Object.freeze({ css: '#fbbf24', alpha: 0.9 }),
});

/** Classe da linha de transmissão: planejada, >= 500 kV, >= 230 kV ou menor. */
export function linhaTransmissaoClasse(props = {}) {
  if (props.planejada) return 'planejada';
  const kv = Number(props.tensao) || 0;
  if (kv >= 500) return 'kv525';
  if (kv >= 230) return 'kv230';
  return 'baixa';
}

export function subestacaoEstilo(p) {
  return {
    grupo: p.planejada ? 'planejada' : 'existente',
    size: p.planejada ? 9 : 7,
    color: p.planejada ? ENERGIA_CORES.planejada.css : '#38bdf8',
    alpha: p.planejada ? ENERGIA_CORES.planejada.alpha : 1,
    label: p.planejada
      ? `${p.nome} (prevista ${p.ano ?? '?'}) · ${p.tensao ?? ''} kV`
      : `${p.nome} · ${p.tensao ?? ''} kV`,
    labelMaxDist: p.planejada ? 900_000 : 250_000,
  };
}

export const SUBESTACAO_LEGENDA = Object.freeze([
  { grupo: 'existente', label: 'Existente', color: '#38bdf8' },
  { grupo: 'planejada', label: 'Prevista', color: '#fbbf24' },
]);

// Usinas SIGEL/ANEEL por tipo + aerogeradores individuais (torres) num
// mesmo layer: cor por fonte, tamanho por potencia; aerogeradores so
// aparecem de perto (sao detalhe dos parques eolicos, ja presentes como
// usina 'eol').
export const USINA_STYLE = Object.freeze({
  uhe: { cor: '#3b82f6', rotulo: 'UHE', base: 8 },
  pch: { cor: '#7dd3fc', rotulo: 'PCH', base: 5 },
  cgh: { cor: '#2dd4bf', rotulo: 'CGH', base: 4 },
  ute: { cor: '#fb923c', rotulo: 'UTE', base: 5.5 },
  eol: { cor: '#f8fafc', rotulo: 'EOL', base: 7 },
  ufv: { cor: '#fde047', rotulo: 'UFV', base: 6 },
});

export const fmtMw = (kw) => (kw ? `${(kw / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MW` : '');

export function usinaEstilo(p) {
  if (p.tipo === 'aerogerador') {
    return {
      grupo: 'aerogerador',
      size: 3.5,
      color: '#ffffff',
      alpha: 0.85,
      label: `Aerogerador ${p.nome}${p.alt ? ` · ${p.alt} m` : ''}`,
      labelMaxDist: 60_000,
    };
  }
  const s = USINA_STYLE[p.tipo];
  if (!s) return null;
  const mw = (Number(p.pot_kw) || 0) / 1000;
  return {
    grupo: p.tipo,
    size: mw >= 500 ? s.base + 5 : mw >= 50 ? s.base + 2 : s.base,
    color: s.cor,
    alpha: 0.9,
    label: `${s.rotulo} ${p.nome}${p.pot_kw ? ` · ${fmtMw(p.pot_kw)}` : ''}`,
    labelMaxDist: mw >= 500 ? 1_500_000 : mw >= 50 ? 400_000 : 130_000,
  };
}

export const USINA_LEGENDA = Object.freeze([
  ...Object.entries(USINA_STYLE).map(([grupo, s]) => ({ grupo, label: s.rotulo, color: s.cor })),
  { grupo: 'aerogerador', label: 'Aerogerador', color: '#ffffff' },
]);

// ------------------------------------------------------------- logística

export const fmtCap = (t) => {
  if (!t) return '';
  if (t >= 1000) return ` · ${Math.round(t / 1000)} mil t`;
  return ` · ${t} t`;
};

export function armazemEstilo(p) {
  if (p.kind === 'porto') {
    return { grupo: 'porto', size: 12, color: '#f97316', alpha: 1, label: p.nome, labelMaxDist: 2_000_000 };
  }
  const cap = Number(p.cap_t) || 0;
  return {
    grupo: 'armazem',
    // Capacidade dita o tamanho: silos grandes saltam na visão regional.
    size: cap >= 50_000 ? 7 : cap >= 10_000 ? 5 : 3.5,
    color: '#fbbf24',
    alpha: 0.85,
    label: `${p.nome}${fmtCap(cap)}`,
    labelMaxDist: 45_000,
  };
}

export const ARMAZEM_LEGENDA = Object.freeze([
  { grupo: 'armazem', label: 'Armazém', color: '#fbbf24' },
  { grupo: 'porto', label: 'Porto', color: '#f97316' },
]);

export const AGRO_STYLE = Object.freeze({
  frigorifico: { color: '#ef4444', size: 8, rotulo: 'Frigorífico', fonte: 'SIGSIF/MAPA' },
  laticinio: { color: '#bfdbfe', size: 5.5, rotulo: 'Laticínio', fonte: 'SIGSIF/MAPA' },
  serraria: { color: '#b45309', size: 5.5, rotulo: 'Serraria', fonte: 'OpenStreetMap' },
});

export function agroindustriaEstilo(p) {
  const s = AGRO_STYLE[p.kind];
  if (!s) return null;
  return { grupo: p.kind, size: s.size, color: s.color, alpha: 0.9, label: `${s.rotulo}: ${p.nome}`, labelMaxDist: 120_000 };
}

export const AGRO_LEGENDA = Object.freeze(
  Object.entries(AGRO_STYLE).map(([grupo, s]) => ({ grupo, label: s.rotulo, color: s.color })),
);

export function agroindustriaTooltipHtml(p) {
  const s = AGRO_STYLE[p.kind];
  if (!s) return '';
  return [
    `<div class="vt-nome">🏭 ${escapeHtml(p.nome)}</div>`,
    `<div>${s.rotulo}</div>`,
    p.municipio ? `<div>${escapeHtml(p.municipio)} - PR</div>` : '',
    `<div class="vt-fontes">Fonte: ${s.fonte}</div>`,
  ].join('');
}

// Cadastro IDR: cada propriedade do GeoJSON já é um rótulo legível
// (scripts/build_agroindustrias_idr.py), então o tooltip lista todas.
const IDR_TITULO = new Set(['id', 'Agroindústria', 'Município']);
export function agroindustriaIdrTooltipHtml(p) {
  const linhas = Object.entries(p)
    .filter(([k]) => !IDR_TITULO.has(k))
    .map(([k, v]) => `<div><span class="vt-dim">${escapeHtml(k)}:</span> ${escapeHtml(v)}</div>`);
  return `<div class="vt-nome">🧺 ${escapeHtml(p['Agroindústria'] ?? 'Agroindústria')}</div>`
    + `<div>${escapeHtml(p['Município'] ?? '')} - PR</div>`
    + `<div style="columns:2;column-gap:14px;margin-top:4px;font-size:10px">${linhas.join('')}</div>`
    + '<div class="vt-fontes">Fonte: IDR-Paraná, diagnóstico das agroindústrias 2023 e cadastro GETEC</div>';
}

export const IDR_GRUPOS = Object.freeze([
  { grupo: 'vegetal', label: 'Origem vegetal', color: '#4ade80' },
  { grupo: 'animal', label: 'Origem animal', color: '#f472b6' },
  { grupo: 'mista', label: 'Vegetal e animal', color: '#c084fc' },
]);
const IDR_COR = Object.fromEntries(IDR_GRUPOS.map((g) => [g.grupo, g.color]));

// Matéria-prima do diagnóstico ou, no ponto só do GETEC, o tipo (Vegetal/Animal/Mista).
export const idrGrupo = (mp = '') => {
  const animal = mp.includes('Animal') || mp.includes('Mista');
  const vegetal = mp.includes('Vegetal') || mp.includes('Mista');
  if (animal && vegetal) return 'mista';
  return animal ? 'animal' : 'vegetal';
};

export function agroindustriaIdrEstilo(p) {
  const grupo = idrGrupo(p['Matéria-prima'] ?? p['GETEC · Tipo']);
  return { grupo, size: 6, color: IDR_COR[grupo], alpha: 0.9, label: p['Agroindústria'], labelMaxDist: 40_000 };
}

export const ROTA_STYLE = Object.freeze({
  'Rota do Queijo Paranaense': { color: '#facc15', icon: '🧀' },
  'Rota da Uva e do Vinho': { color: '#a855f7', icon: '🍇' },
});

export function rotaTuristicaTooltipHtml(p) {
  const s = ROTA_STYLE[p.rota] ?? { icon: '📍' };
  const desc = escapeHtml(p.descricao ?? '').replace(/\n/g, '<br>');
  return `<div class="vt-nome">${s.icon} ${escapeHtml(p.nome)}</div>`
    + `<div class="vt-berco">${escapeHtml(p.rota)}</div>`
    + (desc ? `<div style="margin-top:4px">${desc}</div>` : '');
}

export function rotaTuristicaEstilo(p) {
  return { grupo: p.rota, size: 9, color: ROTA_STYLE[p.rota]?.color ?? '#e2e8f0', alpha: 1, label: p.nome, labelMaxDist: 150_000 };
}

export const ROTA_LEGENDA = Object.freeze(
  Object.entries(ROTA_STYLE).map(([grupo, s]) => ({ grupo, label: grupo, color: s.color })),
);

export function ceasaEstilo(p) {
  // So 5 unidades: label sempre visivel na visao estadual.
  return { grupo: 'ceasa', size: 11, color: '#22c55e', alpha: 1, label: p.nome, labelMaxDist: 2_500_000 };
}

export const CEASA_LEGENDA = Object.freeze([{ grupo: 'ceasa', label: 'CEASA', color: '#22c55e' }]);

// ------------------------------------------------------------ distribuição

/** Cor (CSS + alpha) e largura por tensão nominal (kV) da rede de média tensão. */
export const DISTRIBUICAO_KV = Object.freeze({
  34.5: Object.freeze({ css: '#fb7185', alpha: 0.8, width: 1.6 }),
  13.8: Object.freeze({ css: '#34d399', alpha: 0.7, width: 1.1 }),
});
