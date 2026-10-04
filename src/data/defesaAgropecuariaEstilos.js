// src/data/defesaAgropecuariaEstilos.js
//
// Estilo, legenda e tooltip das camadas do grupo "Defesa Agropecuária"
// (cadastros da ADAPAR): propriedades com exploração pecuária ativa e os
// estabelecimentos registrados (comércio de produtos veterinários, de animais
// vivos, de agrotóxicos e de fertilizantes, Unidades de Consolidação e
// indústrias de produtos de origem animal).
// Camadas em src/maplibre/layers/defesaAgropecuaria.js; dados em
// data/privado/adapar-* (bucket datageo-privado) gerados por
// scripts/build_adapar.py.
//
// `*Estilo(props)` segue o contrato de energiaLogisticaEstilos.js:
// {grupo, size, color, alpha, label, labelMaxDist}. Cada cadastro tem uma
// família de cor e um contorno próprio (ADAPAR_CONTORNO), para o ponto não
// depender só da cor. Estabelecimento sem coordenada no cadastro fica no
// centro do município, esmaecido; o tooltip diz isso.

import { tipCard, fmtNum } from '../maplibre/tooltipCard.js';
import { periodo } from './cafFamilias.js';
import { coordenadaConferida } from './programasIdrEstilos.js';

/** Teto (m de altura) dos rótulos das camadas de estabelecimentos. */
export const ADAPAR_LABEL_DIST = 25_000;

/** Contorno do círculo por cadastro (makePointsLayer `stroke`). */
export const ADAPAR_CONTORNO = Object.freeze({
  veterinarios: { color: '#0c4a6e', width: 2 },
  animais: { color: '#ffffff', width: 1.5 },
  agrotoxicos: { color: '#000000', width: 2 },
  fertilizantes: { color: '#14532d', width: 2 },
  consolidacao: { color: '#3b0764', width: 2.5 },
  industrias: { color: '#fde68a', width: 2 },
});

function ponto(p, grupo, legenda) {
  const color = legenda.find((g) => g.grupo === grupo)?.color ?? '#94a3b8';
  return {
    grupo, size: 7, color, alpha: coordenadaConferida(p) ? 0.95 : 0.4,
    label: p['Razão social'] ?? '', labelMaxDist: ADAPAR_LABEL_DIST,
  };
}

// ----------------------------------------------------- produtos veterinários

export const VETERINARIOS_LEGENDA = Object.freeze([
  { grupo: 'Biológico Farmacêutico', label: 'Biológicos e farmacêuticos', color: '#38bdf8' },
  { grupo: 'Farmacêutico', label: 'Só farmacêuticos', color: '#6366f1' },
  { grupo: 'Biológico', label: 'Só biológicos (vacinas)', color: '#a5f3fc' },
  { grupo: 'outro', label: 'Sem categoria', color: '#94a3b8' },
]);
const VET_GRUPOS = new Set(VETERINARIOS_LEGENDA.map((g) => g.grupo));
export const veterinarioEstilo = (p) => ponto(p, VET_GRUPOS.has(p.Categoria) ? p.Categoria : 'outro', VETERINARIOS_LEGENDA);

// ------------------------------------------------------------ animais vivos

export const ANIMAIS_LEGENDA = Object.freeze([{ grupo: 'animais', label: 'Comércio de animais vivos', color: '#f472b6' }]);
export const animaisVivosEstilo = (p) => ponto(p, 'animais', ANIMAIS_LEGENDA);

// -------------------------------------------------------------- agrotóxicos

export const AGROTOXICOS_LEGENDA = Object.freeze([
  { grupo: 'industria', label: 'Fabricante, formulador ou manipulador', color: '#b91c1c' },
  { grupo: 'comex', label: 'Importador ou exportador', color: '#facc15' },
  { grupo: 'comerciante', label: 'Comerciante', color: '#f97316' },
  { grupo: 'outro', label: 'Outros ou sem categoria', color: '#94a3b8' },
]);

/** O papel mais restrito do registro manda: indústria > comércio exterior > comerciante. */
export function agrotoxicoGrupo(p) {
  const c = p.Categorias ?? '';
  if (/Fabricante|Formulador|Manipulador/.test(c)) return 'industria';
  if (/Importador|Exportador/.test(c)) return 'comex';
  return /Comerciante/.test(c) ? 'comerciante' : 'outro';
}
export const agrotoxicoEstilo = (p) => ponto(p, agrotoxicoGrupo(p), AGROTOXICOS_LEGENDA);

// ------------------------------------------------------------ fertilizantes

export const FERTILIZANTES_LEGENDA = Object.freeze([
  { grupo: 'granel', label: 'Vende a granel', color: '#bef264' },
  { grupo: 'embalado', label: 'Só embalado', color: '#22c55e' },
]);
export const fertilizanteEstilo = (p) => ponto(p, p.Granel === 'Sim' ? 'granel' : 'embalado', FERTILIZANTES_LEGENDA);

// -------------------------------------------------- unidades de consolidação

export const CONSOLIDACAO_LEGENDA = Object.freeze([{ grupo: 'uc', label: 'Unidade de Consolidação', color: '#c084fc' }]);
export const consolidacaoEstilo = (p) => ponto(p, 'uc', CONSOLIDACAO_LEGENDA);

// ------------------------------------ indústrias de produtos de origem animal

export const INDUSTRIAS_LEGENDA = Object.freeze([
  { grupo: 'poa', label: 'Indústria de produtos de origem animal', color: '#14b8a6' },
]);
export const industriaEstilo = (p) => ponto(p, 'poa', INDUSTRIAS_LEGENDA);

// ------------------------------------------------- unidades (escritórios)

/**
 * Escritórios regionais e locais da ADAPAR (público, do site oficial; dados em
 * public/data/adapar-unidades-pr.geojson por scripts/build_adapar_unidades.py).
 * Regional maior e com rótulo na visão estadual; local só de perto.
 */
export const UNIDADES_LEGENDA = Object.freeze([
  { grupo: 'regional', label: 'Escritório regional', color: '#f97316' },
  { grupo: 'local', label: 'Escritório local', color: '#fdba74' },
]);

/** Ponto do site ou endereço geocodificado valem; centro do município e vizinhança não. */
const unidadeLocalizada = (p) => !/centro do município|vizinhança|sem o número/.test(p['Checagem da coordenada'] ?? '');

export function unidadeAdaparEstilo(p) {
  const regional = p.Tipo === 'Regional';
  return {
    grupo: regional ? 'regional' : 'local',
    size: regional ? 11 : 7,
    color: UNIDADES_LEGENDA[regional ? 0 : 1].color,
    alpha: unidadeLocalizada(p) ? 0.95 : 0.6,
    label: p.Nome ?? '',
    labelMaxDist: regional ? 1_200_000 : ADAPAR_LABEL_DIST * 4,
  };
}

export function unidadeAdaparTooltip(p) {
  const regional = p.Tipo === 'Regional';
  const ok = unidadeLocalizada(p);
  return tipCard({
    icon: '🏢',
    title: `ADAPAR · Escritório ${regional ? 'Regional' : 'Local'} de ${p.Nome ?? ''}`,
    subtitle: regional ? 'Unidade Regional de Sanidade Agropecuária' : `Regional ${p.Regional ?? ''}`,
    badge: ok ? null : { text: 'Local aproximado', tone: 'warn' },
    rows: [
      ['Endereço', [p['Endereço'], p.CEP ? `CEP ${p.CEP}` : ''].filter(Boolean).join(' · ')],
      ['Telefone', p.Telefone],
      ['E-mail', p['E-mail']],
      ['Circunscrição', p['Circunscrição']],
      regional ? ['Chefe', p.Chefe] : null,
      ok ? null : ['Coordenada', p['Checagem da coordenada'], 'warn'],
    ],
    source: 'ADAPAR · site oficial (Escritórios Regionais)',
  });
}

// ---------------------------------------------------------------- tooltips

/** 'a · b · c' com no máximo `max` itens; o resto vira "e mais N". */
export function listaCurta(v, max = 8) {
  const itens = String(v ?? '').split(' · ').filter(Boolean);
  return itens.length > max ? `${itens.slice(0, max).join(' · ')} e mais ${itens.length - max}` : itens.join(' · ');
}

/**
 * Tooltip comum dos estabelecimentos: título = razão social, `campos`
 * ([rótulo, chave]) do cadastro e, no fim, registro, contato e a unidade da
 * ADAPAR. O selo avisa a posição aproximada (sem coordenada no cadastro).
 */
export function estabelecimentoTooltip({ icon, tipo, campos = [], note }) {
  return (p) => {
    const ok = coordenadaConferida(p);
    const aproximado = /aproximado/.test(p['Checagem da coordenada'] ?? '');
    return tipCard({
      icon,
      title: p['Razão social'] || tipo,
      subtitle: [tipo, p['Município']].filter(Boolean).join(' · '),
      badge: ok ? null : { text: aproximado ? 'Local aproximado' : 'Coordenada a conferir', tone: 'warn' },
      rows: [
        ...campos.map(([rotulo, chave]) => [rotulo, listaCurta(p[chave])]),
        ['Validade do registro', p['Validade do registro']],
        ['CNPJ', [p.CNPJ, p.Estabelecimento].filter(Boolean).join(' · ')],
        ['Endereço', p['Endereço']],
        ['Telefone', p.Telefone],
        ['E-mail', p['E-mail']],
        ['Unidade da ADAPAR', [p['Unidade local'], p['Regional ADAPAR']].filter(Boolean).join(' · regional ')],
        ok ? null : ['Coordenada', p['Checagem da coordenada'], 'warn'],
      ],
      note,
      source: 'ADAPAR · cadastro de estabelecimentos',
    });
  };
}

export const veterinarioTooltip = estabelecimentoTooltip({
  icon: '💉',
  tipo: 'Comércio de produtos veterinários',
  campos: [
    ['Categoria', 'Categoria'], ['Biológicos', 'Produtos biológicos'], ['Farmacêuticos', 'Farmacêuticos'],
    ['Animais vivos', 'Animais vivos'],
  ],
});
export const animaisVivosTooltip = estabelecimentoTooltip({
  icon: '🐥', tipo: 'Comércio de animais vivos', campos: [['Espécies', 'Espécies']],
});
export const agrotoxicoTooltip = estabelecimentoTooltip({
  icon: '🧪', tipo: 'Comércio de agrotóxicos', campos: [['Registro como', 'Categorias'], ['Serviços', 'Serviços']],
});
export const fertilizanteTooltip = estabelecimentoTooltip({
  icon: '🌿',
  tipo: 'Comércio de fertilizantes',
  campos: [
    ['Produto', 'Produto'], ['A granel', 'Granel'], ['Embalado', 'Embalado'],
    ['Armazenagem a céu aberto', 'Armazenagem a céu aberto'],
  ],
});
export const consolidacaoTooltip = estabelecimentoTooltip({
  icon: '📦',
  tipo: 'Unidade de Consolidação',
  campos: [['Pragas controladas', 'Pragas'], ['Responsável técnico', 'Responsáveis técnicos']],
  note: 'Local de beneficiamento, processamento, embalagem ou armazenamento de produtos vegetais vindos de uma ou '
    + 'mais unidades de produção.',
});

export const industriaTooltip = estabelecimentoTooltip({
  icon: '🥩',
  tipo: 'Indústria de produtos de origem animal',
  campos: [['Profissional vinculado', 'Profissionais vinculados'], ['Portarias', 'Portarias']],
});

// ------------------------------------------ propriedades (exploração pecuária)

/** Cor de cada grupo, na ordem de `grupos` do build: DAP/CAF ativa, inativa, não informada. */
export const EXPLORACOES_CORES = Object.freeze(['#facc15', '#fb923c', '#94a3b8']);

/** Tooltip de uma linha de adapar-exploracoes (`campos` do build) com os metadados do arquivo. */
export function exploracaoTooltip(linha, dados) {
  if (!linha) return '';
  const [, , mun, g, fora, ha, propriedade, n, produtores] = linha;
  return tipCard({
    icon: '🐄',
    title: propriedade || 'Propriedade sem nome',
    subtitle: [dados.municipios?.[mun]?.[1], 'exploração pecuária ativa'].filter(Boolean).join(' · '),
    rows: [
      [n > 1 ? `Produtores (${n})` : 'Produtor', produtores || 'sem produtor vinculado'],
      ['Área', ha ? fmtNum(ha, 1, 'ha') : ''],
      ['DAP/CAF no cadastro', dados.grupos?.[g]],
      fora ? ['Localização', 'fora do município declarado', 'warn'] : null,
    ],
    source: `ADAPAR · propriedades com exploração pecuária, ${periodo(dados.referencia)}`,
  });
}
