// src/data/faxinais.js
//
// Faxinais por município para o tooltip do município: o total vem do
// inventário IAT/ZEE-PR 2010 (faxinais-pr.geojson, a camada de pontos) e o
// ARESUR da base atual de perímetros (faxinais-territorios-pr.geojson,
// aresur = 'Sim'), que já traz os reconhecidos depois de 2010 (2013, 2018).
// O tipo ARESUR dos pontos de 2010 deixaria, por exemplo, Pinhão sem nenhum.

/** {<ibge>: {total, aresur}}: total dos pontos, ARESUR dos perímetros. */
export function faxinaisPorMunicipio(pontos, territorios) {
  const out = {};
  const de = (ibge) => (out[ibge] ??= { total: 0, aresur: 0 });
  for (const f of pontos?.features ?? []) {
    const { ibge } = f.properties ?? {};
    if (ibge) de(ibge).total += 1;
  }
  for (const f of territorios?.features ?? []) {
    const { ibge, aresur } = f.properties ?? {};
    if (ibge && aresur === 'Sim') de(ibge).aresur += 1;
  }
  return out;
}

const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

let p = null;
/** Contagem por município, ou null se um dos arquivos falhar (tenta de novo depois). Nunca lança. */
export function loadFaxinaisMunicipios() {
  p ??= Promise.all([json('/data/faxinais-pr.geojson'), json('/data/faxinais-territorios-pr.geojson')])
    .then(([pontos, territorios]) => {
      if (!pontos || !territorios) {
        p = null;
        return null;
      }
      return faxinaisPorMunicipio(pontos, territorios);
    });
  return p;
}
