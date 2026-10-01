import test from 'node:test';
import assert from 'node:assert/strict';
import { SISTEMAS, consertaUtf8, crhEfluenteProps, crhHidreletricoProps, crhProps, exportTileUrl, grupoCrh, grupoSigarh, outorgaTooltipHtml, sigarhProps } from './outorgas.js';

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
  assert.equal(s.grupo, 'sub');
  assert.equal(s.vazao, 55);
  assert.equal(s.corpo, 'Aquífero Serra Geral');
  assert.equal(s.finalidade, 'Processo fabril, Sanitário');
  const c = crhProps({ tipo_manancial: 'RIO', rio_nome: 'Arroio Guaçu', vazao_outorgada__m3_h_: 400, razaosocial: 'FULANO' });
  assert.equal(c.grupo, 'sup');
  assert.equal(c.vazao, 400);
  assert.ok(!JSON.stringify([s, c]).includes('FULANO'));
});

test('tooltip marca outorga vencida', () => {
  const html = outorgaTooltipHtml({ sistema: 'CRH', tipo: 'Captação superficial (rio)', situacao: 'VIGENTE', vencimento: 1000, vazao: 75 }, 2000);
  assert.match(html, /VENCIDA/);
  assert.match(html, /75 m³\/h/);
});

test('tile do export preserva o token de bbox do MapLibre', () => {
  const url = exportTileUrl('svc', "a='b'", { type: 'simple' });
  assert.match(url, /bbox=\{bbox-epsg-3857\}&/);
  assert.equal(JSON.parse(new URL(url.replace('{bbox-epsg-3857}', '0')).searchParams.get('dynamicLayers'))[0].definitionExpression, "a='b'");
});

test('efluentes e hidrelétricas do CRH', () => {
  const e = crhEfluenteProps({ tpo_nome: 'Processo Produtivo', atv_nome: 'Produção de álcool', rio_nome: 'Rio Jacaré',
    eflo_out_vazao__m3_h_: 116, condicao: 'VIGENTE', razao_social: 'FULANO' });
  assert.equal(e.grupo, 'efl');
  assert.equal(e.vazao, 116);
  assert.equal(e.finalidade, 'Processo Produtivo · Produção de álcool');
  const h = crhHidreletricoProps({ localidade: 'CGH do Velho', rio_nome: 'Rio Congonhas', potencial_instalado__mww_: 0.97, razaosocial: 'FULANO' });
  assert.equal(h.grupo, 'hid');
  assert.match(outorgaTooltipHtml(h, 0), /0,97 MW/);
  assert.ok(!JSON.stringify([e, h]).includes('FULANO'));
  assert.deepEqual(SISTEMAS.map((x) => x.servico),
    ['outorgas_sigarh', 'out_captacao_crh', 'out_efluentes_crh', 'out_aproveitamento_hidreletrico']);
});
