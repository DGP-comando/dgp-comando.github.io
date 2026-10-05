// src/maplibre/layers/outorgas.js
//
// Outorgas de uso da água do IAT, ao vivo do ArcGIS Server do GeoPR (nada
// armazenado aqui). O IAT emite pelo SIGARH desde 2023; o legado CRH ainda
// tem captações, lançamentos de efluentes e aproveitamentos hidrelétricos
// vigentes, então as quatro bases entram juntas (SISTEMAS). Chave nos chips:
// tipo de interferência ou atividade (finalidade) da outorga; mecânica das
// imagens, pontos e contagens em ./iatPontos.js.
// Nome do requerente/razão social fica de fora (pessoa física, LGPD).

import { fmtDate, fmtInt, fmtNum, tipCard } from '../kit.js';
import { classifica, contagemSistema, iatPontosLayer, linhasDoModo, query } from './iatPontos.js';

export { consertaUtf8, exportTileUrl, filtroMunicipios } from './iatPontos.js';

export const OUTORGA_LEGENDA = Object.freeze([
  { key: 'sup', label: 'Captação superficial', curto: 'Capt. superficial', color: '#22d3ee', like: ['Capta%o superficial'] },
  { key: 'sub', label: 'Captação subterrânea', curto: 'Capt. subterrânea', color: '#a78bfa', like: ['Capta%o subterr%'] },
  { key: 'efl', label: 'Lançamento de efluentes', curto: 'Efluentes', color: '#f97316', like: ['Lan%amento de efluentes'] },
  { key: 'hid', label: 'Aproveitamento hidrelétrico', curto: 'Hidrelétricas', color: '#facc15', like: ['Aproveitamento hidrel%'] },
  { key: 'obr', label: 'Obras e intervenções', curto: 'Obras/interv.', color: '#94a3b8' },
]);

// Atividade pela finalidade declarada, em ordem de prioridade: uma outorga
// "Criação animal, Sanitário" é de criação animal; "Processo fabril,
// Sanitário", de indústria. O resto (vias, travessias, drenagem) é obra.
export const ATIVIDADE_LEGENDA = Object.freeze([
  { key: 'energia', label: 'Geração de energia', curto: 'Energia', color: '#facc15',
    like: ['%potencial hidr%', '%termoel%'] },
  { key: 'abast', label: 'Abastecimento público e saneamento', curto: 'Abast./saneam.', color: '#60a5fa',
    like: ['%Abastecimento p%blico%', '%Abastecimento coletivo%', '%sgot%', '%efluente sanit%', '%carro pipa%',
      '%tratamento e distribui%'] },
  { key: 'indus', label: 'Indústria e mineração', curto: 'Indústria/miner.', color: '#e11d48',
    like: ['%fabril%', '%ndustri%', '%Minera%', '%miner%', '%Resfriamento%', '%vapor%', '%Envase%', '%areia%',
      '%xteis%', '%Controle de emiss%'] },
  { key: 'aqui', label: 'Aquicultura', curto: 'Aquicultura', color: '#2dd4bf',
    like: ['%Aq%icultura%', '%aquicultura%', '%Piscicultura%'] },
  // "Irrigação de jardins" fica com consumo humano e lazer.
  { key: 'irrig', label: 'Irrigação e lavoura', curto: 'Irrigação/lavoura', color: '#4ade80',
    like: ['Irriga%o', 'Irriga%o,%', '%,Irriga%o', '%,Irriga%o,%', '%ulveriza%', '%vegeta%', '%agricultura%'] },
  { key: 'criacao', label: 'Criação animal', curto: 'Criação animal', color: '#f97316',
    like: ['%animal%', '%Dessedenta%', '%agropecu%', '%vicultura%'] },
  { key: 'dom', label: 'Consumo humano, limpeza e lazer', curto: 'Consumo/lazer', color: '#c084fc',
    like: ['%Sanit%', '%Limpeza%', '%Consumo humano%', '%Lavagem%', '%Lazer%', '%Paisagismo%', '%jardins%',
      '%Combate a inc%', '%dom%stico%', '%Uso geral%'] },
  { key: 'outro', label: 'Obras, intervenções e outros', curto: 'Obras/outros', color: '#94a3b8' },
]);

export const MODOS = Object.freeze([
  { id: 'tipo', chip: 'Tipo', prop: 'grupo', legenda: OUTORGA_LEGENDA },
  { id: 'atividade', chip: 'Atividade', prop: 'atividade', legenda: ATIVIDADE_LEGENDA },
]);
const [TIPO, ATIVIDADE] = MODOS;

// Vigentes: deferidas (ou em renovação/regularização) e só documentos que
// autorizam uso (portarias de outorga, declarações de uso/interferência
// independente, revigoramento); ficam fora anuência de perfuração,
// cancelamentos, revogações. Escrito curto: o where se repete em cada classe
// da URL do tile, e o GeoPR devolve 414 acima de ~8 kB.
const SIGARH_WHERE = "(st_portaria='DEFERIDA' OR st_portaria LIKE 'EM R%') AND (nm_tipo_documento LIKE 'Portaria de outorga%'"
  + " OR nm_tipo_documento LIKE '%independente%' OR nm_tipo_documento LIKE '%revigoramento')";
const CRH_WHERE = "(condicao='VIGENTE' OR condicao LIKE 'EM RENOVA%')";

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// Classes de tipo pelos padrões da legenda (testes e ficha usam as mesmas).
export const grupoSigarh = (tipo) => classifica(SISTEMAS[0], TIPO, { nm_tipo_interferencia: tipo });

// CRH: só captação; poço é subterrânea, rio e mina (nascente) superficial.
export const grupoCrh = (manancial) => classifica(SISTEMAS[1], TIPO, { tipo_manancial: manancial });

const positivo = (v) => (Number(v) > 0 ? Number(v) : null);

export function sigarhProps(a) {
  const vazoes = MESES.map((m) => Number(a[`vlr_vazao_capt_lanc_${m}`])).filter((v) => v > 0);
  const corpo = [a.nm_tipo_corpo_hidrico, a.nm_corpo_hidrico_popular].filter(Boolean).join(' ');
  return {
    sistema: 'SIGARH',
    tipo: a.nm_tipo_interferencia,
    finalidade: String(a.desc_finalidades ?? '').split(',').filter(Boolean).join(', '),
    usuario: a.nm_tipo_usuario,
    corpo: corpo || a.nm_aquifero,
    documento: a.nm_tipo_documento,
    portaria: a.nr_portaria,
    situacao: a.st_portaria,
    vencimento: a.dt_vencimento,
    municipio: a.nm_municipio_emp,
    bacia: a.nm_bacia_hidrografica,
    vazao: vazoes.length ? Math.max(...vazoes) : null,
  };
}

// Campos comuns às três bases do CRH.
const crhBase = (a) => ({
  sistema: 'CRH',
  usuario: a.uso,
  documento: a.modalidade,
  portaria: a.portaria,
  situacao: a.condicao,
  vencimento: a.vencimento,
  municipio: a.municipio,
  bacia: a.bac_nome,
});

export function crhProps(a) {
  const grupo = grupoCrh(a.tipo_manancial);
  return {
    ...crhBase(a),
    tipo: `Captação ${grupo === 'sub' ? 'subterrânea' : 'superficial'} (${String(a.tipo_manancial ?? '').toLowerCase()})`,
    finalidade: a.finalidades || a.finalidade_principal,
    corpo: a.rio_nome || a.aqu_descricao,
    vazao: positivo(a.vazao_outorgada__m3_h_),
  };
}

export function crhEfluenteProps(a) {
  return {
    ...crhBase(a),
    tipo: 'Lançamento de efluentes',
    finalidade: [a.tpo_nome, a.atv_nome].filter(Boolean).join(' · '),
    corpo: a.rio_nome,
    vazao: positivo(a.eflo_out_vazao__m3_h_),
  };
}

export function crhHidreletricoProps(a) {
  return {
    ...crhBase(a),
    tipo: 'Aproveitamento hidrelétrico',
    empreendimento: a.localidade,
    corpo: a.rio_nome,
    potencia: positivo(a.potencial_instalado__mww_),
  };
}

export const SISTEMAS = Object.freeze([
  {
    key: 'sigarh',
    servico: 'outorgas_sigarh',
    where: SIGARH_WHERE,
    props: sigarhProps,
    mun: { campo: 'cod_municipio_emp', texto: true },
    modos: {
      tipo: { campo: 'nm_tipo_interferencia', padrao: 'obr' },
      atividade: { campo: 'desc_finalidades', padrao: 'outro' },
    },
    fields: ['nm_tipo_interferencia', 'desc_finalidades', 'nm_tipo_usuario', 'nm_corpo_hidrico_popular',
      'nm_tipo_corpo_hidrico', 'nm_aquifero', 'nm_tipo_documento', 'nr_portaria', 'st_portaria', 'dt_vencimento',
      'nm_municipio_emp', 'nm_bacia_hidrografica', ...MESES.map((m) => `vlr_vazao_capt_lanc_${m}`)],
  },
  {
    key: 'crh-captacao',
    servico: 'out_captacao_crh',
    where: CRH_WHERE,
    props: crhProps,
    mun: { campo: 'mun_ibge' },
    modos: {
      tipo: { campo: 'tipo_manancial', padrao: 'sup', like: { sub: ['PO%'] } },
      atividade: { campo: 'finalidade_principal', padrao: 'outro' },
    },
    fields: ['uso', 'finalidades', 'finalidade_principal', 'tipo_manancial', 'rio_nome', 'aqu_descricao',
      'vazao_outorgada__m3_h_', 'portaria', 'modalidade', 'condicao', 'vencimento', 'municipio', 'bac_nome'],
  },
  {
    key: 'crh-efluentes',
    servico: 'out_efluentes_crh',
    where: CRH_WHERE,
    props: crhEfluenteProps,
    mun: { campo: 'mun_codigo' },
    modos: {
      tipo: { fixo: 'efl' },
      // ponytail: atv_nome é o ramo do empreendimento (CNAE); o que não casa
      // é quase todo fabricação/abate/laticínio, então o resto vira indústria.
      atividade: { campo: 'atv_nome', padrao: 'indus' },
    },
    fields: ['uso', 'tpo_nome', 'atv_nome', 'rio_nome', 'eflo_out_vazao__m3_h_', 'portaria', 'modalidade', 'condicao',
      'vencimento', 'municipio', 'bac_nome'],
  },
  {
    key: 'crh-hidreletrico',
    servico: 'out_aproveitamento_hidreletrico',
    where: CRH_WHERE,
    props: crhHidreletricoProps,
    mun: { campo: 'mun_ibge' },
    modos: { tipo: { fixo: 'hid' }, atividade: { fixo: 'energia' } },
    fields: ['uso', 'localidade', 'rio_nome', 'potencial_instalado__mww_', 'portaria', 'modalidade', 'condicao',
      'vencimento', 'municipio', 'bac_nome'],
  },
]);

export function outorgaTooltipHtml(p, now = Date.now()) {
  const venc = Number(p.vencimento);
  const vencida = Number.isFinite(venc) && venc > 0 && venc < now;
  return tipCard({
    icon: '💧',
    title: p.tipo || 'Outorga de uso da água',
    subtitle: `IAT · ${p.sistema}${p.municipio ? ` · ${p.municipio}` : ''}`,
    badge: vencida ? { text: 'VENCIDA', tone: 'warn' } : { text: String(p.situacao ?? ''), tone: 'ok' },
    rows: [
      ['Empreendimento', p.empreendimento],
      ['Atividade', ATIVIDADE_LEGENDA.find((g) => g.key === p.atividade)?.label],
      ['Finalidade', p.finalidade],
      ['Usuário', p.usuario],
      ['Corpo hídrico', p.corpo],
      ['Bacia', p.bacia],
      ['Vazão', p.vazao ? `${fmtNum(p.vazao, p.vazao < 10 ? 2 : 0)} m³/h${p.sistema === 'SIGARH' ? ' (máx. mensal)' : ''}` : ''],
      ['Potência', p.potencia ? fmtNum(p.potencia, 2, 'MW') : ''],
      ['Documento', p.documento],
      ['Portaria', p.portaria],
      ['Validade', venc > 0 ? fmtDate(venc) : ''],
    ],
    source: 'IAT · GeoPR (SIGARH + CRH), consulta ao vivo',
  });
}

/**
 * Outorgas vigentes nos municípios (ficha municipal e regional), ao vivo, por
 * tipo e por atividade. Devolve {total, linhas, atividades, sigarh, crh}
 * (linhas: [{grupo, label, curto, color, n}]) ou null se o GeoPR não responder
 * (a ficha só omite a seção).
 */
export async function getOutorgasMunicipios(ibges) {
  try {
    const partes = await Promise.all(SISTEMAS.map((s) => contagemSistema(s, MODOS, ibges)));
    const sigarh = partes[0].total;
    const crh = partes.slice(1).reduce((a, p) => a + p.total, 0);
    return { total: sigarh + crh, linhas: linhasDoModo(TIPO, partes), atividades: linhasDoModo(ATIVIDADE, partes), sigarh, crh };
  } catch (err) {
    console.warn('[DataGeo:ficha] outorgas IAT indisponíveis:', err?.message);
    return null;
  }
}

export const outorgasLayer = iatPontosLayer({
  id: 'datageo-outorgas',
  sigla: 'outorgas',
  name: 'Outorgas de uso da água (IAT)',
  category: 'Recursos hídricos',
  icon: '💧',
  source: 'IAT · SIGARH + CRH',
  attribution: 'IAT/GeoPR',
  sistemas: SISTEMAS,
  modos: MODOS,
  async load() {
    const n = await Promise.all(SISTEMAS.map((s) => query(s.servico, s.where, [], { returnCountOnly: 'true' })
      .then((j) => j.count ?? 0)));
    const crh = n.slice(1).reduce((a, b) => a + b, 0);
    return { count: n[0] + crh, info: `SIGARH ${fmtInt(n[0])} · CRH ${fmtInt(crh)}` };
  },
  tooltip: (p) => outorgaTooltipHtml(p),
});

export default [outorgasLayer];
