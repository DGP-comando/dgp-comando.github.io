// src/data/climaHistorico.js
//
// Carga dos tres JSONs do clima historico BR-DWGD (scripts/build_clima_brdwgd.py).
// Estaticos e grandes o bastante para nao irem no boot: cada arquivo e buscado
// no maximo UMA vez, na primeira necessidade (camada ligada ou ficha aberta),
// com as chamadas concorrentes compartilhando a mesma promessa.
//
// Contrato dos arquivos: docs/CLIMA_BRDWGD.md.

const URLS = Object.freeze({
  resumo: '/data/clima-historico-pr.json',
  series: '/data/clima-historico-series-pr.json',
  grade: '/data/clima-historico-grade-pr.json',
});

const _cache = new Map();

function carregar(tipo) {
  if (!_cache.has(tipo)) {
    const promessa = fetch(URLS[tipo])
      .then((resp) => {
        if (!resp.ok) throw new Error(`${URLS[tipo]}: HTTP ${resp.status}`);
        return resp.json();
      })
      .catch((err) => {
        // Falha nao fica em cache: a proxima abertura da ficha tenta de novo.
        _cache.delete(tipo);
        throw err;
      });
    _cache.set(tipo, promessa);
  }
  return _cache.get(tipo);
}

export const loadClimaResumo = () => carregar('resumo');
export const loadClimaSeries = () => carregar('series');
export const loadClimaGrade = () => carregar('grade');

/**
 * Tudo que a ficha precisa de um municipio, ou null se o arquivo nao existe /
 * nao tem o codigo. Nunca lanca: a ficha tem outras secoes para mostrar.
 * @param {string|number} ibge
 * @returns {Promise<{meta: object, resumo: object, serie: object|null}|null>}
 */
export async function getClimaMunicipio(ibge) {
  const code = String(ibge ?? '');
  try {
    const [resumo, series] = await Promise.all([
      loadClimaResumo(),
      loadClimaSeries().catch(() => null),
    ]);
    const item = resumo?.municipios?.[code];
    if (!item) return null;
    const { municipios: _omit, ...meta } = resumo;
    return {
      meta,
      resumo: item,
      serie: series?.municipios?.[code] ? { anos: series.anos, ...series.municipios[code] } : null,
    };
  } catch (err) {
    console.warn('[DataGeo:clima-historico] indisponivel:', err?.message || err);
    return null;
  }
}
