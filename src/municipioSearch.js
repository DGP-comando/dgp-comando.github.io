// src/municipioSearch.js
//
// Busca local pelos 399 municipios do Parana, para a caixa LOCALIZACAO.
//
// Por que local e nao geocoder: a caixa de busca mandava TODA consulta para o
// Google Geocoding, que devolve um ponto generico ("Candido de Abreu, PR,
// Brasil") e enquadra a camera por tipo de resultado. Um municipio, aqui, nao e
// um endereco: e uma unidade de analise com poligono proprio, codigo IBGE e
// ficha (datageoFicha). Resolver o nome contra a tabela que o app ja carrega
// devolve o CODIGO IBGE — que e o que abre a ficha certa — sem rede, sem chave
// de API e sem ambiguidade com municipios homonimos de outros estados.
//
// Modulo PURO de proposito: ui.js nao pode ser importado sob node (dependencia
// `mgrs` do Cesium), entao a logica de ranqueamento mora aqui e e testada como
// funcao, no lugar de virar mais um regex sobre o texto de ui.js.

import { PR_CENTROIDS } from './data/prCentroids.js';

/** Quantas sugestoes a caixa mostra. Cabe na altura livre acima do dock. */
export const MUNICIPIO_SUGGESTION_LIMIT = 7;

/**
 * Dobra acentos e caixa SEM mudar o comprimento da string.
 *
 * NFD decompoe "â" em "a" + combining circumflex; remover a marca devolve uma
 * string do mesmo tamanho do original em NFC. Isso e o que permite marcar o
 * trecho casado no nome ACENTUADO usando um indice calculado sobre a versao
 * sem acento — sem essa garantia o destaque escorregaria em "Candido",
 * "Icaraima" e todo nome com cedilha ou til.
 * @param {string} text
 * @returns {string}
 */
export function foldMunicipioText(text) {
  return String(text ?? '').normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
}

/**
 * Normaliza para CASAMENTO: sem acento, sem caixa, sem pontuacao, espacos
 * colapsados. Apostrofo vira espaco para que "d'Oeste" case com "d oeste" e com
 * "doeste" nao — o operador digita "sao jorge do oeste", nunca o apostrofo.
 * @param {string} text
 * @returns {string}
 */
export function normalizeMunicipioQuery(text) {
  return foldMunicipioText(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Ordem de qualidade do casamento; menor e melhor. */
const MATCH_EXACT = 0;
const MATCH_PREFIX = 1;
const MATCH_WORD_PREFIX = 2;
const MATCH_SUBSTRING = 3;
const MATCH_TOKENS = 4;
const MATCH_IBGE = 5;

const MATCH_KINDS = Object.freeze({
  [MATCH_EXACT]: 'exact',
  [MATCH_PREFIX]: 'prefix',
  [MATCH_WORD_PREFIX]: 'word-prefix',
  [MATCH_SUBSTRING]: 'substring',
  [MATCH_TOKENS]: 'tokens',
  [MATCH_IBGE]: 'ibge',
});

/**
 * Conectivos que nao distinguem municipio nenhum e que o operador escreve como
 * quiser. A tabela do IBGE grafa "São Jorge d'Oeste" e "Diamante d'Oeste"; o
 * teclado escreve "sao jorge do oeste". Ignorar o conectivo nos DOIS lados e o
 * que faz as duas formas casarem — sem isso o apostrofo teria que ser digitado.
 */
const CONNECTIVES = new Set(['de', 'do', 'da', 'dos', 'das', 'd']);

/** @param {readonly string[]} tokens */
function coreTokensOf(tokens) {
  return tokens.filter((token) => !CONNECTIVES.has(token));
}

/**
 * Sufixos de UF/pais que acompanham um nome de municipio em praticamente toda
 * planilha e todo mapa: "Cascavel, PR", "Maringá/PR", "Foz do Iguaçu, Paraná".
 * Digitar a UF e o gesto de quem quer DESAMBIGUAR — sem tolera-la, o operador
 * mais cuidadoso era justamente o que caia no geocoder.
 */
const UF_SUFFIXES = new Set(['pr', 'parana', 'br', 'brasil', 'brazil']);

/**
 * A consulta sem o sufixo de UF/pais, ou null se nao houver o que tirar.
 *
 * Nunca e aplicada de saida: quem chama tenta primeiro a consulta INTEIRA e so
 * recorre a esta se nada casar. "São Pedro do Paraná" e "Alto Paraná" sao
 * municipios cujo nome TERMINA em Paraná — se a poda viesse antes, eles
 * deixariam de ser alcancaveis pelo proprio nome.
 * @param {readonly string[]} tokens - tokens normalizados da consulta
 * @returns {string[]|null}
 */
function withoutUfSuffix(tokens) {
  let end = tokens.length;
  while (end > 1 && UF_SUFFIXES.has(tokens[end - 1])) end -= 1;
  return end === tokens.length ? null : tokens.slice(0, end);
}

const MUNICIPIO_INDEX = PR_CENTROIDS.map(([code, name, lat, lon]) => {
  const normalized = normalizeMunicipioQuery(name);
  const tokens = normalized.split(' ').filter(Boolean);
  const coreTokens = coreTokensOf(tokens);
  return Object.freeze({
    code,
    name,
    lat,
    lon,
    normalized,
    tokens: Object.freeze(tokens),
    coreTokens: Object.freeze(coreTokens),
    coreKey: coreTokens.join(' '),
  });
});

const BY_CODE = new Map(MUNICIPIO_INDEX.map((entry) => [entry.code, entry]));
const BY_NORMALIZED = new Map(MUNICIPIO_INDEX.map((entry) => [entry.normalized, entry]));

/**
 * Nome completo ignorando conectivos: e por aqui que "sao jorge do oeste"
 * alcanca "São Jorge d'Oeste" — a forma que o teclado escreve nunca e a que o
 * IBGE grafa. Chaves AMBIGUAS (dois municipios com o mesmo nucleo) ficam de
 * fora: se o nucleo nao identifica um municipio so, ele nao pode capturar o
 * Enter — a lista de sugestoes decide, com o operador olhando.
 */
const BY_CORE_KEY = (() => {
  const seen = new Map();
  const ambiguous = new Set();
  for (const entry of MUNICIPIO_INDEX) {
    if (entry.coreKey === entry.normalized) continue;
    if (seen.has(entry.coreKey)) ambiguous.add(entry.coreKey);
    else seen.set(entry.coreKey, entry);
  }
  for (const key of ambiguous) seen.delete(key);
  // Um nucleo que ja e o nome exato de OUTRO municipio pertence a esse outro.
  for (const key of [...seen.keys()]) {
    if (BY_NORMALIZED.has(key)) seen.delete(key);
  }
  return seen;
})();

/**
 * Cada token da consulta e prefixo de um token do nome, na ordem, sem reusar
 * token. Cobre a forma como se digita um nome longo: "sao jose pinhais" para
 * "São José dos Pinhais", "santa cruz monte castelo" para "Santa Cruz de Monte
 * Castelo". Consumir em ORDEM impede que "boa vista" case com "Vista Boa" —
 * sao dois lugares diferentes.
 * @param {readonly string[]} queryTokens
 * @param {readonly string[]} nameTokens
 * @returns {boolean}
 */
function tokensMatchInOrder(queryTokens, nameTokens) {
  let cursor = 0;
  for (const token of queryTokens) {
    while (cursor < nameTokens.length && !nameTokens[cursor].startsWith(token)) cursor += 1;
    if (cursor >= nameTokens.length) return false;
    cursor += 1;
  }
  return true;
}

/**
 * Melhor casamento de uma entrada contra uma consulta ja normalizada, ou null.
 * @param {{normalized: string, tokens: readonly string[], coreTokens: readonly string[]}} entry
 * @param {string} query
 * @param {readonly string[]} queryCoreTokens - tokens da consulta sem conectivos
 * @returns {number|null}
 */
function scoreEntry(entry, query, queryCoreTokens) {
  if (entry.normalized === query) return MATCH_EXACT;
  // O nome inteiro, so que com o conectivo do teclado: tao exato quanto.
  if (entry.coreKey === queryCoreTokens.join(' ')) return MATCH_EXACT;
  if (entry.normalized.startsWith(query)) return MATCH_PREFIX;
  if (entry.tokens.some((token) => token.startsWith(query))) return MATCH_WORD_PREFIX;
  if (entry.normalized.includes(query)) return MATCH_SUBSTRING;
  // Uma consulta so de conectivos ("do", "de") nao diz nada: sem esta guarda
  // tokensMatchInOrder receberia lista vazia e casaria com os 399.
  if (queryCoreTokens.length > 1 && tokensMatchInOrder(queryCoreTokens, entry.coreTokens)) {
    return MATCH_TOKENS;
  }
  return null;
}

/**
 * Posicao do trecho casado DENTRO do nome acentuado, para o destaque da lista.
 * Devolve null quando a consulta nao aparece como substring contigua (casamento
 * por tokens), caso em que a UI simplesmente nao destaca nada.
 * @param {string} name
 * @param {string} query
 * @returns {{start: number, length: number}|null}
 */
export function municipioMatchRange(name, query) {
  const needle = normalizeMunicipioQuery(query);
  if (!needle || needle.includes(' ')) return null;
  const haystack = foldMunicipioText(name);
  const start = haystack.indexOf(needle);
  if (start === -1 || start + needle.length > name.length) return null;
  return { start, length: needle.length };
}

/**
 * Municipios que casam com a consulta, do melhor para o pior.
 *
 * Consulta so de digitos e tratada como codigo IBGE (prefixo), porque e assim
 * que codigo de municipio circula em planilha da SEAB e do DATASUS.
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {Array<{code: string, name: string, lat: number, lon: number, matchKind: string}>}
 */
export function searchMunicipios(query, { limit = MUNICIPIO_SUGGESTION_LIMIT } = {}) {
  const raw = String(query ?? '').trim();
  if (!raw) return [];
  const maximum = Number.isInteger(limit) && limit > 0 ? limit : MUNICIPIO_SUGGESTION_LIMIT;

  if (/^\d+$/.test(raw)) {
    return MUNICIPIO_INDEX
      .filter((entry) => entry.code.startsWith(raw))
      .slice(0, maximum)
      .map((entry) => toResult(entry, MATCH_IBGE));
  }

  const normalized = normalizeMunicipioQuery(raw);
  if (!normalized) return [];
  const tokens = normalized.split(' ').filter(Boolean);

  const hits = rankMunicipios(normalized, coreTokensOf(tokens), maximum);
  if (hits.length) return hits;
  // Nada casou com a consulta inteira. So AGORA vale tentar sem o sufixo de
  // UF — depois, nunca antes, para nao roubar "São Pedro do Paraná" de si mesmo.
  const pruned = withoutUfSuffix(tokens);
  if (!pruned) return [];
  return rankMunicipios(pruned.join(' '), coreTokensOf(pruned), maximum);
}

/**
 * Ordena os municipios que casam com uma consulta ja normalizada.
 * @param {string} normalized
 * @param {readonly string[]} coreTokens
 * @param {number} maximum
 * @returns {Array<object>}
 */
function rankMunicipios(normalized, coreTokens, maximum) {
  const scored = [];
  for (const entry of MUNICIPIO_INDEX) {
    const score = scoreEntry(entry, normalized, coreTokens);
    if (score === null) continue;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => (
    a.score - b.score
    // Empate: o nome mais curto e o candidato mais provavel ("Toledo" antes de
    // "Sao Jose do Toledo"), e a ordem alfabetica desempata o resto de forma
    // estavel — a lista nao pode reordenar entre dois teclados iguais.
    || a.entry.normalized.length - b.entry.normalized.length
    || a.entry.normalized.localeCompare(b.entry.normalized)
  ));
  return scored.slice(0, maximum).map(({ entry, score }) => toResult(entry, score));
}

function toResult(entry, score) {
  return {
    code: entry.code,
    name: entry.name,
    lat: entry.lat,
    lon: entry.lon,
    matchKind: MATCH_KINDS[score] || 'match',
  };
}

/**
 * Municipio cujo nome a consulta escreve por inteiro (ou cujo codigo IBGE ela
 * e), ou null. E o que autoriza o Enter direto, sem passar pela lista: digitar
 * o nome completo e apertar Enter tem que ir para o municipio, nao para o
 * geocoder.
 * @param {string} query
 * @returns {{code: string, name: string, lat: number, lon: number}|null}
 */
export function exactMunicipioMatch(query) {
  const raw = String(query ?? '').trim();
  if (!raw) return null;
  if (/^\d{7}$/.test(raw)) {
    const byCode = BY_CODE.get(raw);
    return byCode ? toResult(byCode, MATCH_IBGE) : null;
  }
  const normalized = normalizeMunicipioQuery(raw);
  const tokens = normalized.split(' ').filter(Boolean);
  // Consulta inteira primeiro; a poda da UF so entra se ela nao casar.
  const entry = lookupExact(normalized, tokens)
    || lookupExactWithoutUf(tokens);
  return entry ? toResult(entry, MATCH_EXACT) : null;
}

function lookupExact(normalized, tokens) {
  return BY_NORMALIZED.get(normalized)
    || BY_CORE_KEY.get(coreTokensOf(tokens).join(' '))
    || null;
}

function lookupExactWithoutUf(tokens) {
  const pruned = withoutUfSuffix(tokens);
  return pruned ? lookupExact(pruned.join(' '), pruned) : null;
}

/**
 * Entrada pelo codigo IBGE de 7 digitos, ou null.
 * @param {string|number} code
 * @returns {{code: string, name: string, lat: number, lon: number}|null}
 */
export function municipioByIbge(code) {
  const entry = BY_CODE.get(String(code ?? ''));
  return entry ? toResult(entry, MATCH_IBGE) : null;
}
