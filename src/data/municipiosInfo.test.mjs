import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const info = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'data', 'municipios-info.json'), 'utf8'),
);
const ficha = fs.readFileSync(path.join(ROOT, 'src', 'datageoFicha.js'), 'utf8');
const municipios = Object.entries(info.municipios);

/**
 * public/data/municipios-info.json é gerado (scripts/build_municipios_info.py)
 * e commitado, então é ele, e não o gerador, que a ficha realmente lê. Uma
 * regeneração que perdesse um campo passaria despercebida sem estas travas.
 */

test('o arquivo cobre os 399 municípios e ninguém perdeu prefeito nem VBP', () => {
  assert.equal(municipios.length, 399);
  const semPrefeito = municipios.filter(([, e]) => !e.prefeito);
  const semVbp = municipios.filter(([, e]) => !e.vbp);
  // Uma rodada em que o TSE falhe deve ser resgatada pelo merge com o arquivo
  // anterior (merge_previous_mayors), não virar ficha sem prefeito.
  assert.ok(semPrefeito.length <= 1, `municípios sem prefeito: ${semPrefeito.map(([i]) => i)}`);
  assert.deepEqual(semVbp.map(([i]) => i), []);
});

test('todo município tem VBP/ha e a área do IBGE que o gerou', () => {
  const semHa = municipios.filter(([, e]) => !e.vbpHa);
  const semArea = municipios.filter(([, e]) => !(Number(e.areaKm2) > 0));
  assert.deepEqual(semHa.map(([i]) => i), []);
  assert.deepEqual(semArea.map(([i]) => i), []);
  // Soma das áreas ≈ área oficial do Paraná (199.307 km²).
  const totalKm2 = municipios.reduce((s, [, e]) => s + e.areaKm2, 0);
  assert.ok(Math.abs(totalKm2 - 199307) < 500, `soma das áreas: ${totalKm2.toFixed(0)} km²`);
});

test('o VBP/ha é o VBP dividido pelo TERRITÓRIO, não por área plantada', () => {
  // O denominador é a área total do município justamente porque metade do VBP
  // do PR vem de criações (avicultura, bovinocultura, suinocultura) que não
  // declaram área. Se alguém trocar o denominador por área plantada, os
  // valores sobem ~2x e esta conta quebra.
  for (const [ibge, e] of municipios) {
    const esperado = e.vbp.valB / (e.areaKm2 * 100);
    assert.ok(Math.abs(e.vbpHa.valB - esperado) < 0.02,
      `${ibge}: R$/ha ${e.vbpHa.valB} não bate com ${esperado.toFixed(2)}`);
    assert.equal(e.vbpHa.anoA, e.vbp.anoA);
    assert.equal(e.vbpHa.anoB, e.vbp.anoB);
  }
});

test('com área fixa, a variação do R$/ha é a mesma do valor — e isso é esperado', () => {
  // Não é redundância acidental: a área do município não muda entre 2024 e
  // 2025, então o percentual TEM que coincidir. O que o R$/ha acrescenta é o
  // nível. Se um dia os dois divergirem, o denominador passou a variar e a
  // ficha precisa dizer isso ao operador.
  for (const [ibge, e] of municipios) {
    assert.ok(Math.abs(e.vbpHa.deltaPct - e.vbp.deltaPct) <= 0.11,
      `${ibge}: delta R$/ha ${e.vbpHa.deltaPct} vs delta VBP ${e.vbp.deltaPct}`);
  }
});

test('o indicador separa território rural de território urbano', () => {
  // Sanidade do sentido: Curitiba (urbana) tem que ficar no fundo da escala e
  // um município agrícola intensivo no topo. Se isso inverter, o denominador
  // ou o numerador foi trocado.
  const porHa = municipios
    .map(([ibge, e]) => ({ ibge, ha: e.vbpHa.valB }))
    .sort((a, b) => a.ha - b.ha);
  const curitiba = porHa.findIndex((m) => m.ibge === '4106902');
  assert.ok(curitiba >= 0 && curitiba < 10,
    `Curitiba deveria estar entre os menores R$/ha, está na posição ${curitiba}`);
  assert.ok(porHa.at(-1).ha > porHa[0].ha * 50, 'a escala precisa ter amplitude real');
  for (const { ibge, ha } of porHa) {
    assert.ok(Number.isFinite(ha) && ha > 0, `${ibge} tem R$/ha inválido: ${ha}`);
  }
});

test('a ficha mostra o VBP/ha junto da tendência de valor, com a área que o gerou', () => {
  assert.match(ficha, /if \(info\.vbpHa\) \{/, 'a ficha precisa ler o campo vbpHa');
  const bloco = ficha.slice(ficha.indexOf('if (info.vbpHa) {'), ficha.indexOf('if (Array.isArray(info.produtos)'));
  assert.match(bloco, /VBP\/ha/);
  assert.match(bloco, /fmtBRL\(valB\)\}\/ha/, 'o nível é o que esta linha acrescenta, então vem primeiro');
  assert.match(bloco, /deltaPct/, 'e a tendência acompanha');
  assert.match(bloco, /areaKm2/, 'a área precisa aparecer, senão o R$/ha não é auditável');
});

test('as fontes declaram de onde vêm o VBP/ha e a área', () => {
  assert.match(info.fontes.vbpHa, /IBGE/);
  assert.match(info.fontes.vbpHa, /territorio municipal|território municipal/);
  assert.ok(info.fontes.areaKm2, 'a área tem fonte própria declarada');
});
