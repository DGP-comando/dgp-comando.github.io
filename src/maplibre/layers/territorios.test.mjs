// Territórios e CAR no protótipo MapLibre: feições, rótulos, tooltips e a
// escolha de células do CAR. Roda com `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTerritorioFeatures, cellFeatures, cellsInBbox, flatToCoords, wantedCells,
} from './territoriosFeatures.js';
import {
  agregadoMunicipal, centroidOf, dataBr, fichaRegionalIdr, fmtReais, listaNomes, TERRITORIO_SPECS, tituloProprio, tituloUc,
} from '../../data/territoriosSpec.js';
import { CAR_CLASSE_STYLES, carTooltip } from '../../data/carClasses.js';
import layers, { carLayer } from './territorios.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const square = (x, y, s = 1) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

test('camadas na ordem e com os ids/categorias do app', () => {
  assert.deepEqual(layers.map((l) => l.id), [
    'datageo-terras-indigenas', 'datageo-quilombolas', 'datageo-assentamentos', 'datageo-faxinais-territorios',
    'datageo-ucs-federais', 'datageo-ucs-estaduais', 'datageo-regionais-idr', 'datageo-associacoes', 'datageo-car',
  ]);
  const cat = Object.fromEntries(layers.map((l) => [l.id, l.category]));
  assert.equal(cat['datageo-terras-indigenas'], 'Territórios e povos');
  assert.equal(cat['datageo-ucs-federais'], 'Ambiente');
  assert.equal(cat['datageo-car'], 'Agricultura familiar e CAR');
  // Todas têm tooltip (UCs e CAR incluídos); o CAR responde por uma linha de pick larga.
  for (const l of layers) {
    assert.ok(l.interactive.length > 0 && typeof l.tooltip === 'function', l.id);
  }
  assert.deepEqual(carLayer.interactive, ['dg-car-hit']);
  const hit = carLayer.layers.find((l) => l.id === 'dg-car-hit');
  assert.ok(hit.paint['line-width'] >= 10 && hit.paint['line-opacity'] < 0.05);
  assert.ok(layers.find((l) => l.id === 'datageo-regionais-idr').click);
  assert.ok(carLayer.focusOn && carLayer.onEnable && carLayer.onDisable);
});

test('CAR: legenda por classe filtra a divisa e a linha de pick', () => {
  const legend = carLayer.rowControls().legend;
  assert.deepEqual(legend.map((l) => l.key), ['0-4', '4-10', '10-20', '20-50', '>50']);
  assert.equal(legend[0].label, 'até 4 módulos fiscais');
  assert.equal(legend[4].color, CAR_CLASSE_STYLES['>50'].css);
  assert.equal(carLayer.legendFilter, 'classe');
  assert.ok(carLayer.layers.every((l) => l.metadata?.['dg:legenda'] !== false));
});

test('buildTerritorioFeatures: partes válidas, borda fechada pelo anel externo, rótulo no centroide', () => {
  const gj = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { nome: 'A' }, geometry: { type: 'Polygon', coordinates: [square(0, 0, 2), square(0.5, 0.5, 0.5)] } },
      { type: 'Feature', properties: { nome: 'B' }, geometry: null },
      {
        type: 'Feature',
        properties: { nome: 'C' },
        geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 1], [0, 0]]], [square(10, 10).slice(0, 4)]] },
      },
    ],
  };
  const out = buildTerritorioFeatures(gj, (p) => `R ${p.nome}`);
  assert.equal(out.count, 2, 'feição sem geometria não conta');
  assert.deepEqual(out.props.map((p) => p.nome), ['A', 'C']);
  assert.equal(out.fills.features.length, 2);
  assert.deepEqual(out.fills.features.map((f) => f.id), [0, 1]);
  // Parte degenerada (3 vértices) descartada.
  assert.equal(out.fills.features[1].geometry.coordinates.length, 1);
  // Borda só do anel externo, fechada mesmo quando o anel não vem fechado.
  const borderA = out.borders.features[0].geometry.coordinates;
  assert.equal(borderA.length, 1);
  const ringC = out.borders.features[1].geometry.coordinates[0];
  assert.deepEqual(ringC[0], ringC[ringC.length - 1]);
  assert.deepEqual(out.labels.features[0].geometry.coordinates, centroidOf([square(0, 0, 2)]));
  assert.equal(out.labels.features[1].properties.label, 'R C');
});

test('rótulos e tooltips iguais aos do app', () => {
  const S = TERRITORIO_SPECS;
  assert.equal(S.terrasIndigenas.labelOf({ nome: 'TI Marrecas', area_ha: 16838.4 }), 'TI Marrecas · 16.838 ha');
  assert.equal(S.terrasIndigenas.labelOf({ nome: 'Apucaraninha' }), 'TI Apucaraninha');
  assert.equal(S.quilombolas.labelOf({ nome: 'Paiol de Telha', fase: 'RTID' }), 'TQ Paiol de Telha (RTID)');
  assert.equal(S.ucsFederais.labelOf({ nome: 'RESERVA BIOLÓGICA DAS PEROBAS' }), 'Reserva Biológica das Perobas');
  assert.equal(S.regionaisIdr.labelOf({ regional: 'Ponta Grossa' }), 'IDR Ponta Grossa');
  assert.equal(S.assentamentos.labelOf({ nome: 'PA X', familias: 12 }), 'PA X · 12 famílias');

  const tip = S.assentamentos.tooltipOf({
    nome: 'PA <X>', municipio: 'RIO BONITO DO IGUAÇU', area_ha: 1234.5, familias: 10, capacidade: 12, fase: '', codigo: 'PR0001',
    criacao: '14/08/1996',
  }, {});
  assert.match(tip, /^<div class="tt">/);
  assert.match(tip, /<span class="tt-title">PA &lt;x&gt;<\/span>/);
  assert.match(tip, /Projeto de assentamento · Rio Bonito do Iguaçu/);
  assert.match(tip, /<dt>Área<\/dt><dd class="">1\.235 ha · 12,3 km²<\/dd>/);
  assert.match(tip, /<dd class="tt-warn">10 de 12 lotes \(83%\)<\/dd>/);
  assert.match(tip, /123,5 ha por família/);
  assert.match(tip, /14\/08\/1996 \(há \d+ anos\)/);
  assert.doesNotMatch(tip, /Fase|tt-badge/, 'fase vazia: sem badge');
  assert.match(tip, /<div class="tt-foot">INCRA\/SIPRA · DataGeo PR<\/div>/);

  const x = {
    info: {
      1: { pop: { ano: '2025', valor: 1000 }, areaKm2: 10, vbp: { anoB: '2025', valB: 2_500_000_000 } },
      2: { pop: { ano: '2025', valor: 500 }, areaKm2: 5.4, vbp: { anoB: '2025', valB: 0 } },
    },
    nomes: { 1: 'Irati', 2: 'Imbituva' },
  };
  const reg = S.regionaisIdr.tooltipOf({ regional: 'Irati', municipios: ['1', '2'] }, x);
  assert.match(reg, /tt-title">Regional Irati</);
  assert.match(reg, /IDR-Paraná · 2 municípios/);
  assert.match(reg, /<dt>População<\/dt><dd class="">1\.500 hab\. \(2025\)/);
  assert.match(reg, /<dt>VBP agro 2025<\/dt><dd class="">R\$ 2,50 bi/);
  assert.match(reg, /<dt>Municípios<\/dt><dd class="">Imbituva, Irati<\/dd>/);
  assert.match(reg, /clique para abrir a ficha regional/i);
  // Sem os dados municipais: só a contagem.
  const regSem = S.regionaisIdr.tooltipOf({ regional: 'Irati', municipios: ['1', '2'] }, {});
  assert.match(regSem, /<dt>Municípios<\/dt><dd class="">2<\/dd>/);
  assert.doesNotMatch(regSem, /População/);

  const assoc = S.associacoes.tooltipOf({ sigla: 'AMCG', nome: 'Associação X', municipios: ['1', '2'] }, x);
  assert.match(assoc, /tt-title">AMCG</);
  assert.match(assoc, /tt-sub">Associação X</);

  const uc = S.ucsEstaduais.tooltipOf({
    cnuc: '0000.41.0529', nome: 'PARQUE ESTADUAL DA ILHA DO MEL', categoria: 'Parque', grupo: 'Proteção Integral',
    esfera: 'Estadual', area_ha: 394.72, criacao: '22-03-2002', gestor: 'INSTITUTO AMBIENTAL DO PARANÁ - PR',
    plano_manejo: 'Não',
  }, { municipio: { ibge: '4118204', nome: 'Paranaguá' } });
  assert.match(uc, /tt-title">Parque Estadual da Ilha do Mel</);
  assert.match(uc, /tt-sub">Parque · UC estadual</);
  assert.match(uc, /tt-badge tt-ok">Proteção integral</);
  assert.match(uc, /22\/03\/2002/);
  assert.match(uc, /IAT \(Instituto Água e Terra/);
  assert.match(uc, /<dt>Plano de manejo<\/dt><dd class="tt-warn">Não<\/dd>/);
  assert.match(uc, /<dt>Município<\/dt><dd class="">Paranaguá<\/dd>/);
  assert.match(uc, /0000\.41\.0529/);

  const ti = S.terrasIndigenas.tooltipOf({ nome: 'TI Rio Areia', etapa: 'Regularizada', area_ha: 1363.89 }, {});
  assert.match(ti, /tt-title">TI Rio Areia</);
  assert.match(ti, /tt-badge tt-ok">Regularizada</);
  assert.match(ti, /1\.364 ha · 13,6 km²/);

  const tq = S.quilombolas.tooltipOf({ nome: 'Mamãs', municipio: '', fase: 'RTID' }, { municipio: { nome: 'Cerro Azul' } });
  assert.match(tq, /tt-sub">Cerro Azul</);
  assert.match(tq, /Relatório Técnico de Identificação/);

  assert.equal(tituloProprio('PA FAZENDA ESTRELA II'), 'PA Fazenda Estrela II');
  assert.equal(dataBr('21-03-2006'), '21/03/2006');
  assert.equal(fmtReais(45_600_000), 'R$ 45,6 mi');
  assert.equal(fmtReais(0), '');
  assert.equal(listaNomes(['1', '2', '3'], { 1: 'C', 2: 'A', 3: 'B' }, 2), 'A, B e mais 1');
  assert.equal(agregadoMunicipal(['9'], x.info), null);
  assert.deepEqual(fichaRegionalIdr({ regional: 'Irati', municipios: ['1'] }), {
    nome: 'Regional Irati', meta: 'IDR-Paraná · 1 município', ibges: ['1'],
  });
  assert.equal(tituloUc('PARQUE ESTADUAL DE VILA VELHA'), 'Parque Estadual de Vila Velha');
});

test('GeoJSONs reais: toda feição rende rótulo e tooltip sem erro', () => {
  for (const spec of Object.values(TERRITORIO_SPECS)) {
    const gj = readJson(path.join('public', spec.url));
    const out = buildTerritorioFeatures(gj, spec.labelOf);
    assert.ok(out.count > 0, spec.id);
    assert.equal(out.labels.features.length, out.fills.features.length, `${spec.id}: rótulo por polígono`);
    for (const f of out.labels.features) assert.ok(f.properties.label.length > 0, `${spec.id}: rótulo vazio`);
    assert.ok(spec.tooltipOf, `${spec.id}: sem tooltip`);
    for (const p of out.props) {
      const html = spec.tooltipOf(p, {});
      assert.match(html, /^<div class="tt">.*tt-title">[^<]+</, spec.id);
      assert.doesNotMatch(html, /undefined|NaN|null/, `${spec.id}: ${html}`);
    }
  }
});

test('CAR: célula real vira MultiLineString por classe, com todos os trechos', () => {
  const index = readJson('public/data/car/index.json');
  const key = Object.keys(index.cells)[0];
  const payload = readJson(`public/data/car/${key}.json`);
  const { features, lines } = cellFeatures(payload, key, index);
  assert.equal(lines, index.cells[key]);
  assert.equal(features.reduce((a, f) => a + f.geometry.coordinates.length, 0), lines);
  for (const f of features) {
    assert.ok(CAR_CLASSE_STYLES[f.properties.classe], `classe sem estilo: ${f.properties.classe}`);
    assert.equal(f.geometry.type, 'MultiLineString');
  }
  // Coordenadas dentro (ou na borda generalizada) da célula.
  const [i, j] = key.split('_').map(Number);
  const [lon, lat] = features[0].geometry.coordinates[0][0];
  assert.ok(Math.abs(lat - (i + 0.5) * index.cell_deg) < index.cell_deg);
  assert.ok(Math.abs(lon - (j + 0.5) * index.cell_deg) < index.cell_deg);
  assert.deepEqual(flatToCoords([1, 2, 3, 4]), [[1, 2], [3, 4]]);
});

test('CAR: tooltip pela classe, com o agregado do estado e do município sob o cursor', () => {
  const stats = readJson('public/data/car-municipios.json');
  const html = carTooltip('20-50', { stats, municipio: { ibge: '4100103', nome: 'Abatiá' } });
  assert.match(html, /tt-title">Imóvel rural \(CAR\)</);
  assert.match(html, /tt-badge tt-alert">Grande propriedade</);
  assert.match(html, /20 a 50 módulos fiscais/);
  assert.match(html, /tt-sec-title">Em Abatiá<\/div>.*<dt>Imóveis na classe<\/dt><dd class="">2 de 887 \(0,2%\)/);
  assert.match(html, /tt-sec-title">No Paraná<\/div>.*<dt>Imóveis na classe<\/dt><dd class="">4\.512 de 532\.776/);
  assert.match(html, /SICAR\/SFB · DataGeo PR · atualizado/);
  // Sem agregado nem município: só a classe.
  const nu = carTooltip('0-4');
  assert.match(nu, /tt-badge tt-ok">Pequena propriedade</);
  assert.doesNotMatch(nu, /tt-sec|undefined|NaN/);
  for (const c of Object.keys(CAR_CLASSE_STYLES)) assert.doesNotMatch(carTooltip(c, { stats }), /undefined|NaN/);
});

test('CAR: células da vista e do município em foco', () => {
  const index = { cell_deg: 0.25, cells: {} };
  for (let i = -104; i <= -96; i++) for (let j = -212; j <= -200; j++) index.cells[`${i}_${j}`] = 1;
  // Sem foco: as 9 mais próximas do centro (nearestCells do app).
  const view = wantedCells({ lat: -25.1, lon: -51.1 }, index);
  assert.equal(view.length, 9);
  assert.equal(view[0], '-101_-205');
  // Com foco: todas as do bbox, até o teto, da mais próxima do centro.
  const bbox = [-51.6, -25.6, -50.4, -24.6];
  const all = cellsInBbox(bbox, index, 100);
  assert.equal(all.length, 5 * 6);
  assert.equal(wantedCells({ lat: -25.1, lon: -51.1 }, index, { focus: bbox, focusCap: 24 }).length, 24);
  assert.equal(wantedCells({ lat: -25.1, lon: -51.1 }, index, { focus: bbox })[0], '-101_-205');
  // Só células existentes.
  assert.deepEqual(cellsInBbox([0, 0, 1, 1], index), []);
});
