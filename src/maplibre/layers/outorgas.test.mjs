import test from 'node:test';
import assert from 'node:assert/strict';
import { MODOS, SISTEMAS, consertaUtf8, crhEfluenteProps, filtroMunicipios, crhHidreletricoProps, crhProps, exportTileUrl, grupoCrh, grupoSigarh, outorgaTooltipHtml, sigarhProps } from './outorgas.js';
import { camadasExport, classifica, likeRegex } from './iatPontos.js';

test('UTF-8 quebrado do SIGARH volta a acentuar', () => {
  assert.equal(consertaUtf8('Aqu�­fero Serra Geral'), 'Aquífero Serra Geral');
  assert.equal(consertaUtf8('Capta�§�£o'), 'Captação');
  assert.equal(consertaUtf8('Iguaçu'), 'Iguaçu');
});

test('grupos por tipo de interferência e manancial', () => {
  assert.equal(grupoSigarh('Captação subterrânea (Poço cacimba)'), 'sub');
  assert.equal(grupoSigarh('Captação superficial'), 'sup');
  assert.equal(grupoSigarh('Lançamento de efluentes'), 'efl');
  assert.equal(grupoSigarh('Aproveitamento hidrelétrico sem barragem/soleira'), 'hid');
  assert.equal(grupoSigarh('Travessia'), 'obr');
  assert.equal(grupoCrh('POÇO'), 'sub');
  assert.equal(grupoCrh('MINA'), 'sup');
});

test('normaliza SIGARH (vazão máxima mensal) e CRH sem nome do requerente', () => {
  const s = sigarhProps({ nm_tipo_interferencia: 'Captação subterrânea (Poço tubular)', desc_finalidades: 'Processo fabril,Sanitário',
    nm_aquifero: 'Aquífero Serra Geral', vlr_vazao_capt_lanc_jan: 40, vlr_vazao_capt_lanc_jul: 55, nm_requerente: 'FULANO' });
  assert.equal(s.vazao, 55);
  assert.equal(s.corpo, 'Aquífero Serra Geral');
  assert.equal(s.finalidade, 'Processo fabril, Sanitário');
  const c = crhProps({ tipo_manancial: 'RIO', rio_nome: 'Arroio Guaçu', vazao_outorgada__m3_h_: 400, razaosocial: 'FULANO' });
  assert.equal(c.tipo, 'Captação superficial (rio)');
  assert.equal(c.vazao, 400);
  assert.ok(!JSON.stringify([s, c]).includes('FULANO'));
});

test('tooltip marca outorga vencida', () => {
  const html = outorgaTooltipHtml({ sistema: 'CRH', tipo: 'Captação superficial (rio)', situacao: 'VIGENTE', vencimento: 1000, vazao: 75 }, 2000);
  assert.match(html, /VENCIDA/);
  assert.match(html, /75 m³\/h/);
});

test('tile do export preserva o token de bbox do MapLibre', () => {
  const url = exportTileUrl('svc', [{ where: "a='b'", color: '#22d3ee' }]);
  assert.match(url, /bbox=\{bbox-epsg-3857\}&/);
  const [dl] = JSON.parse(new URL(url.replace('{bbox-epsg-3857}', '0')).searchParams.get('dynamicLayers'));
  assert.equal(dl.definitionExpression, "a='b'");
  assert.deepEqual(dl.drawingInfo.renderer.symbol.color, [34, 211, 238, 235]);
});

test('efluentes e hidrelétricas do CRH', () => {
  const e = crhEfluenteProps({ tpo_nome: 'Processo Produtivo', atv_nome: 'Produção de álcool', rio_nome: 'Rio Jacaré',
    eflo_out_vazao__m3_h_: 116, condicao: 'VIGENTE', razao_social: 'FULANO' });
  assert.equal(e.vazao, 116);
  assert.equal(e.finalidade, 'Processo Produtivo · Produção de álcool');
  const h = crhHidreletricoProps({ localidade: 'CGH do Velho', rio_nome: 'Rio Congonhas', potencial_instalado__mww_: 0.97, razaosocial: 'FULANO' });
  assert.match(outorgaTooltipHtml(h, 0), /0,97 MW/);
  assert.ok(!JSON.stringify([e, h]).includes('FULANO'));
  assert.deepEqual(SISTEMAS.map((x) => x.servico),
    ['outorgas_sigarh', 'out_captacao_crh', 'out_efluentes_crh', 'out_aproveitamento_hidreletrico']);
});

test('filtro de municípios aceita só IBGE de 7 dígitos', () => {
  assert.equal(filtroMunicipios({ campo: 'mun_ibge' }, ['4117909', 4106407, '4117909']), 'mun_ibge IN (4117909,4106407)');
  assert.equal(filtroMunicipios({ campo: 'cod', texto: true }, ['4117909', "1') OR 1=1--"]), "cod IN ('4117909')");
  assert.equal(filtroMunicipios({ campo: 'mun_ibge' }, ['x']), null);
});

const [TIPO, ATIVIDADE] = MODOS;
const ativSigarh = (t) => classifica(SISTEMAS[0], ATIVIDADE, { desc_finalidades: t });

test('LIKE vira RegExp ancorado', () => {
  assert.ok(likeRegex('Capta%o sub_err%').test('Captação subterrânea'));
  assert.ok(!likeRegex('Irriga%o').test('Irrigação de jardins'));
  assert.ok(likeRegex('a.b%').test('a.bc'));
  assert.ok(!likeRegex('a.b%').test('axbc'));
});

test('atividade da outorga pela finalidade, em ordem de prioridade', () => {
  assert.equal(ativSigarh('Criação animal,Sanitário (consumo humano + limpeza)'), 'criacao');
  assert.equal(ativSigarh('Processo fabril,Sanitário (consumo humano + limpeza)'), 'indus');
  assert.equal(ativSigarh('Irrigação'), 'irrig');
  assert.equal(ativSigarh('Sanitário (consumo humano + limpeza),Irrigação'), 'irrig');
  assert.equal(ativSigarh('Sanitário (consumo humano + limpeza),Irrigação de jardins'), 'dom');
  assert.equal(ativSigarh('Abastecimento de pulverizadores'), 'irrig');
  assert.equal(ativSigarh('Abastecimento coletivo tipo I (abastecimento comunitário)'), 'abast');
  assert.equal(ativSigarh('Aproveitamento de potencial hidráulico'), 'energia');
  assert.equal(ativSigarh('Aquicultura comercial'), 'aqui');
  assert.equal(ativSigarh('Diluição de efluente sanitário'), 'abast');
  assert.equal(ativSigarh('Lavagem de ve�­culos'), 'dom'); // UTF-8 quebrado do GeoPR
  assert.equal(ativSigarh('Sistema viário'), 'outro');
  assert.equal(classifica(SISTEMAS[1], ATIVIDADE, { finalidade_principal: 'Aqüicultura' }), 'aqui');
  assert.equal(classifica(SISTEMAS[1], ATIVIDADE, { finalidade_principal: 'Dessedentação de animais' }), 'criacao');
  assert.equal(classifica(SISTEMAS[2], ATIVIDADE, { atv_nome: 'Captação, tratamento e distribuição de água' }), 'abast');
  assert.equal(classifica(SISTEMAS[2], ATIVIDADE, { atv_nome: 'Laticínios' }), 'indus');
  assert.equal(classifica(SISTEMAS[3], ATIVIDADE, {}), 'energia');
  assert.equal(classifica(SISTEMAS[3], TIPO, {}), 'hid');
});

test('imagens: uma camada por classe, maior prioridade por cima, resto embaixo', () => {
  const cs = camadasExport(SISTEMAS[0], ATIVIDADE);
  assert.equal(cs.length, ATIVIDADE.legenda.length);
  assert.equal(cs[0].color, ATIVIDADE.legenda[0].color);
  assert.match(cs[0].where, /AND \(desc_finalidades LIKE '%potencial hidr%'/);
  assert.equal(cs.at(-1).where, SISTEMAS[0].where);
  const crh = camadasExport(SISTEMAS[1], TIPO);
  assert.deepEqual(crh.map((c) => c.color), ['#a78bfa', '#22d3ee']);
  assert.match(crh[0].where, /tipo_manancial LIKE 'PO%'/);
  assert.equal(camadasExport(SISTEMAS[3], ATIVIDADE).length, 1);
});

test('URL do tile acima do teto vira fatias, prioridade maior na primeira', async () => {
  const { fatiasExport } = await import('./iatPontos.js');
  const urls = fatiasExport(SISTEMAS[0].servico, camadasExport(SISTEMAS[0], ATIVIDADE));
  assert.ok(urls.length >= 2);
  assert.ok(urls.every((u) => u.length <= 4000));
  const ids = urls.map((u) => JSON.parse(new URL(u.replace('{bbox-epsg-3857}', '0')).searchParams.get('dynamicLayers')).length);
  assert.equal(ids.reduce((a, b) => a + b, 0), ATIVIDADE.legenda.length);
  assert.match(decodeURIComponent(urls[0]), /potencial\+hidr/);
  assert.equal(fatiasExport(SISTEMAS[3].servico, camadasExport(SISTEMAS[3], TIPO)).length, 1);
});
