import test from 'node:test';
import assert from 'node:assert/strict';
import { periodo, recorteCaf, variacao } from './cafFamilias.js';
import { carHtml, familiaHtml, secaoCaf, seta } from '../datageoCaf.js';
import { anelQueContem, areaAnelHa } from '../maplibre/layers/territoriosFeatures.js';

const DADOS = {
  municipios: { 4100103: { caf: { '2025-10': 3 } }, 4100202: { caf: { '2025-10': 4 } } },
  regionais: { Curitiba: { municipios: ['4100103', '4100202'], caf: { '2025-10': 7 } } },
};

test('recorte: município, regional pelo mesmo conjunto e nada fora disso', () => {
  assert.equal(recorteCaf(DADOS, ['4100103']).caf['2025-10'], 3);
  assert.equal(recorteCaf(DADOS, [4100202, 4100103]).caf['2025-10'], 7);
  assert.equal(recorteCaf(DADOS, ['4100103', '4100301']), null);
  assert.equal(recorteCaf(null, ['4100103']), null);
});

test('período, variação e seta', () => {
  assert.equal(periodo('2025-10-08'), 'out/25');
  assert.equal(periodo('2023-11'), 'nov/23');
  assert.equal(Math.round(variacao(100, 96.7) * 10) / 10, -3.3);
  assert.equal(variacao(0, 5), null);
  assert.match(seta(3.3), /▲ 3,3%/);
  assert.match(seta(-4.1), /▼ 4,1%/);
  assert.equal(seta(null), '');
});

test('imóvel do CAR: o menor anel que contém o ponto', () => {
  const quadrado = (x0, y0, d) => [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d], [x0, y0]];
  const grande = quadrado(-51, -25, 0.1);
  const pequeno = quadrado(-50.97, -24.97, 0.01);
  const feats = [
    { properties: { classe: '4-10' }, geometry: { coordinates: [grande] } },
    { properties: { classe: '0-4' }, geometry: { coordinates: [pequeno, quadrado(-49, -24, 0.01)] } },
  ];
  const r = anelQueContem(feats, -50.965, -24.965);
  assert.equal(r.classe, '0-4');
  assert.equal(r.ring, pequeno);
  assert.equal(anelQueContem(feats, -50.95, -24.95).classe, '4-10');
  assert.equal(anelQueContem(feats, -48, -24), null);
  // 0,01° x 0,01° perto de 25° S: ~1,11 km x ~1,01 km = ~112 ha
  assert.ok(Math.abs(areaAnelHa(pequeno) - 112) < 2);
});

const META = { referencia: '2025-10-08', anterior: '2024-07-23', ipca: 1.0561, venceDias: 182, grupos: ['Soja'] };

test('seção da ficha: contagem, série, variação real e amostra pequena', () => {
  const html = secaoCaf({
    meta: META,
    caf: { '2023-11': 5, '2024-07': 19, '2025-01': 35, '2025-10': 47 },
    dap: { '2023-11': 52, '2024-08': 32, '2025-01': 4, '2025-10': 0 },
    familias: { '2023-11': 57, '2025-10': 47 },
    vencer: 1,
    renda: { rt: 69700, rt24: 139833, rha: 15313, rha24: 22577, ha: 5.9 },
    painel: { n: 18, rt: 142224, rt24: 136613, rha: 23969, rha24: 17498 },
    fora_pct: 19.7, top: [{ p: 'Mandioca', v: 667478, n: 9 }], n_prod: 1,
    pronaf: { A: 1, B: 20, V: 26 }, publico: { quilombolas: 1 }, atividade: { pescadores: 6 },
    mulheres: 9, jovens: 12, membros: 90, idade: 53, escol_baixa: 10, nao_prop: 31, aposent: 12, bolsa: 3, idr: 47,
  });
  assert.match(html, /Famílias com CAF ativa: <b>47<\/b>/);
  assert.match(html, /nov\/23 <b>57<\/b> → out\/25 <b>47<\/b>/);
  assert.match(html, /▼ 17,5%/);
  assert.match(html, /variação pouco confiável/);
  assert.doesNotMatch(html, /mesmas famílias/); // painel com 18 famílias não mostra variação
  assert.match(html, /1 quilombolas · 6 pescadores/);
  assert.equal(secaoCaf(null), null);
});

test('cadastro da família: escapa texto, formata CPF e diz o que conferir', () => {
  const html = familiaHtml({
    situacao: 'ATIVA', pronaf: ['B', 'V'], criacao: '2023-03-15', atualizacao: '2023-03-17', validade: '2026-03-15',
    emissor: 'IDR', cadastrador: 'TÉCNICO', terreno: '', caracterizacao: 'Quilombo', mo_familiar: 2, mo_contratada: 0,
    endereco: { logradouro: 'Colônia <b>X</b>', numero: '0', municipio: 'Paranaguá', cep: '83200000' },
    membros: [{ nome: 'JOÃO', cpf: '01992884960', parentesco: 'Declarante', nascimento: '1973-08-02', idade: 52, telefone: '41991973512' }],
    areas: [{ area: 16.8, unidade: 'ha', tipo: 'Terra', dominio: 'Proprietário', principal: true, lat: -25.6, lon: -48.6 }],
    producao: [{ dentro: true, tipo: 'Lavouras', produto: 'Feijão', auferida: 100, estimada: 120 }],
    renda: { dentro: 100, fora: 0, total: 100, ha: 16.8, por_ha: 5.95 },
    renda_2024: null, local: { status: 'corrigida', conserto: 'escala/sinal', lat: -25.6, lon: -48.6 },
    alertas: ['CAF vence em 158 dias'],
  }, { car: { ligado: false } });
  assert.match(html, /019\.928\.849-60/);
  assert.match(html, /\(41\) 99197-3512/);
  assert.match(html, /Colônia &lt;b&gt;X&lt;\/b&gt;/);
  assert.match(html, /CAF vence em 158 dias/);
  assert.match(html, /estimada R\$ 120/);
  assert.match(html, /corrigida \(escala\/sinal\)/);
  assert.match(html, /Ligue a camada CAR/);
});

test('vínculo com o CAR: destacado, ausente ou camada desligada', () => {
  assert.match(carHtml({ ligado: true, imovel: { ha: 20, classe: '0-4' } }, 16.8), /~<b>20,0 ha<\/b> · 0-4 módulos/);
  assert.match(carHtml({ ligado: true, imovel: null }), /Nenhum imóvel do CAR/);
  assert.match(carHtml({ ligado: false }), /Ligue a camada CAR/);
});
