// src/maplibre/layers/redeCopel.js
//
// Transformadores e postes da rede de distribuição da Copel (BDGD 2022,
// ANEEL), a mesma base das linhas de média tensão. PMTiles estáticos
// (scripts/build_rede_copel_pontos.py) lidos por HTTP Range: transformadores
// a partir do zoom 10, postes a partir do 13. Atributos em códigos da BDGD;
// os rótulos ficam aqui. Só equipamento da rede, nenhuma unidade consumidora.
// Sem realce no hover: o MVT do GDAL sai sem id de feição (feature-state não pega).

import { defineLayer, fmtNum, tipCard } from '../kit.js';

const CATEGORY = 'Energia e conectividade';
const FONTE = 'ANEEL · BDGD COPEL-DIS 2022-12-31 V11';
const txt = (v) => String(v ?? '').trim();
const rotulo = (tabela, v) => tabela[txt(v)] ?? (txt(v) && txt(v) !== '0' ? txt(v) : '');
const AREA = { UB: 'Urbana', NU: 'Rural (não urbana)' };

// --- transformadores ---------------------------------------------------------

/** TIP_TRAFO -> legenda (cor por tipo: o trifásico é o que interessa à agroindústria). */
export const TIPOS_TRAFO = Object.freeze([
  { key: 'T', label: 'Trifásico', color: '#f97316' },
  { key: 'MT', label: 'Monofásico a três fios', color: '#facc15' },
  { key: 'M', label: 'Monofásico', color: '#38bdf8' },
]);
const TIPO_TRAFO = Object.fromEntries(TIPOS_TRAFO.map((t) => [t.key, t.label]));

export function trafoTooltip(p) {
  const kva = Number(p.kva);
  return tipCard({
    icon: '🔋',
    title: `Transformador ${Number.isFinite(kva) && kva > 0 ? `${fmtNum(kva, kva % 1 ? 1 : 0)} kVA` : ''}`.trim(),
    subtitle: [rotulo(TIPO_TRAFO, p.tipo), AREA[txt(p.area)]].filter(Boolean).join(' · '),
    rows: [['Fases no primário', txt(p.fases)]],
    source: `${FONTE} (UNTRMT)`,
  });
}

const TRAFO_SRC = 'dg-copel-transformadores';
export const transformadoresLayer = defineLayer({
  id: 'datageo-copel-transformadores',
  name: 'Transformadores · Copel',
  category: CATEGORY,
  icon: '🔋',
  source: `${FONTE} (458 mil) · a partir do zoom 10`,
  sources: { [TRAFO_SRC]: { type: 'vector', url: 'pmtiles:///data/copel-transformadores.pmtiles', attribution: 'ANEEL/BDGD (Copel)' } },
  layers: [
    { id: `${TRAFO_SRC}-pt`, type: 'circle', source: TRAFO_SRC, 'source-layer': 'trafos', minzoom: 10,
      paint: {
        'circle-color': ['match', ['get', 'tipo'], ...TIPOS_TRAFO.flatMap((t) => [t.key, t.color]), '#94a3b8'],
        // Raio cresce com a potência (10 kVA pequeno, 112,5+ kVA graúdo).
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          10, ['interpolate', ['linear'], ['get', 'kva'], 10, 1.5, 150, 3.5],
          15, ['interpolate', ['linear'], ['get', 'kva'], 10, 4, 150, 9]],
        'circle-stroke-color': '#0f172a',
        'circle-stroke-width': 0.6,
      } },
  ],
  interactive: [`${TRAFO_SRC}-pt`],
  legendFilter: 'tipo',
  tooltip: (p) => trafoTooltip(p),
  rowControls: () => ({ legend: TIPOS_TRAFO.map(({ key, label, color }) => ({ key, label, color })) }),
});

// --- postes --------------------------------------------------------------------

export const TIPO_PN = Object.freeze({
  POS: 'Poste', DRV: 'Derivação', FLT: 'Ponto flutuante', TOR: 'Torre', PIS: 'Pórtico', PSU: 'Subestação',
});
// MT não é madeira: são as ~16 mil torres (TIP_PN TOR), altura mediana 34 m; lido
// como metálico. ALT confere com metros (postes com mediana de 11 m).
export const MATERIAL = Object.freeze({
  CO: 'Concreto', MT: 'Metálico', FE: 'Ferro', AC: 'Aço',
});
export const MATERIAIS_POSTE = Object.freeze([
  { key: 'CO', label: 'Concreto', color: '#cbd5e1' },
  { key: 'MT', label: 'Metálico (torres)', color: '#f59e0b' },
  { key: 'outros', label: 'Outros / sem material', color: '#64748b' },
]);

export function posteTooltip(p) {
  const alt = Number(p.alt);
  return tipCard({
    icon: '🗼',
    title: rotulo(TIPO_PN, p.tipo) || 'Ponto da rede',
    subtitle: rotulo(MATERIAL, p.mat),
    rows: [
      ['Altura', Number.isFinite(alt) && alt > 0 ? `${alt} m` : ''],
      ['Esforço (código BDGD)', txt(p.esf) !== '0' ? txt(p.esf) : ''],
      ['Estrutura (código BDGD)', txt(p.estr) !== '0' ? txt(p.estr) : ''],
    ],
    source: `${FONTE} (PONNOT)`,
  });
}

const POSTE_SRC = 'dg-copel-postes';
const corMaterial = ['match', ['get', 'mat'], ...MATERIAIS_POSTE.slice(0, -1).flatMap((m) => [m.key, m.color]), MATERIAIS_POSTE.at(-1).color];
export const postesLayer = defineLayer({
  id: 'datageo-copel-postes',
  name: 'Postes · Copel',
  category: CATEGORY,
  icon: '🗼',
  source: `${FONTE} (3,75 milhões) · a partir do zoom 13`,
  sources: { [POSTE_SRC]: { type: 'vector', url: 'pmtiles:///data/copel-postes.pmtiles', attribution: 'ANEEL/BDGD (Copel)' } },
  layers: [
    { id: `${POSTE_SRC}-pt`, type: 'circle', source: POSTE_SRC, 'source-layer': 'postes', minzoom: 13,
      paint: {
        'circle-color': corMaterial,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.6, 17, 4.5],
        'circle-stroke-color': '#0f172a',
        'circle-stroke-width': 0.4,
      } },
  ],
  interactive: [`${POSTE_SRC}-pt`],
  tooltip: (p) => posteTooltip(p),
  rowControls: () => ({ legend: MATERIAIS_POSTE.map(({ label, color }) => ({ label, color })) }),
});

export default [transformadoresLayer, postesLayer];
