// src/data/programasIdrEstilos.js
//
// Estilo, legenda e tooltip das Unidades de Referência (URs) dos programas do
// IDR-Paraná (Grãos, Café, Piscicultura, Pecuária de Corte). Camadas em
// src/maplibre/layers/programasIdr.js; dados em data/privado/ (bucket
// datageo-privado, nome do produtor) gerados por
// scripts/build_urs_programas.py.
//
// `*Estilo(props)` segue o contrato de energiaLogisticaEstilos.js:
// {grupo, size, color, alpha, label, labelMaxDist}. Cores escolhidas com
// ΔE76 >= 30 entre si, contra Agroindústrias IDR, Rotas turísticas e o ciano
// das divisas; cada programa tem ainda contorno próprio (UR_CONTORNO), para o
// ponto não depender só da cor. Ponto com coordenada que
// não confere com o município (ou posto no centro dele por falta de
// coordenada) sai esmaecido; o tooltip diz o motivo.

import { tipCard } from '../maplibre/tooltipCard.js';

/** Checagens que valem como coordenada conferida. */
const CONFERIDA = new Set(['no município declarado', 'município pelo ponto (planilha sem município)']);
export const coordenadaConferida = (p) => CONFERIDA.has(p['Checagem da coordenada'] ?? '');

/** Teto (m de altura) dos rótulos de todas as camadas de URs. */
export const UR_LABEL_DIST = 40_000;

/** Contorno do círculo por programa (makePointsLayer `stroke`): cor e largura distintas. */
export const UR_CONTORNO = Object.freeze({
  graos: { color: '#ffffff', width: 1.5 },
  cafe: { color: '#fde68a', width: 2.5 },
  piscicultura: { color: '#1e3a8a', width: 2.5 },
  pecuaria: { color: '#000000', width: 2.5 },
  getec: { color: '#facc15', width: 1.5 },
});

function ponto(p, grupo, color, label) {
  const ok = coordenadaConferida(p);
  return { grupo, size: 8, color, alpha: ok ? 0.95 : 0.35, label: label ?? '', labelMaxDist: UR_LABEL_DIST };
}

// ------------------------------------------------------------------ grãos

export const GRAOS_LEGENDA = Object.freeze([
  { grupo: 'mip-mid', label: 'MIP e MID', color: '#fb923c' },
  { grupo: 'mip', label: 'Só MIP (pragas)', color: '#84cc16' },
  { grupo: 'mid', label: 'Só MID (doenças)', color: '#2563eb' },
  { grupo: 'nenhum', label: 'Sem MIP nem MID', color: '#e2e8f0' },
]);
const COR = (legenda) => Object.fromEntries(legenda.map((g) => [g.grupo, g.color]));
const GRAOS_COR = COR(GRAOS_LEGENDA);

export function graosGrupo(p) {
  const mip = p.MIP === 'Sim';
  const mid = p.MID === 'Sim';
  if (mip && mid) return 'mip-mid';
  if (mip) return 'mip';
  return mid ? 'mid' : 'nenhum';
}

export function graosEstilo(p) {
  const g = graosGrupo(p);
  return ponto(p, g, GRAOS_COR[g], p.Produtor);
}

// ------------------------------------------------------- café e piscicultura

export const CAFE_LEGENDA = Object.freeze([{ grupo: 'cafe', label: 'Propriedade assistida', color: '#92400e' }]);
export const cafeEstilo = (p) => ponto(p, 'cafe', CAFE_LEGENDA[0].color, p.Produtor);

export const PISCICULTURA_LEGENDA = Object.freeze([{ grupo: 'ur', label: 'Unidade de referência', color: '#0d9488' }]);
export const pisciculturaEstilo = (p) => ponto(p, 'ur', PISCICULTURA_LEGENDA[0].color, p.Unidade);

// ------------------------------------------------------- pecuária de corte

export const PECUARIA_LEGENDA = Object.freeze([
  { grupo: 'Programa Purunã', label: 'Programa Purunã', color: '#dc2626' },
  { grupo: 'Pecuária Moderna', label: 'Pecuária Moderna', color: '#be185d' },
  { grupo: 'Associação Purunã', label: 'Associação Purunã', color: '#fda4af' },
  { grupo: 'desligado', label: 'Desligado do programa', color: '#475569' },
]);
const PECUARIA_COR = COR(PECUARIA_LEGENDA);

export const desligado = (p) => /deslig/i.test(p['Observação'] ?? '');

export function pecuariaEstilo(p) {
  // Programa fora da legenda fica cinza (o teste com o dado real acusa).
  const g = desligado(p) ? 'desligado' : (PECUARIA_COR[p.Programa] ? p.Programa : 'outro');
  return ponto(p, g, PECUARIA_COR[g] ?? '#94a3b8', p.Produtor);
}

// ---------------------------------------------------------------- tooltip

const fmtDec = (v) => (Number.isFinite(v) ? v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : '');
const fmtHa = (v) => (Number.isFinite(v) ? `${fmtDec(v)} ha` : '');

/**
 * Tooltip comum das URs: título = produtor (ou unidade), linhas na ordem de
 * `campos` ([rótulo, chave]) e, no fim, observação, checagem e fonte da
 * coordenada. O selo avisa desligamento ou coordenada a conferir.
 */
export function urTooltip({ icon, programa, campos = [], source }) {
  return (p) => {
    const ok = coordenadaConferida(p);
    const fora = desligado(p);
    return tipCard({
      icon,
      title: p.Produtor || p.Unidade || 'Unidade de referência',
      subtitle: [p.Programa || programa, p['Município']].filter(Boolean).join(' · '),
      badge: fora ? { text: 'Desligado', tone: 'alert' } : (!ok ? { text: 'Coordenada a conferir', tone: 'warn' } : null),
      rows: [
        ['Município', p['Município']],
        ['Regional', p.Regional],
        ...campos.map(([rotulo, chave]) => [rotulo, p[chave]]),
        ['Imóvel CAR', p['Imóvel CAR']],
        ['Área do imóvel', fmtHa(p['Área do imóvel (ha)'])],
        ['Observação', p['Observação'], 'warn'],
        ['Coordenada', p['Checagem da coordenada'], ok ? 'ok' : 'warn'],
        ['Origem do ponto', p['Fonte da coordenada']],
      ],
      source,
    });
  };
}

export const graosTooltip = urTooltip({
  icon: '🌾',
  programa: 'Grãos (UIRT)',
  campos: [['Técnicos', 'Responsáveis'], ['MIP (pragas)', 'MIP'], ['MID (doenças)', 'MID'], ['Coletor de esporos', 'Coletor de esporos']],
  source: 'IDR-Paraná · Programa Grãos (UIRTs)',
});
export const cafeTooltip = urTooltip({ icon: '☕', programa: 'Café', source: 'IDR-Paraná · Programa Café' });
export const pisciculturaTooltip = urTooltip({
  icon: '🐟', programa: 'Piscicultura', source: 'IDR-Paraná · Programa Estadual de Piscicultura',
});
// ------------------------------------------------------ URs do GETEC

/**
 * URs cadastradas no GETEC (scripts/build_getec_urs.py). Os 31 projetos do
 * catálogo do GETEC (select "Projeto" de rel_cad_ur.php) em famílias: a cor
 * é a da família, num tom por projeto, e a legenda lista cada projeto.
 * Projeto fora do catálogo cai em "Outros projetos".
 */
export const GETEC_FAMILIAS = Object.freeze([
  { familia: 'leite', label: 'Pecuária de leite', color: '#e2e8f0', projetos: ['Pecuária de Leite'] },
  { familia: 'corte', label: 'Pecuária de corte e outras criações', color: '#dc2626',
    projetos: ['Pecuária de Corte', 'Caprinos e Ovinos', 'Outras criações'] },
  { familia: 'graos', label: 'Grãos', color: '#facc15', projetos: ['Grãos: Soja/Milho', 'Grãos: Feijão/Milho e Cereais de Inverno'] },
  { familia: 'hortifruti', label: 'Olericultura e fruticultura', color: '#22c55e',
    projetos: ['Olericultura', 'Fruticultura', 'Plantas Condimentares, Aromáticas e Ervas'] },
  { familia: 'lavouras', label: 'Café, mandioca e outras lavouras', color: '#b45309',
    projetos: ['Café', 'Mandioca', 'Erva-Mate', 'Palmáceas', 'Sericicultura', 'Cultivo Florestal', 'Outras explorações agrícolas'] },
  { familia: 'agroind', label: 'Agroindústria e turismo rural', color: '#f472b6', projetos: ['Agroindústria', 'Turismo Rural'] },
  { familia: 'aguas', label: 'Piscicultura, pesca e abelhas', color: '#0ea5e9',
    projetos: ['Piscicultura', 'Pesca', 'Maricultura', 'Criação de abelhas'] },
  { familia: 'ambiente', label: 'Recursos naturais, agroecologia e energia', color: '#14b8a6',
    projetos: ['Recursos Naturais e sustentabilidade', 'Agroecologia', 'Energias renováveis'] },
  { familia: 'social', label: 'Promoção social e organização', color: '#a78bfa',
    projetos: ['Promoção Social e Cidadania', 'Associativismo', 'Cooperativismo', 'Sindicalismo', 'Crédito Rural',
      'Demandas Institucionais'] },
]);

/** '#rrggbb' misturado com branco (t > 0) ou preto (t < 0), |t| <= 1. */
export function tom(hex, t) {
  const alvo = t > 0 ? 255 : 0;
  const k = Math.abs(t);
  const c = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - k) + alvo * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const OUTRO_PROJETO = { grupo: 'outro', label: 'Outros projetos', color: '#94a3b8' };

/** Legenda por projeto, na ordem das famílias: tons de -0,35 (escuro) a +0,35 (claro) dentro da família. */
export const GETEC_LEGENDA = Object.freeze([
  ...GETEC_FAMILIAS.flatMap(({ color, projetos }) => projetos.map((projeto, i) => ({
    grupo: projeto, label: projeto,
    color: projetos.length > 1 ? tom(color, -0.35 + (0.7 * i) / (projetos.length - 1)) : color,
  }))),
  OUTRO_PROJETO,
]);
const GETEC_COR = Object.fromEntries(GETEC_LEGENDA.map((g) => [g.grupo, g.color]));

/** Grupo da legenda (o próprio projeto do catálogo, ou 'outro'). */
export const getecGrupo = (projeto) => (GETEC_COR[projeto] && projeto !== 'outro' ? projeto : 'outro');
export const getecFamilia = (projeto) => GETEC_FAMILIAS.find((f) => f.projetos.includes(projeto))?.familia ?? 'outro';
export const getecCor = (projeto) => GETEC_COR[getecGrupo(projeto)];
export const getecEstilo = (p) => ponto(p, getecGrupo(p.Projeto), getecCor(p.Projeto), p.Produtor);

export const getecTooltip = urTooltip({
  icon: '📋',
  programa: 'UR do GETEC',
  campos: [
    ['Projeto', 'Projeto'], ['Ano', 'Ano'], ['Extensionista', 'Extensionista'], ['Também em', 'Também em'],
    ['Origem do ponto', 'Origem do ponto'],
  ],
  source: 'IDR-Paraná · GETEC (SISATER), cadastro de Unidades de Referência',
});

export const pecuariaTooltip = urTooltip({ icon: '🐂', programa: 'Pecuária de Corte', source: 'IDR-Paraná · Pecuária de Corte' });
