// src/data/cadunicoRural.js
//
// Famílias rurais do CadÚnico (extração do IDR-Paraná, mar/2023) agregadas por
// município e por território — assentamento, quilombo, terra indígena
// (scripts/build_cadunico_rural.py). Arquivo do BUCKET PRIVADO: só usuário
// liberado lê (dgFetchData); sem sessão, `loadCadunicoRural` devolve null e
// ficha/tooltips seguem sem o bloco. Contagens de 1 a 4 vêm como "<5".

import { dgFetchData } from './datageoClient.js';
import { fmtInt, fmtPct } from '../maplibre/tooltipCard.js';

const URL = '/privado/cadunico-rural-pr.json';
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

let _promessa = null;

/** O JSON inteiro, ou null (sem sessão/sem acesso/falha). Nunca lança. */
export function loadCadunicoRural() {
  _promessa ??= dgFetchData(URL)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d) => {
      if (!d) _promessa = null; // login depois tenta de novo
      return d;
    });
  return _promessa;
}

export const mesAno = (p) => (p ? `${MESES[Number(String(p).slice(4)) - 1]}/${String(p).slice(0, 4)}` : '');

/**
 * Soma os municípios pedidos. Contagem suprimida ("<5") não entra na soma e
 * vai para `suprimidos`. null sem dado.
 */
export function resumirRural(dados, ibges) {
  const itens = (ibges ?? []).map((c) => dados?.municipios?.[String(c)]).filter(Boolean);
  if (!itens.length) return null;
  const soma = {};
  const suprimidos = [];
  for (const it of itens) {
    for (const [k, v] of Object.entries(it)) {
      if (typeof v === 'number') soma[k] = (soma[k] ?? 0) + v;
      else if (!suprimidos.includes(k)) suprimidos.push(k);
    }
  }
  return { n: itens.length, ...soma, suprimidos, referencia: dados.referencia };
}

const qtd = (v) => (v === '<5' ? 'menos de 5' : typeof v === 'number' && v > 0 ? fmtInt(v) : '');
const parte = (v, total) => (typeof v === 'number' && typeof total === 'number' && total > 0 ? ` (${fmtPct(v / total, 0)})` : '');

/**
 * Seção tipCard das famílias rurais de UM território (tooltip do assentamento,
 * quilombo ou terra indígena). null sem dado.
 */
export function secaoCadunicoTerritorio(t, referencia) {
  if (!t?.familias) return null;
  const f = t.familias;
  return {
    title: `CadÚnico · famílias rurais (${mesAno(referencia)})`,
    rows: [
      ['Famílias', `${qtd(f)}${typeof t.pessoas === 'number' ? ` · ${fmtInt(t.pessoas)} pessoas` : ''}`],
      ['Extrema pobreza', qtd(t.extrema_pobreza) + parte(t.extrema_pobreza, f), typeof t.extrema_pobreza === 'number' && t.extrema_pobreza / f >= 0.5 ? 'warn' : null],
      ['Pobreza', qtd(t.pobreza) + parte(t.pobreza, f)],
      ['Auxílio Brasil', qtd(t.auxilio_brasil) + parte(t.auxilio_brasil, f)],
      ['Sem água canalizada', qtd(t.sem_agua_canalizada)],
      ['Sem banheiro', qtd(t.sem_banheiro)],
    ],
  };
}
