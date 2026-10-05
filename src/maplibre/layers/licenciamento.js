// src/maplibre/layers/licenciamento.js
//
// Licenciamento ambiental do IAT (SIA + SGA), ao vivo do GeoPR: licenças e
// autorizações com validade em dia. Chave nos chips: modalidade (prévia,
// instalação, operação...) ou grupo de atividade do empreendimento. Mecânica
// em ./iatPontos.js. Usa o serviço sem CPF/CNPJ e deixa de fora a razão
// social (pode ser pessoa física, LGPD).

import { fmtDate, fmtInt, tipCard } from '../kit.js';
import { contagemSistema, iatPontosLayer, linhasDoModo, query } from './iatPontos.js';

// Ordem = prioridade do desenho (operação por cima quando os pontos coincidem).
export const MODALIDADE_LEGENDA = Object.freeze([
  { key: 'oper', label: 'Licença de operação', curto: 'Operação', color: '#4ade80', like: ['LO%', 'RLO%'] },
  { key: 'inst', label: 'Licença de instalação', curto: 'Instalação', color: '#f97316', like: ['LI%', 'RLI%'] },
  { key: 'previa', label: 'Licença prévia', curto: 'Prévia', color: '#facc15', like: ['LP%', 'CP'] },
  { key: 'simp', label: 'Licença simplificada ou por adesão', curto: 'Simplificada', color: '#22d3ee', like: ['LAS%', 'RLAS%', 'LAC', 'RLAC'] },
  { key: 'aut', label: 'Autorização ambiental', curto: 'Autorização', color: '#c084fc', like: ['AA', 'AF'] },
  { key: 'disp', label: 'Dispensa ou inexigibilidade', curto: 'Dispensa', color: '#94a3b8' },
]);

export const ATIVIDADE_LICENCA_LEGENDA = Object.freeze([
  { key: 'agro', label: 'Agropecuária', curto: 'Agropecuária', color: '#4ade80',
    like: ['Agropecu%', 'Agrot%', 'Aq%icultura', 'Beneficiamento de produtos agr%', 'Beneficiamento de mandioca',
      'Desmembramento%'] },
  { key: 'minera', label: 'Mineração', curto: 'Mineração', color: '#a8a29e', like: ['Extra%o e tratamento de minerais', 'Beneficiamento de minerais%'] },
  { key: 'indus', label: 'Indústria', curto: 'Indústria', color: '#e11d48', like: ['Industrial', 'Ind%stria%', 'A%car e %lcool'] },
  { key: 'resid', label: 'Resíduos e saneamento', curto: 'Resíduos/saneam.', color: '#a78bfa', like: ['%res%duos%', 'Saneamento%'] },
  { key: 'energia', label: 'Energia', curto: 'Energia', color: '#facc15', like: ['Linhas de transmiss%', 'Gera%o e Transmiss%', 'Usinas%'] },
  { key: 'comercio', label: 'Comércio, serviços e turismo', curto: 'Comércio/serviços', color: '#60a5fa',
    like: ['Com%rcio e Servi%', 'Empreedimentos comerciais%', 'Turismo%', 'Empreendimentos N%uticos', 'Transporte, terminais%'] },
  { key: 'imob', label: 'Imobiliário e obras viárias', curto: 'Imobiliário/vias', color: '#f472b6', like: ['Imobili%rio', 'Empreendimentos imobili%', 'Obras vi%rias'] },
  { key: 'flor', label: 'Florestal e fauna', curto: 'Florestal/fauna', color: '#2dd4bf', like: ['Corte Isolado', 'Substitui%', '%Fauna%', 'Explora%o florestal'] },
  { key: 'outro', label: 'Atividade não informada', curto: 'Não informada', color: '#64748b' },
]);

export const MODOS_LICENCA = Object.freeze([
  { id: 'modalidade', chip: 'Modalidade', prop: 'classe', legenda: MODALIDADE_LEGENDA },
  { id: 'atividade', chip: 'Atividade', prop: 'atividade', legenda: ATIVIDADE_LICENCA_LEGENDA },
]);

export function licencaProps(a) {
  return {
    modalidade: a.desc_modalidade,
    sigla: a.sigla_modalidade,
    grupoAtividade: a.desc_grupo_atividade,
    atividadeDesc: a.desc_atividade,
    protocolo: a.num_protocolo,
    municipio: a.nome_municipio,
    emissao: a.dt_emissao,
    validade: a.dt_validade,
  };
}

export const LICENCAS = Object.freeze({
  key: 'sia-sga',
  servico: 'licencas_ambientais_sia_sga',
  where: 'dt_validade >= CURRENT_DATE',
  props: licencaProps,
  mun: { campo: 'cod_ibge' },
  modos: {
    modalidade: { campo: 'sigla_modalidade', padrao: 'disp' },
    atividade: { campo: 'desc_grupo_atividade', padrao: 'outro' },
  },
  fields: ['sigla_modalidade', 'desc_modalidade', 'desc_grupo_atividade', 'desc_atividade', 'num_protocolo',
    'nome_municipio', 'dt_emissao', 'dt_validade'],
});

export function licencaTooltipHtml(p) {
  const cls = MODALIDADE_LEGENDA.find((g) => g.key === p.classe);
  return tipCard({
    icon: '📋',
    title: p.atividadeDesc || p.grupoAtividade || 'Licenciamento ambiental',
    subtitle: `IAT · licenciamento${p.municipio ? ` · ${p.municipio}` : ''}`,
    badge: p.sigla ? { text: p.sigla, tone: 'ok' } : null,
    rows: [
      ['Modalidade', p.modalidade || cls?.label],
      ['Grupo de atividade', p.grupoAtividade],
      ['Protocolo', p.protocolo],
      ['Emissão', p.emissao > 0 ? fmtDate(p.emissao) : ''],
      ['Validade', p.validade > 0 ? fmtDate(p.validade) : ''],
    ],
    source: 'IAT · GeoPR (SIA + SGA), consulta ao vivo',
  });
}

/**
 * Licenças com validade em dia nos municípios (ficha municipal e regional), por
 * modalidade e por atividade: {total, linhas, atividades} ou null se o GeoPR
 * não responder (a ficha só omite a seção).
 */
export async function getLicencasMunicipios(ibges) {
  try {
    const c = await contagemSistema(LICENCAS, MODOS_LICENCA, ibges);
    return { total: c.total, linhas: linhasDoModo(MODOS_LICENCA[0], [c]), atividades: linhasDoModo(MODOS_LICENCA[1], [c]) };
  } catch (err) {
    console.warn('[DataGeo:ficha] licenciamento IAT indisponível:', err?.message);
    return null;
  }
}

export const licenciamentoLayer = iatPontosLayer({
  id: 'datageo-licenciamento',
  sigla: 'licenciamento',
  name: 'Licenciamento ambiental (IAT)',
  category: 'Ambiente',
  icon: '📋',
  source: 'IAT · SIA + SGA',
  attribution: 'IAT/GeoPR',
  sistemas: [LICENCAS],
  modos: MODOS_LICENCA,
  async load() {
    const j = await query(LICENCAS.servico, LICENCAS.where, [], { returnCountOnly: 'true' });
    return { count: j.count ?? 0, info: `${fmtInt(j.count ?? 0)} licenças com validade em dia` };
  },
  tooltip: (p) => licencaTooltipHtml(p),
});

export default [licenciamentoLayer];
