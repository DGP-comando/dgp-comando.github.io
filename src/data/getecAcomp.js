// src/data/getecAcomp.js
//
// Carga de public/data/getec-acomp-municipios.json (scripts/build_getec_publico.py):
// acompanhamento da assistência técnica no GETEC (SISATER) por município, do
// painel público do sistema. Público cadastrado/programado/atendido,
// extensionistas (número e equivalente em tempo integral) e organizações.
// Mesmo contrato de modulosFiscais.js: estático, buscado uma vez, nunca lança.

const URL = '/data/getec-acomp-municipios.json';

let _promessa = null;

function loadGetec() {
  if (!_promessa) {
    _promessa = fetch(URL)
      .then((resp) => {
        if (!resp.ok) throw new Error(`${URL}: HTTP ${resp.status}`);
        return resp.json();
      })
      .catch((err) => {
        _promessa = null; // falha não fica em cache
        throw err;
      });
  }
  return _promessa;
}

const soma = (itens, f) => itens.reduce((a, it) => a + (Number(f(it)) || 0), 0);
const arred = (v, casas) => Math.round(v * 10 ** casas) / 10 ** casas;

/**
 * Soma dos municípios pedidos; razões recalculadas sobre a soma (não a média
 * das razões). Organizações somadas por tipo. null sem dado.
 * @param {{ano: number, municipios: Object<string, object>}|null} dados
 * @param {Array<string|number>} ibges
 */
export function resumirGetec(dados, ibges) {
  const itens = (ibges ?? []).map((c) => dados?.municipios?.[String(c)]).filter((it) => it?.publico);
  if (!itens.length) return null;
  const existente = soma(itens, (it) => it.publico.existente);
  const programado = soma(itens, (it) => it.publico.programado);
  const atendido = soma(itens, (it) => it.publico.atendido);
  const extN = soma(itens, (it) => it.extensionistas.n);
  const equivalente = arred(soma(itens, (it) => it.extensionistas.equivalente), 2);
  const porTipo = {};
  for (const it of itens) {
    for (const o of it.organizacoes ?? []) {
      const t = (porTipo[o.tipo] ??= { tipo: o.tipo, existente: 0, atendido: 0 });
      t.existente += Number(o.existente) || 0;
      t.atendido += Number(o.atendido) || 0;
    }
  }
  return {
    n: itens.length,
    ano: dados.ano,
    existente,
    programado,
    atendido,
    pctProgramado: existente > 0 ? arred((programado / existente) * 100, 1) : null,
    pctExecutado: programado > 0 ? arred((atendido / programado) * 100, 1) : null,
    extensionistas: extN,
    equivalente,
    publicoPorEquivalente: equivalente > 0 ? Math.round(existente / equivalente) : null,
    entidadesAtendidas: soma(itens, (it) => it.entidades_atendidas),
    organizacoes: Object.values(porTipo).sort((a, b) => b.existente - a.existente),
    fonte: dados.fonte,
  };
}

/** Resumo para a ficha municipal ou regional. Nunca lança: a ficha segue sem a seção. */
export async function getGetec(ibges) {
  try {
    return resumirGetec(await loadGetec(), ibges);
  } catch (err) {
    console.warn('[DataGeo:ficha] GETEC indisponível:', err?.message);
    return null;
  }
}
