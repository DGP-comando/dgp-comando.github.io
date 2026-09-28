// src/data/modulosFiscais.js
//
// Carga de public/data/modulos-fiscais-pr.json (scripts/build_modulos_fiscais.py):
// módulo fiscal (MF), módulo rural de exploração indefinida e fração mínima de
// parcelamento de cada município, pelo INCRA. É a régua das classes de porte
// da estrutura fundiária do CAR (Lei 8.629/1993: pequena até 4 MF, média até 15).
//
// Estático e pequeno (~20 KB), buscado no máximo UMA vez, na primeira ficha
// aberta — mesmo contrato de carMunicipios.js.

const URL = '/data/modulos-fiscais-pr.json';
const PEQUENA_ATE_MF = 4;
const MEDIA_ATE_MF = 15;

let _promessa = null;

function loadModulosFiscais() {
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
 * Um município: seus índices e os limites de porte em hectares. Vários
 * (regional): a faixa do módulo fiscal. null sem dado.
 * @param {{fonte: string, municipios: Object<string, {mf: number, mei: number, fmp: number}>}|null} dados
 * @param {Array<string|number>} ibges
 */
export function resumirModulos(dados, ibges) {
  const itens = (ibges ?? []).map((c) => dados?.municipios?.[String(c)]).filter(Boolean);
  if (!itens.length) return null;
  const fonte = dados.fonte;
  if (itens.length === 1) {
    const { mf, mei, fmp } = itens[0];
    return {
      n: 1, mf, mei, fmp,
      pequenaAteHa: PEQUENA_ATE_MF * mf,
      mediaAteHa: MEDIA_ATE_MF * mf,
      fonte,
    };
  }
  const mfs = itens.map((it) => it.mf);
  return { n: itens.length, mfMin: Math.min(...mfs), mfMax: Math.max(...mfs), fonte };
}

/** Resumo para a ficha municipal ou regional. Nunca lança: a ficha segue sem a seção. */
export async function getModulosFiscais(ibges) {
  try {
    return resumirModulos(await loadModulosFiscais(), ibges);
  } catch (err) {
    console.warn('[DataGeo:ficha] módulos fiscais indisponíveis:', err?.message);
    return null;
  }
}
