// src/data/carMunicipios.js
//
// Carga de public/data/car-municipios.json (scripts/build_car.py): contagem e
// área dos imóveis ATIVOS do CAR por classe de módulos fiscais, para cada
// município e para o estado.
//
// Estático e pequeno (dezenas de KB), mas fora do boot: é buscado no máximo
// UMA vez, na primeira ficha municipal aberta, com as chamadas concorrentes
// compartilhando a mesma promessa — mesmo contrato de climaHistorico.js.

const URL = '/data/car-municipios.json';

let _promessa = null;

export function loadCarMunicipios() {
  if (!_promessa) {
    _promessa = fetch(URL)
      .then((resp) => {
        if (!resp.ok) throw new Error(`${URL}: HTTP ${resp.status}`);
        return resp.json();
      })
      .catch((err) => {
        // Falha não fica em cache: a próxima abertura da ficha tenta de novo.
        _promessa = null;
        throw err;
      });
  }
  return _promessa;
}

/**
 * Distribuição do município por classe de módulos fiscais, já com totais e
 * percentuais calculados, ou null se não houver dado. Nunca lança: a ficha tem
 * outras seções para mostrar.
 * @param {string|number} ibge
 * @returns {Promise<{
 *   classes: string[], geradoEm: string, fonte: string,
 *   totalImoveis: number, totalHa: number,
 *   linhas: {classe: string, n: number, ha: number, pctN: number, pctHa: number}[],
 * }|null>}
 */
export async function getCarMunicipio(ibge) {
  const code = String(ibge ?? '');
  try {
    const dados = await loadCarMunicipios();
    const item = dados?.municipios?.[code];
    if (!item) return null;
    const totalImoveis = item.n.reduce((a, b) => a + b, 0);
    const totalHa = item.ha.reduce((a, b) => a + b, 0);
    if (!totalImoveis) return null;
    // Divisões protegidas: um município pode ter imóveis com área declarada
    // zerada, e nesse caso o percentual de área não existe — 0 é a resposta
    // honesta, NaN vazaria para a barra como largura inválida.
    const pct = (v, total) => (total > 0 ? (v / total) * 100 : 0);
    return {
      classes: dados.classes,
      geradoEm: dados.geradoEm,
      fonte: dados.fonte,
      totalImoveis,
      totalHa,
      linhas: dados.classes.map((classe, k) => ({
        classe,
        n: item.n[k],
        ha: item.ha[k],
        pctN: pct(item.n[k], totalImoveis),
        pctHa: pct(item.ha[k], totalHa),
      })),
    };
  } catch (err) {
    console.warn('[DataGeo:car] distribuição por módulos fiscais indisponível:', err?.message);
    return null;
  }
}
