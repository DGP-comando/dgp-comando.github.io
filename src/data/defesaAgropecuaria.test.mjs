// node --test src/data/defesaAgropecuaria.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  ADAPAR_LABEL_DIST, AGROTOXICOS_LEGENDA, ANIMAIS_LEGENDA, CONSOLIDACAO_LEGENDA, EXPLORACOES_CORES, FERTILIZANTES_LEGENDA,
  INDUSTRIAS_LEGENDA, UNIDADES_LEGENDA, VETERINARIOS_LEGENDA, agrotoxicoEstilo, agrotoxicoGrupo, animaisVivosEstilo, consolidacaoEstilo,
  consolidacaoTooltip, exploracaoTooltip, fertilizanteEstilo, industriaEstilo, listaCurta, unidadeAdaparEstilo, unidadeAdaparTooltip,
  veterinarioEstilo, veterinarioTooltip,
} from './defesaAgropecuariaEstilos.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { LAYER_ORDER } from '../maplibre/layers/index.js';
import layers, { DEFESA_AGROPECUARIA, exploracoesFeatures, gunzipJson } from '../maplibre/layers/defesaAgropecuaria.js';

// data/privado/ fica fora do git: os testes com dado real só rodam onde o arquivo existe.
const PRIV = (n) => new URL(`../../data/privado/${n}`, import.meta.url);
const EXPLORACOES = 'adapar-exploracoes.json.gz';

const PONTOS = [
  ['adapar-veterinarios-pr.geojson', veterinarioEstilo, VETERINARIOS_LEGENDA, 1500],
  ['adapar-animais-vivos-pr.geojson', animaisVivosEstilo, ANIMAIS_LEGENDA, 100],
  ['adapar-agrotoxicos-pr.geojson', agrotoxicoEstilo, AGROTOXICOS_LEGENDA, 1000],
  ['adapar-fertilizantes-pr.geojson', fertilizanteEstilo, FERTILIZANTES_LEGENDA, 1500],
  ['adapar-unidades-consolidacao-pr.geojson', consolidacaoEstilo, CONSOLIDACAO_LEGENDA, 200],
  ['adapar-industrias-poa-pr.geojson', industriaEstilo, INDUSTRIAS_LEGENDA, 60],
];

test('camadas: categoria Defesa Agropecuária, bucket privado, token D* e ícone e contorno próprios', () => {
  assert.deepEqual(layers.map((l) => l.id), [
    'datageo-adapar-unidades', 'datageo-adapar-exploracoes', 'datageo-adapar-veterinarios', 'datageo-adapar-animais-vivos',
    'datageo-adapar-agrotoxicos', 'datageo-adapar-fertilizantes', 'datageo-adapar-unidades-consolidacao',
    'datageo-adapar-industrias-poa',
  ]);
  for (const l of layers) {
    assert.equal(l.category, DEFESA_AGROPECUARIA);
    const token = LAYER_STATE_REGISTRY.find((e) => e.id === l.id)?.token;
    assert.match(token ?? '', /^D[a-z]$/, `${l.id} sem token D*`);
    assert.ok(LAYER_ORDER.includes(l.id), `${l.id} fora de LAYER_ORDER`);
  }
  assert.equal(new Set(layers.map((l) => l.icon)).size, layers.length, 'um ícone por camada');
  const contornos = layers.filter((l) => l.id !== 'datageo-adapar-exploracoes').flatMap((l) => l.layers.filter((s) => s.type === 'circle'))
    .map((s) => `${s.paint['circle-stroke-color']}/${s.paint['circle-stroke-width']}`);
  assert.equal(new Set(contornos).size, layers.length - 1, contornos.join(' '));
  const cores = [...PONTOS.flatMap(([, , legenda]) => legenda.map((g) => g.color)).filter((c) => c !== '#94a3b8')];
  assert.equal(new Set(cores).size, cores.length, 'cor repetida entre cadastros');
});

test('unidades da ADAPAR: arquivo público, 22 regionais com rótulo estadual, tooltip com circunscrição (UTF-8)', () => {
  const gj = JSON.parse(readFileSync(new URL('../../public/data/adapar-unidades-pr.geojson', import.meta.url), 'utf8'));
  const regionais = gj.features.filter((f) => f.properties.Tipo === 'Regional');
  assert.equal(regionais.length, 22);
  assert.ok(gj.features.length >= 140, `${gj.features.length} unidades`);
  for (const f of gj.features) {
    const [lon, lat] = f.geometry.coordinates;
    assert.ok(lon > -55 && lon < -48 && lat > -27 && lat < -22, `${f.properties.Nome} fora do PR`);
    assert.ok(f.properties['Endereço'] && f.properties.ibge, `${f.properties.Nome} sem endereço/ibge`);
  }
  const reg = unidadeAdaparEstilo(regionais[0].properties);
  assert.equal(reg.grupo, 'regional');
  assert.ok(reg.labelMaxDist >= 1_000_000 && reg.size > unidadeAdaparEstilo({ Tipo: 'Local' }).size);
  assert.deepEqual(UNIDADES_LEGENDA.map((g) => g.grupo), ['regional', 'local']);
  const irati = gj.features.find((f) => f.properties.Tipo === 'Local' && f.properties.Nome === 'Imbituva');
  const html = unidadeAdaparTooltip(irati.properties);
  assert.match(html, /Escritório Local de Imbituva/);
  assert.match(html, /Circunscrição/);
  assert.match(html, /Guamiranga, Imbituva e Ivaí/);
  assert.match(unidadeAdaparTooltip(regionais[0].properties), /Unidade Regional de Sanidade Agropecuária/);
});

test('agrotóxicos: o papel mais restrito do registro define o grupo', () => {
  assert.equal(agrotoxicoGrupo({ Categorias: 'Comerciante · Exportador · Fabricante' }), 'industria');
  assert.equal(agrotoxicoGrupo({ Categorias: 'Comerciante · Importador' }), 'comex');
  assert.equal(agrotoxicoGrupo({ Categorias: 'Comerciante' }), 'comerciante');
  assert.equal(agrotoxicoGrupo({ 'Serviços': 'Expurgo' }), 'outro');
});

test('estabelecimento sem coordenada: esmaecido, selo e motivo no tooltip (UTF-8)', () => {
  const ok = {
    'Razão social': 'AGROPECUÁRIA SÃO JOÃO LTDA', CNPJ: '11.222.333/0001-81', Estabelecimento: 'Matriz', 'Município': 'Pinhão',
    Categoria: 'Biológico Farmacêutico', 'Produtos biológicos': 'Vacina Brucelose B19 · Vacina Raiva dos Herbívoros',
    'Unidade local': 'Pinhão', 'Regional ADAPAR': 'Guarapuava', 'Checagem da coordenada': 'no município declarado',
  };
  const aprox = { ...ok, 'Checagem da coordenada': 'sem coordenada no cadastro: ponto aproximado, no centro do município' };
  assert.equal(veterinarioEstilo(ok).alpha, 0.95);
  assert.equal(veterinarioEstilo(aprox).alpha, 0.4);
  assert.equal(veterinarioEstilo({ ...ok, Categoria: undefined }).grupo, 'outro');
  const html = veterinarioTooltip(ok);
  assert.match(html, /AGROPECUÁRIA SÃO JOÃO LTDA/);
  assert.match(html, /Comércio de produtos veterinários · Pinhão/);
  assert.match(html, /11\.222\.333\/0001-81 · Matriz/);
  assert.match(html, /Pinhão · regional Guarapuava/);
  assert.doesNotMatch(html, /Local aproximado|undefined/);
  assert.match(veterinarioTooltip(aprox), /Local aproximado/);
  assert.match(veterinarioTooltip(aprox), /sem coordenada no cadastro/);
});

test('UC: lista de pragas cortada em 8 e definição da unidade no tooltip', () => {
  const pragas = Array.from({ length: 12 }, (_, i) => `Praga ${i + 1}`).join(' · ');
  assert.equal(listaCurta('a · b'), 'a · b');
  assert.equal(listaCurta(undefined), '');
  assert.match(listaCurta(pragas), /Praga 8 e mais 4$/);
  const html = consolidacaoTooltip({ 'Razão social': 'FRUTAS LTDA', 'Município': 'Maringá', Pragas: pragas });
  assert.match(html, /Praga 8 e mais 4/);
  assert.doesNotMatch(html, /Praga 9/);
  assert.match(html, /beneficiamento, processamento, embalagem ou armazenamento/);
});

const DADOS = {
  referencia: '2026-10-02',
  grupos: ['DAP/CAF ativa', 'DAP/CAF inativa', 'Sem DAP/CAF informada'],
  municipios: [['4119301', 'Pinhão']],
  sem_coordenada: 1,
  p: [
    [-51.6, -25.7, 0, 0, 0, 12.1, 'SÍTIO SÃO JOSÉ', 2, 'JOÃO DA SILVA; MARIA CONCEIÇÃO'],
    [-51.7, -25.8, 0, 2, 1, null, 'CHÁCARA', 0, ''],
  ],
};

test('propriedades: features por linha, contagem por grupo e tooltip', () => {
  const { features, counts } = exploracoesFeatures(DADOS);
  assert.deepEqual(counts, [1, 0, 1]);
  assert.deepEqual(features[1], {
    type: 'Feature', id: 1, geometry: { type: 'Point', coordinates: [-51.7, -25.8] }, properties: { g: 2, fora: 1 },
  });
  assert.deepEqual(exploracoesFeatures(null), { features: [], counts: [] });
  assert.equal(EXPLORACOES_CORES.length, DADOS.grupos.length);

  const html = exploracaoTooltip(DADOS.p[0], DADOS);
  assert.match(html, /SÍTIO SÃO JOSÉ/);
  assert.match(html, /Pinhão · exploração pecuária ativa/);
  assert.match(html, /Produtores \(2\)<\/dt><dd[^>]*>JOÃO DA SILVA; MARIA CONCEIÇÃO/);
  assert.match(html, /12,1 ha/);
  assert.match(html, /DAP\/CAF ativa/);
  assert.match(html, /out\/26/);
  assert.doesNotMatch(html, /fora do município/);
  const vazio = exploracaoTooltip(DADOS.p[1], DADOS);
  assert.match(vazio, /sem produtor vinculado/);
  assert.match(vazio, /fora do município declarado/);
  assert.doesNotMatch(vazio, /Área|undefined|NaN/);
  assert.equal(exploracaoTooltip(undefined, DADOS), '');
});

test('gunzipJson devolve o JSON de um corpo gzipado, com acentos', async () => {
  const resp = new Response(gzipSync(Buffer.from(JSON.stringify(DADOS), 'utf8')));
  assert.deepEqual(await gunzipJson(resp), DADOS);
});

for (const [arq, estilo, legenda, minimo] of PONTOS) {
  test(`dado real ${arq}: grupos da legenda, rótulos, CNPJ e UTF-8`, { skip: !existsSync(PRIV(arq)) }, () => {
    const texto = readFileSync(PRIV(arq), 'utf8');
    const feats = JSON.parse(texto).features;
    assert.ok(feats.length >= minimo, `${feats.length} < ${minimo}`);
    const grupos = new Set(legenda.map((g) => g.grupo));
    for (const f of feats) {
      const s = estilo(f.properties);
      assert.ok(grupos.has(s.grupo), `grupo ${s.grupo} fora da legenda`);
      assert.equal(s.labelMaxDist, ADAPAR_LABEL_DIST, 'labelDists da camada cobre o teto do estilo');
      assert.ok(s.label, 'todo ponto tem rótulo');
      const [lon, lat] = f.geometry.coordinates;
      assert.ok(lon > -55 && lon < -48 && lat > -27 && lat < -22, `${lon},${lat} fora do PR`);
      assert.ok(f.properties['Município'] && f.properties.ibge && f.properties['Checagem da coordenada']);
      // CNPJ pontuado ou CPF mascarado: nunca o CPF inteiro.
      assert.match(f.properties.CNPJ, /^(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\*{3}\.\d{3}\.\d{3}-\*{2})$/);
      for (const [k, v] of Object.entries(f.properties)) {
        if (!['CNPJ', 'Telefone', 'E-mail'].includes(k)) assert.doesNotMatch(String(v), /\d{8,}|\d{3}\.\d{3}\.\d{3}-\d{2}/, `documento em ${k}`);
      }
    }
    assert.doesNotMatch(texto, /Ã[£§©¡³]|�/, 'mojibake');
    assert.doesNotMatch(texto, /"Situação":"Inativo"/);
  });
}

test('dado real: propriedades no PR, grupos válidos e sem CPF no arquivo', { skip: !existsSync(PRIV(EXPLORACOES)) }, () => {
  const texto = gunzipSync(readFileSync(PRIV(EXPLORACOES))).toString('utf8');
  const d = JSON.parse(texto);
  assert.ok(d.p.length >= 200_000, `só ${d.p.length} propriedades`);
  assert.equal(d.campos.length, d.p[0].length);
  assert.equal(d.grupos.length, EXPLORACOES_CORES.length);
  for (const [lon, lat, mun, g, fora, ha, , n] of d.p) {
    assert.ok(lon > -55 && lon < -48 && lat > -27 && lat < -22, `${lon},${lat} fora do PR`);
    assert.ok(d.municipios[mun] && g >= 0 && g < d.grupos.length && (fora === 0 || fora === 1) && n >= 0);
    assert.ok(ha === null || (ha > 0 && ha <= 100_000));
  }
  const fora = d.p.filter((p) => p[4]).length;
  assert.ok(fora / d.p.length < 0.02, `${fora} fora do município: o formato GGMMSSs da coordenada mudou?`);
  for (const [, , , , , , propriedade, , produtores] of d.p) {
    assert.doesNotMatch(`${propriedade} ${produtores}`, /\d{8,}|\d{3}\.?\d{3}\.?\d{3}-?\d{2}/, 'documento no nome');
  }
  assert.doesNotMatch(texto, /Ã[£§©¡³]|�/, 'mojibake');
  assert.match(texto, /[ÃÇÉ]/, 'acentos preservados');
});
