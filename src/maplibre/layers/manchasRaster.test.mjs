import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areasManchas, caixasManchas, cantoLonLat, contornoPixels, encadeia, pixelDe, rotulaManchas, simplifica,
} from './manchasRaster.js';

const BBOX = [-50.4, -25.4, -49.6, -24.8];
const TAM = [800, 700];

test('cantos da imagem caem nos pixels das pontas', () => {
  assert.deepEqual(pixelDe([-50.4, -24.8], BBOX, TAM), [0, 0]);
  assert.deepEqual(pixelDe([-49.6001, -25.3999], BBOX, TAM), [799, 699]);
});

test('vertical em Web Mercator, não linear na latitude', () => {
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const latMeio = (2 * Math.atan(Math.exp((merc(-24.8) + merc(-25.4)) / 2)) - Math.PI / 2) * (180 / Math.PI);
  assert.deepEqual(pixelDe([-50.0, latMeio - 1e-9], BBOX, TAM), [400, 350]);
  assert.notEqual(pixelDe([-50.0, -25.1], BBOX, TAM)[1], 350);
});

test('fora da imagem devolve null', () => {
  assert.equal(pixelDe([-50.5, -25.0], BBOX, TAM), null);
  assert.equal(pixelDe([-50.0, -24.7], BBOX, TAM), null);
  assert.equal(pixelDe([-49.6, -25.0], BBOX, TAM), null);
});

// Grade 4x3 de cores: A=verde, B=rosa, . = transparente.
//   A A . B
//   . . B A      <- o A da direita só toca o B na diagonal
//   B B B A
const A = [0x26, 0x73, 0, 255];
const B = [0xff, 0x73, 0xdf, 255];
const T = [0, 0, 0, 0];
const grade = (linhas) => Uint8ClampedArray.from(linhas.flat(2));

test('manchas por cor, ligando também pela diagonal; transparente fica sem rótulo', () => {
  const rgba = grade([[A, A, T, B], [T, T, B, A], [B, B, B, A]]);
  const { rotulo, manchas } = rotulaManchas(rgba, 4, 3);
  assert.equal(manchas, 3); // A esquerda, todo o B (o do topo liga pela diagonal), A direita
  assert.equal(rotulo[0], rotulo[1]);
  assert.equal(rotulo[2], 0);
  assert.equal(rotulo[3], rotulo[6]); // B do topo e B do meio se tocam pelo canto
  assert.equal(rotulo[6], rotulo[8]);
  assert.equal(rotulo[7], rotulo[11]);
  assert.notEqual(rotulo[0], rotulo[7]); // mesma cor, sem contato: manchas diferentes
});

test('rio em diagonal (escada de pixels) é um polígono só', () => {
  const n = 50;
  const rgba = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n; i++) rgba.set(A, (i * n + i) * 4);
  const { manchas } = rotulaManchas(rgba, n, n);
  assert.equal(manchas, 1);
});

test('área das manchas soma a área do retângulo na esfera', () => {
  const w = 400;
  const h = 300;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const m = rotulaManchas(rgba, w, h);
  const bbox = [-50.4, -25.4, -49.6, -24.8];
  const ha = areasManchas(m, w, h, bbox);
  const R = 6378137;
  const rad = (g) => (g * Math.PI) / 180;
  const esfera = (R * R * rad(0.8) * (Math.sin(rad(-24.8)) - Math.sin(rad(-25.4)))) / 1e4;
  assert.equal(m.manchas, 1);
  assert.ok(Math.abs(ha[1] - esfera) / esfera < 0.002, `${ha[1]} vs ${esfera}`);
});

const contorno = (linhas) => {
  const w = linhas[0].length;
  const h = linhas.length;
  const rotulo = Int32Array.from(linhas.join('').split('').map((c) => (c === '#' ? 1 : 0)));
  const caixa = caixasManchas({ rotulo, manchas: 1 }, w, h).subarray(4, 8);
  return contornoPixels(rotulo, w, h, caixa, 1);
};
const perimetro = (segs) => segs.reduce((a, [p, q]) => a + Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]), 0);

test('contorno: pixel isolado tem 4 arestas', () => {
  const segs = contorno(['...', '.#.', '...']);
  assert.equal(segs.length, 4);
  assert.equal(perimetro(segs), 4);
});

test('contorno: arestas em linha emendam num segmento só', () => {
  const segs = contorno(['###', '###']);
  assert.equal(segs.length, 4);
  assert.equal(perimetro(segs), 10);
  assert.ok(segs.some(([p, q]) => p[1] === 0 && q[1] === 0 && p[0] === 0 && q[0] === 3), 'topo inteiro');
});

test('contorno: forma em L tem 6 lados e o perímetro certo', () => {
  const segs = contorno(['#..', '#..', '###']);
  assert.equal(segs.length, 6);
  assert.equal(perimetro(segs), 12);
});

test('cantos da imagem viram os cantos do bbox', () => {
  const bbox = [-50.4, -25.4, -49.6, -24.8];
  const [lo0, la0] = cantoLonLat(0, 0, 800, 700, bbox);
  const [lo1, la1] = cantoLonLat(800, 700, 800, 700, bbox);
  assert.ok(Math.abs(lo0 + 50.4) < 1e-9 && Math.abs(la0 + 24.8) < 1e-9);
  assert.ok(Math.abs(lo1 + 49.6) < 1e-9 && Math.abs(la1 + 25.4) < 1e-9);
  // Ida e volta com pixelDe.
  assert.deepEqual(pixelDe(cantoLonLat(123.5, 456.5, 800, 700, bbox), bbox, [800, 700]), [123, 456]);
});

test('contorno encadeado: o L vira um anel fechado de 7 pontos', () => {
  const linhas = encadeia(contorno(['#..', '#..', '###']));
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].length, 7);
  assert.deepEqual(linhas[0][0], linhas[0].at(-1));
});

test('simplifica: escada de pixels vira reta, quina de verdade fica', () => {
  const escada = [[0, 0]];
  for (let i = 1; i <= 20; i++) escada.push([i - 1, i], [i, i]);
  assert.deepEqual(simplifica(escada, 0.75), [[0, 0], [20, 20]]);
  assert.equal(simplifica([[0, 0], [10, 0], [10, 10]], 0.75).length, 3);
});
