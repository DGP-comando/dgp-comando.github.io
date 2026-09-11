import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MUNICIPIO_SUGGESTION_LIMIT,
  exactMunicipioMatch,
  foldMunicipioText,
  municipioByIbge,
  municipioMatchRange,
  normalizeMunicipioQuery,
  searchMunicipios,
} from './municipioSearch.js';
import { PR_CENTROIDS } from './data/prCentroids.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');

/**
 * The defect this suite descends from (field report 2026-09-11, with the app
 * open on Cândido de Abreu): typing a município name sent the query to the
 * Google geocoder, which answered with a generic point and left the operator to
 * hunt for the polygon by hand. A município is not an address — it has an IBGE
 * code, a divisa and a ficha — so the name has to resolve against the table the
 * app already carries.
 */

test('a município name resolves to its IBGE code without touching the network', () => {
  const [first] = searchMunicipios('Cândido de Abreu');
  assert.equal(first.code, '4104402', 'the IBGE code is the identity datageoFicha opens on');
  assert.equal(first.name, 'Cândido de Abreu');
  assert.ok(Number.isFinite(first.lat) && Number.isFinite(first.lon),
    'and it carries coordinates, so the camera has somewhere to go even before the GeoJSON lands');
});

test('accents and case are optional, because nobody types ã ç é into a search box', () => {
  for (const typed of ['candido de abreu', 'CANDIDO DE ABREU', 'Cândido de Abreu', 'cândido de abreu']) {
    assert.equal(searchMunicipios(typed)[0]?.code, '4104402', `"${typed}" must find Cândido de Abreu`);
  }
  assert.equal(searchMunicipios('sao jose dos pinhais')[0]?.name, 'São José dos Pinhais');
  assert.equal(searchMunicipios('icaraima')[0]?.name, 'Icaraíma');
  // The apostrophe form is what the IBGE table spells; the keyboard form is not.
  assert.equal(searchMunicipios('sao jorge do oeste')[0]?.name, "São Jorge d'Oeste");
});

test('a partially typed name still finds it — and the exact name wins the list', () => {
  assert.equal(searchMunicipios('curit')[0]?.name, 'Curitiba');
  // "Toledo" is also a word inside longer names; the shorter exact one leads.
  assert.equal(searchMunicipios('toledo')[0]?.name, 'Toledo');
  // Dropping the connective words is how a long name is actually typed.
  assert.equal(searchMunicipios('sao jose pinhais')[0]?.name, 'São José dos Pinhais',
    'query tokens may skip name tokens, in order');
  // …but ONLY in order, so a reversed pair cannot grab the wrong município.
  const reversed = searchMunicipios('pinhais jose');
  assert.ok(!reversed.some((hit) => hit.name === 'São José dos Pinhais'),
    'order-free matching would make "boa vista" and "vista boa" the same place');
});

test('a bare 7-digit string is read as an IBGE code, the way SEAB and DATASUS spreadsheets carry it', () => {
  assert.equal(searchMunicipios('4104402')[0]?.name, 'Cândido de Abreu');
  assert.equal(searchMunicipios('41044')[0]?.code.startsWith('41044'), true, 'a code prefix narrows too');
  assert.equal(municipioByIbge('4106902')?.name, 'Curitiba');
  assert.equal(municipioByIbge('9999999'), null);
  assert.equal(municipioByIbge(undefined), null);
});

test('the list is bounded and never answers a blank box', () => {
  assert.deepEqual(searchMunicipios(''), []);
  assert.deepEqual(searchMunicipios('   '), []);
  assert.deepEqual(searchMunicipios(null), []);
  assert.deepEqual(searchMunicipios('zzzzzzzz'), []);
  // A single letter matches dozens of the 399; the box must not grow to fit.
  assert.ok(searchMunicipios('a').length <= MUNICIPIO_SUGGESTION_LIMIT);
  assert.equal(searchMunicipios('a', { limit: 3 }).length, 3);
  assert.ok(searchMunicipios('s').length <= MUNICIPIO_SUGGESTION_LIMIT);
});

test('ranking is stable, so the same keystrokes never reorder the list under the cursor', () => {
  const once = searchMunicipios('mar').map((hit) => hit.code);
  const twice = searchMunicipios('mar').map((hit) => hit.code);
  assert.deepEqual(once, twice);
  assert.ok(once.length > 1, 'the fixture only proves stability if there is something to order');
});

test('only a name written in full captures Enter — an address keeps going to the geocoder', () => {
  // This is the line between the two behaviours. "cascavel" is a município;
  // "rua Cascavel, Curitiba" is an address and must stay with the geocoder, or
  // the local table would start swallowing every street that shares a name.
  assert.equal(exactMunicipioMatch('cascavel')?.code, '4104808');
  assert.equal(exactMunicipioMatch('CASCAVEL')?.code, '4104808');
  assert.equal(exactMunicipioMatch('4104808')?.name, 'Cascavel');
  assert.equal(exactMunicipioMatch('rua Cascavel, Curitiba'), null);
  assert.equal(exactMunicipioMatch('casc'), null, 'a prefix is a suggestion, not a decision');
  assert.equal(exactMunicipioMatch(''), null);
  assert.equal(exactMunicipioMatch(null), null);

  // Written in full with the connective the keyboard uses rather than the one
  // the IBGE table spells. Nobody types the apostrophe.
  assert.equal(exactMunicipioMatch('sao jorge do oeste')?.name, "São Jorge d'Oeste");
  assert.equal(searchMunicipios('sao jorge do oeste')[0]?.name, "São Jorge d'Oeste");
  assert.equal(exactMunicipioMatch('diamante do oeste')?.name, "Diamante D'Oeste");
  // A core that is itself another município's full name belongs to that one.
  assert.equal(exactMunicipioMatch('sao joao')?.name, 'São João');
});

test('a trailing UF survives — typing ", PR" is the operator being precise, not a typo', () => {
  // Review finding 2026-09-11: every one of the 399 names went BACK to the
  // geocoder the moment the operator added the UF, which is the single most
  // common way a Brazilian município is written. The careful operator was the
  // one the feature failed.
  for (const typed of ['Cascavel, PR', 'cascavel/pr', 'Cascavel - PR', 'cascavel, paraná', 'Cascavel PR, Brasil']) {
    assert.equal(searchMunicipios(typed)[0]?.code, '4104808', `"${typed}" must still find Cascavel`);
    assert.equal(exactMunicipioMatch(typed)?.code, '4104808', `"${typed}" must still capture Enter`);
  }
  assert.equal(searchMunicipios('foz do iguacu, PR')[0]?.name, 'Foz do Iguaçu');

  // The pruning runs ONLY after the whole query has failed, because three real
  // municípios END in "Paraná" and would otherwise be stolen from themselves.
  for (const name of ['São Pedro do Paraná', 'Alto Paraná', 'Tunas do Paraná']) {
    const full = exactMunicipioMatch(name);
    assert.equal(full?.name, name, `"${name}" must resolve to itself, not to a UF-pruned neighbour`);
    assert.equal(searchMunicipios(name)[0]?.name, name);
  }
  // "paranavai" is not "parana" + a UF, and must not be pruned into one.
  assert.equal(exactMunicipioMatch('paranavai')?.name, 'Paranavaí');
  // A bare UF is not a município; pruning must never empty the query itself.
  assert.equal(exactMunicipioMatch('pr'), null);
  assert.equal(exactMunicipioMatch('parana'), null);
});

test('the highlight range indexes the ACCENTED name, so it cannot slide off a ç or ã', () => {
  // NFD + mark-strip is length-preserving against the NFC original; that is the
  // only reason an index computed on the folded string is valid on the real one.
  for (const [, name] of PR_CENTROIDS) {
    assert.equal(foldMunicipioText(name).length, name.length,
      `folding changed the length of "${name}" — every highlight offset would be wrong`);
  }
  const range = municipioMatchRange('Cândido de Abreu', 'candi');
  assert.deepEqual(range, { start: 0, length: 5 });
  assert.equal('Cândido de Abreu'.slice(range.start, range.start + range.length), 'Cândi');

  const inner = municipioMatchRange('Foz do Iguaçu', 'guacu');
  assert.equal('Foz do Iguaçu'.slice(inner.start, inner.start + inner.length), 'guaçu');

  // Multi-word queries match by token, not as a contiguous run; no highlight is
  // honest there, and a wrong one would be worse than none.
  assert.equal(municipioMatchRange('São José dos Pinhais', 'sao jose pinhais'), null);
  assert.equal(municipioMatchRange('Curitiba', 'londrina'), null);
});

test('normalization folds punctuation but keeps word boundaries', () => {
  assert.equal(normalizeMunicipioQuery("São Jorge d'Oeste"), 'sao jorge d oeste');
  assert.equal(normalizeMunicipioQuery('  ALTÔNIA  '), 'altonia');
  assert.equal(normalizeMunicipioQuery('Santa Cruz de Monte Castelo'), 'santa cruz de monte castelo');
  assert.equal(normalizeMunicipioQuery(''), '');
  assert.equal(normalizeMunicipioQuery(undefined), '');
});

test('every one of the 399 municípios is reachable by its own full name', () => {
  // The table is generated (scripts/build_municipios_info.py); a name it spells
  // in a way the matcher cannot fold would be invisible in the box forever.
  assert.equal(PR_CENTROIDS.length, 399);
  const unreachable = PR_CENTROIDS.filter(([code, name]) => exactMunicipioMatch(name)?.code !== code);
  assert.deepEqual(unreachable, []);
});

test('ui.js resolves the município BEFORE the geocoder, and opens the ficha after the flight', () => {
  // ui.js cannot be imported under node (Cesium's `mgrs` dependency), so the
  // wiring is pinned against its source. What must hold: the local table is
  // consulted first, the camera and the ficha move together, and the ficha is
  // opened with the IBGE code — the identity a geocode result never has.
  const handler = ui.slice(
    ui.indexOf("this._locationSearch.addEventListener('keydown'"),
    ui.indexOf('searchAndFlyTo(this.viewer, query, {'),
  );
  assert.ok(handler.length > 0, 'the location search keydown handler is missing');
  assert.match(handler, /const municipio = this\._pickedMunicipioSuggestion\(\);[\s\S]{0,200}?this\._flyToMunicipioResult\(municipio\);/,
    'Enter must consult the local município table before reaching the geocoder');

  const start = ui.indexOf('  _flyToMunicipioResult(match) {');
  assert.ok(start > 0, '_flyToMunicipioResult is missing');
  const body = ui.slice(start, ui.indexOf('\n  _resetLocationSearchInput()', start));
  assert.match(body, /flyToMunicipio\(this\.viewer, \{/, 'the camera is framed on the município');
  assert.match(body, /getMunicipioFocus\?\.\(match\.code\)/,
    'and framed on the real divisa when the GeoJSON has loaded');
  assert.match(body, /openMunicipioFicha\?\.\(\{ ibge: match\.code/,
    'the ficha opens on the IBGE code — that is the whole reason not to geocode');
  assert.match(body, /this\._searchedLocationLabel = `\$\{match\.name\} \(PR\)`;[\s\S]{0,160}?this\._setActiveLocation\(null\);/,
    'the LOCATION readout is written after the flight, like every other destination');
});

test('only the primary mouse button picks a suggestion', () => {
  // Review finding 2026-09-11: the option listener is mousedown (so it beats
  // the input's blur), but mousedown fires for every button. Right-clicking a
  // row flew the camera and opened the ficha — alongside the context menu,
  // which preventDefault on a secondary-button mousedown does not suppress.
  const start = ui.indexOf('  _renderMunicipioSuggestions(query) {');
  assert.ok(start > 0, '_renderMunicipioSuggestions is missing');
  const body = ui.slice(start, ui.indexOf('\n  _buildMunicipioOptionLabel', start));
  assert.match(
    body,
    /option\.addEventListener\('mousedown', \(event\) => \{\s*\r?\n\s*if \(event\.button !== 0\) return;/,
    'the button guard must come first, before preventDefault and before the flight',
  );
});

test('the command dock clips the pills row sideways only, so the list can open upward', () => {
  // Review finding 2026-09-11, reproduced in a real browser by three reviewers:
  // `#command-dock .location-city-row { overflow: hidden }` clipped BOTH axes.
  // The list was built, marked visible and took arrow keys — and painted zero
  // pixels, because it opens upward out of that row. `hidden` cannot be paired
  // with `overflow-y: visible` (CSS turns the pair into `auto`), so the
  // horizontal clip has to be `clip` for the vertical one to be released.
  // The selector appears more than once, so check EVERY occurrence: a single
  // stray `overflow: hidden` anywhere in the cascade re-clips the list.
  // Comments stripped first, or this pin matches the prose that EXPLAINS the
  // retired declaration instead of the declaration itself.
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/#command-dock \.location-city-row \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rules.length > 0, 'the #command-dock .location-city-row rule is missing');
  for (const rule of rules) {
    // `clip` is not an escape hatch either: measured in Chrome at 1440px and
    // 390px, `overflow-x: clip; overflow-y: visible` still drops the list out
    // of hit-testing. Only a fully unclipped row gives the click back.
    assert.doesNotMatch(rule, /overflow(-x|-y)?:\s*(hidden|clip)/,
      'any clip on this row makes the list unclickable while it still takes arrow keys');
  }

  // …and the list still has to be anchored to the wrap, or the fix is moot.
  const wrap = css.slice(css.indexOf('.location-search-wrap {'));
  assert.match(wrap.slice(0, 200), /position:\s*relative/);
});
