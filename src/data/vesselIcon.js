// src/data/vesselIcon.js
//
// Ícone SVG de navio (vista de cima, proa para cima) e a regra de ESCALA dos
// billboards da camada marítima. Puro: o Cesium é montado em datageoLayers.
//
// Duas representações por navio, trocadas pela distância da câmera:
// - PERTO (< VESSEL_METERS_MAX_DISTANCE): billboard em METROS, com o
//   comprimento real (LOA) e boca estimada, então um navio de 300 m ocupa na
//   tela o mesmo que o navio na imagem de satélite, sem ficar desproporcional
//   ao cais;
// - LONGE: billboard em PIXELS, com tamanho quase fixo (leve proporção ao
//   LOA), porque em metros ele sumiria abaixo de 1 px na escala estadual.
// A distância de troca foi escolhida para os dois tamanhos quase coincidirem
// (ver farIconPixels): não há "salto" visível na transição.
//
// O SVG é branco com contorno escuro: billboard.color tinge o casco e mantém
// o contorno legível sobre água e sobre o cais.

export const VESSEL_METERS_MAX_DISTANCE = 12_000;
export const DEFAULT_LOA_M = 150;
/** Relação típica comprimento/boca de navios mercantes (graneleiros e porta-contêineres). */
const LOA_BEAM_RATIO = 6.5;
const MIN_BEAM_M = 10;

const SHIP_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="160" viewBox="0 0 40 160">',
  // casco: proa afilada em cima, popa arredondada embaixo
  '<path d="M20 3 C29 19 34 40 34 62 L34 145 Q34 157 20 157 Q6 157 6 145 L6 62 C6 40 11 19 20 3 Z"',
  ' fill="#ffffff" stroke="#0f172a" stroke-opacity="0.85" stroke-width="3"/>',
  // superestrutura (ponte) perto da popa
  '<rect x="11" y="118" width="18" height="17" rx="2" fill="#0f172a" fill-opacity="0.55"/>',
  // linha de centro, dá leitura de direção mesmo pequeno
  '<line x1="20" y1="22" x2="20" y2="112" stroke="#0f172a" stroke-opacity="0.35" stroke-width="2"/>',
  '</svg>',
].join('');

export const SHIP_ICON_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SHIP_SVG)}`;

/** Comprimento e boca em metros; LOA ausente ou absurdo cai no padrão. */
export function shipDimensions(loaM) {
  const loa = Number(loaM);
  const lengthM = loaM !== null && loaM !== undefined && Number.isFinite(loa) && loa >= 10 && loa <= 460
    ? loa
    : DEFAULT_LOA_M;
  return { lengthM, beamM: Math.max(MIN_BEAM_M, lengthM / LOA_BEAM_RATIO) };
}

/**
 * Tamanho em pixels do ícone distante. Com FOV vertical ~60° numa tela de
 * ~900 px, a 12 km 1 m ≈ 0,065 px: 300 m ≈ 19 px e 150 m ≈ 10 px. O ícone
 * longe acompanha isso com piso legível de 12 px e teto de 22 px.
 */
export function farIconPixels(loaM) {
  const { lengthM } = shipDimensions(loaM);
  const height = Math.round(Math.min(22, Math.max(12, lengthM * 0.065)));
  return { height, width: Math.max(4, Math.round(height / 4)) };
}

/** Rumo em graus -> rotação do billboard (radianos, anti-horária) com eixo alinhado ao norte. */
export function headingToRotation(headingDeg, fallbackDeg = 45) {
  const h = Number(headingDeg);
  const deg = headingDeg !== null && headingDeg !== undefined && Number.isFinite(h) ? h : fallbackDeg;
  return -(((deg % 360) + 360) % 360) * (Math.PI / 180);
}
