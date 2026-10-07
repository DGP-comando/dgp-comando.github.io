// src/data/ottobacias.js
//
// Ottobacias do IDR por município (public/data/ottobacias-municipios.json,
// scripts/build_ottobacias.py): quantas tocam o município e os mananciais de
// abastecimento (Sanepar ou IDR-Paraná) entre elas. Linha da seção
// Hidrografia da ficha. Buscado no máximo uma vez.

const URL = '/data/ottobacias-municipios.json';
let _promessa = null;

function carrega() {
  _promessa ??= fetch(URL)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${URL}: HTTP ${r.status}`))))
    .catch((err) => {
      _promessa = null; // falha não fica em cache
      throw err;
    });
  return _promessa;
}

/**
 * Um município: {n, mananciais}. Vários (regional): só os mananciais (sem
 * repetir), porque uma ottobacia na divisa contaria duas vezes em `n`.
 */
export function resumirOttobacias(dados, ibges) {
  const itens = (ibges ?? []).map((c) => dados?.municipios?.[String(c)]).filter(Boolean);
  if (!itens.length) return null;
  const vistos = new Map();
  for (const it of itens) {
    for (const m of it.mananciais ?? []) {
      const k = `${m.nome}|${m.classe}`;
      vistos.set(k, { nome: m.nome, classe: m.classe, ottobacias: (vistos.get(k)?.ottobacias ?? 0) + m.ottobacias });
    }
  }
  const mananciais = [...vistos.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return { n: itens.length === 1 ? itens[0].n : null, mananciais, fonte: dados.fonte };
}

/** Nunca lança: a ficha segue sem a linha. */
export async function getOttobacias(ibges) {
  try {
    return resumirOttobacias(await carrega(), ibges);
  } catch (err) {
    console.warn('[DataGeo:ficha] ottobacias indisponíveis:', err?.message);
    return null;
  }
}
