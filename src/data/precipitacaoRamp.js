// src/data/precipitacaoRamp.js
//
// Escala de cor da camada de precipitacao. Registro unico, no formato de
// satelliteClass.js: o preenchimento no mapa, o quadradinho da legenda e a
// contagem por classe leem a MESMA tabela e por isso nao tem como divergir.
//
// POR QUE VIOLETA, E POR QUE ELA NAO CLAREIA ATE O BRANCO
//
// Ciano e o acento global do app (--accent #00d4ff) E a cor das particulas de
// vento (datageoVentos.js). Como esta camada existe justamente para ser lida
// SOBRE o vento, ela precisa sair da familia azul inteira.
//
// O instinto de "fundo escuro => rampa em direcao ao branco" e uma armadilha
// aqui: medido contra o ciano #22d3ee sob deficiencia de cor (Machado 2009),
// os violetas claros COLAPSAM justamente no topo da escala, que e a parte que
// mais importa — #e9b8fb da dE 3,3 (protan), #d8b4fe 3,3, #f0abfc 4,2. Ou
// seja: chuva forte ficaria indistinguivel dos riscos de vento para quem tem
// protanopia/deuteranopia. Por isso a escala PARA em #e879f9 e deixa o alpha
// (0,14 -> 0,80) carregar o resto da magnitude. Todos os degraus compostos
// ficam com dE >= 10,8 contra o ciano, inclusive sobre imagem clara (nuvem,
// area urbana).
//
// O teto tambem evita a unica colisao real de violeta no app: #c084fc ja e o
// preenchimento dos territorios quilombolas (datageoTerritorios.js). Nao
// "melhore" a rampa clareando o topo.
//
// Amarelo/laranja/vermelho foram descartados por semantica, nao por cor: sao
// a rampa de fogo do FIRMS e a convencao de severidade do resto do app.

/**
 * Classes de intensidade horaria (convencao WMO/INMET). `mm` e o piso da
 * classe, em milimetros acumulados na hora anterior — que e exatamente o que
 * o campo `precipitation` da Open-Meteo devolve.
 */
export const PRECIP_CLASSES = Object.freeze([
  Object.freeze({ key: 'chuvisco', mm: 0.2, label: 'CHUVISCO', color: '#7e22ce', alpha: 0.14, blurb: '0,2–1 mm/h' }),
  Object.freeze({ key: 'fraca', mm: 1.0, label: 'FRACA', color: '#9333ea', alpha: 0.32, blurb: '1–4 mm/h' }),
  Object.freeze({ key: 'moderada', mm: 4.0, label: 'MODERADA', color: '#b23fd6', alpha: 0.48, blurb: '4–10 mm/h' }),
  Object.freeze({ key: 'forte', mm: 10, label: 'FORTE', color: '#d946ef', alpha: 0.64, blurb: '10–25 mm/h' }),
  Object.freeze({ key: 'extrema', mm: 25, label: 'MUITO FORTE', color: '#e879f9', alpha: 0.80, blurb: '≥25 mm/h' }),
]);

/**
 * Abaixo disto nada e desenhado. Um estado seco tem que mostrar o mapa limpo,
 * nao um veu roxo de ruido — e 0,2 mm/h e o limiar de chuva mensuravel.
 */
export const PRECIP_FLOOR_MM = 0.2;

function hexBytes(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * mm/h -> [r, g, b, a] com componentes 0-255.
 *
 * Interpola ENTRE classes (linear no indice), nunca linear em mm. Precipitacao
 * e fortemente assimetrica: uma rampa linear em mm deixaria quase todo evento
 * real colado no piso invisivel, porque a escala inteira seria dominada pelos
 * raros 25+ mm/h.
 * @param {number} mm
 * @returns {[number, number, number, number]}
 */
export function precipRgba(mm) {
  const value = Number(mm);
  if (!Number.isFinite(value) || value < PRECIP_FLOOR_MM) return [0, 0, 0, 0];
  let index = 0;
  while (index < PRECIP_CLASSES.length - 1 && value >= PRECIP_CLASSES[index + 1].mm) index += 1;
  const lo = PRECIP_CLASSES[index];
  const hi = PRECIP_CLASSES[Math.min(index + 1, PRECIP_CLASSES.length - 1)];
  const span = hi.mm - lo.mm;
  const t = span > 0 ? Math.min(1, Math.max(0, (value - lo.mm) / span)) : 1;
  const a = hexBytes(lo.color);
  const b = hexBytes(hi.color);
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(255 * (lo.alpha + (hi.alpha - lo.alpha) * t)),
  ];
}

/**
 * Classe de uma celula, ou null se estiver seca.
 * @param {number} mm
 * @returns {string|null}
 */
export function precipClassOf(mm) {
  const value = Number(mm);
  if (!Number.isFinite(value) || value < PRECIP_FLOOR_MM) return null;
  let found = PRECIP_CLASSES[0];
  for (const klass of PRECIP_CLASSES) if (value >= klass.mm) found = klass;
  return found.key;
}

/**
 * Conta as celulas por classe. Percorre a grade uma vez; quem chama memoriza.
 * @param {ArrayLike<number>} cells
 * @returns {{counts: Record<string, number>, wet: number, maxMm: number}}
 */
export function tallyPrecip(cells) {
  const counts = {};
  let wet = 0;
  let maxMm = 0;
  for (let i = 0; i < (cells?.length ?? 0); i += 1) {
    const mm = Number(cells[i]) || 0;
    if (mm > maxMm) maxMm = mm;
    const key = precipClassOf(mm);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
    wet += 1;
  }
  return { counts, wet, maxMm };
}

/**
 * Legenda da linha do painel, no contrato do manager (`{label, color, count}`).
 *
 * O `color` e o hex OPACO, nao o composto com alpha: o quadradinho e uma CHAVE
 * sobre o vidro escuro do painel, e a 14% de alpha a classe chuvisco sumiria
 * ali. Classes sem celula nenhuma ficam de fora — a legenda nunca anuncia o
 * que nao esta na tela.
 * @param {Record<string, number>} counts
 * @returns {Array<{label: string, color: string, blurb: string, count: number}>}
 */
export function precipLegend(counts) {
  return PRECIP_CLASSES
    .filter((klass) => (counts?.[klass.key] || 0) > 0)
    .map((klass) => ({
      label: klass.label,
      color: klass.color,
      blurb: klass.blurb,
      count: counts[klass.key],
    }));
}
