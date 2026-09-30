// src/data/protecaoSocial.js
//
// Carga de public/data/protecao-social-pr.json (scripts/build_protecao_social.py):
// CadÚnico, Bolsa Família, Programa Fomento Rural e PAA por município, do MI
// Social do MDS. Só contagens agregadas; na ficha regional, somadas.
// Buscado no máximo UMA vez — mesmo contrato de modulosFiscais.js.

const URL = '/data/protecao-social-pr.json';

let _promessa = null;

function loadProtecaoSocial() {
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

/**
 * Soma os indicadores dos municípios pedidos. null sem dado.
 * @param {{fonte: string, periodos: Object<string, string>, municipios: Object<string, Object<string, number>>}|null} dados
 * @param {Array<string|number>} ibges
 */
export function resumirProtecaoSocial(dados, ibges) {
  const itens = (ibges ?? []).map((c) => dados?.municipios?.[String(c)]).filter(Boolean);
  if (!itens.length) return null;
  const soma = {};
  for (const it of itens) {
    for (const [k, v] of Object.entries(it)) soma[k] = (soma[k] ?? 0) + v;
  }
  return { n: itens.length, ...soma, periodos: dados.periodos ?? {}, fonte: dados.fonte };
}

/** Resumo para a ficha municipal ou regional. Nunca lança: a ficha segue sem a seção. */
export async function getProtecaoSocial(ibges) {
  try {
    return resumirProtecaoSocial(await loadProtecaoSocial(), ibges);
  } catch (err) {
    console.warn('[DataGeo:ficha] proteção social indisponível:', err?.message);
    return null;
  }
}
