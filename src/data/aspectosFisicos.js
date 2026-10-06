// src/data/aspectosFisicos.js
//
// Aba Aspectos físicos: legendas das camadas (as MESMAS cores no mapa e na
// ficha) e a carga de public/data/aspectos-fisicos-pr.json
// (scripts/build_aspectos_fisicos.py): altitude, declividade, drenagem,
// nascentes e uso do solo de cada município, já recortados pela malha.
// Estático, buscado no máximo UMA vez, como modulosFiscais.js.

const URL = '/data/aspectos-fisicos-pr.json';

/** Faixas de altitude (m): limites superiores; a última é "acima de". */
export const FAIXAS_ALTITUDE = Object.freeze([200, 400, 600, 800, 1000, 1200]);
export const CORES_ALTITUDE = Object.freeze([
  '#2b8a3e', '#74b816', '#c0d860', '#f5e27a', '#e8b04b', '#c47a3a', '#8c5a3c',
]);

export const rotuloFaixa = (i) => {
  const f = FAIXAS_ALTITUDE;
  if (i === 0) return `até ${f[0]} m`;
  if (i === f.length) return `acima de ${f.at(-1)} m`;
  return `${f[i - 1]}-${f[i]} m`;
};

/** Classes de declividade da ZEE-PR (%), com as cores do serviço do IAT. */
export const DECLIVIDADE = Object.freeze([
  { key: '0 a 10', label: '0-10 % (plano a suave)', curto: '0-10 %', color: '#016100' },
  { key: '10 a 20', label: '10-20 % (ondulado)', curto: '10-20 %', color: '#a3c500' },
  { key: '20 a 45', label: '20-45 % (forte ondulado)', curto: '20-45 %', color: '#ffba00' },
  { key: '>45', label: 'acima de 45 % (montanhoso)', curto: '> 45 %', color: '#ff2200' },
]);

/** Uso e cobertura da terra IAT 2012-2016 (NIVEL_II), cores do serviço do IAT. */
export const USO_SOLO = Object.freeze({
  'Agricultura Anual': '#89cd66',
  'Agricultura Perene': '#cdcd66',
  'Pastagem/Campo': '#70a800',
  'Floresta Nativa': '#267300',
  'Plantios Florestais': '#38a800',
  'Várzea': '#cd8966',
  'Corpos d’Água': '#73dfff',
  'Mangue': '#cafce3',
  'Restinga': '#b4d79e',
  'Linha de Praia': '#ffd37f',
  'Solo Exposto/Mineração': '#732600',
  'Área Construída': '#ff7f7f',
  'Área Urbanizada': '#ff73df',
  'Sem classificação': '#b2b2b2',
});

let _promessa = null;

export function loadAspectosFisicos() {
  _promessa ??= fetch(URL)
    .then((resp) => {
      if (!resp.ok) throw new Error(`${URL}: HTTP ${resp.status}`);
      return resp.json();
    })
    .catch((err) => {
      _promessa = null; // falha não fica em cache
      throw err;
    });
  return _promessa;
}

const soma = (itens, f) => itens.reduce((a, it) => a + (f(it) || 0), 0);

/**
 * Soma os municípios (um, ou os de uma regional). Altitude: mínimo e máximo
 * do conjunto, média ponderada pela área. null sem dado.
 */
export function resumirAspectos(dados, ibges) {
  const itens = (ibges ?? []).map((c) => dados?.municipios?.[String(c)]).filter(Boolean);
  if (!itens.length) return null;
  const areaHa = soma(itens, (it) => it.areaHa);
  const comAlt = itens.filter((it) => it.alt);
  const pesoAlt = soma(comAlt, (it) => it.areaHa);
  const alt = comAlt.length ? {
    min: Math.min(...comAlt.map((it) => it.alt.min)),
    max: Math.max(...comAlt.map((it) => it.alt.max)),
    med: Math.round(soma(comAlt, (it) => it.alt.med * it.areaHa) / pesoAlt),
    faixas: CORES_ALTITUDE.map((color, i) => ({
      label: rotuloFaixa(i), curto: rotuloFaixa(i), color, n: soma(comAlt, (it) => it.alt.faixas[i]),
    })).filter((l) => l.n > 0),
  } : null;
  const decl = DECLIVIDADE
    .map(({ key, label, curto, color }) => ({ key, label, curto, color, n: soma(itens, (it) => it.decl?.[key]) }))
    .filter((l) => l.n > 0);
  const uso = Object.entries(USO_SOLO)
    .map(([classe, color]) => ({ label: classe, curto: classe, color, n: soma(itens, (it) => it.uso?.[classe]) }))
    .filter((l) => l.n > 0)
    .sort((a, b) => b.n - a.n);
  return {
    n: itens.length,
    areaHa,
    alt,
    decl,
    drenKm: soma(itens, (it) => it.drenKm),
    nascentes: soma(itens, (it) => it.nascentes),
    uso,
    fonte: dados.fonte,
  };
}

/** Resumo para a ficha municipal ou regional. Nunca lança: a ficha segue sem as seções. */
export async function getAspectosFisicos(ibges) {
  try {
    return resumirAspectos(await loadAspectosFisicos(), ibges);
  } catch (err) {
    console.warn('[DataGeo:ficha] aspectos físicos indisponíveis:', err?.message);
    return null;
  }
}
