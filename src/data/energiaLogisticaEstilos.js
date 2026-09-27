// src/data/energiaLogisticaEstilos.js
//
// Estilo e tooltip dos pontos de Infraestrutura (subestações, usinas) e de
// Logística agro (armazéns, agroindústrias, cadastro IDR, rotas turísticas,
// CEASAs), SEM dependência de engine de mapa: usado pelas camadas Cesium
// (datageoEnergia.js / datageoLogistica.js, que convertem a cor) e pelo
// protótipo MapLibre (src/maplibre/layers/energiaLogistica.js).
//
// Cada `*Estilo(props)` devolve {grupo, size, color, alpha, label,
// labelMaxDist} com a cor em CSS (#rrggbb) + alpha separado, ou null para o
// ponto ser ignorado. `size` é o diâmetro em px; `labelMaxDist` a distância
// (m) da câmera acima da qual o rótulo some.

import { fmtInt, fmtNum, tipCard } from '../maplibre/tooltipCard.js';

// ---------------------------------------------------------------- energia

/** Cores das linhas de transmissão e subestações por classe (CSS + alpha). */
export const ENERGIA_CORES = Object.freeze({
  kv525: Object.freeze({ css: '#c084fc', alpha: 0.9 }),
  kv230: Object.freeze({ css: '#38bdf8', alpha: 0.75 }),
  baixa: Object.freeze({ css: '#94a3b8', alpha: 0.55 }),
  planejada: Object.freeze({ css: '#fbbf24', alpha: 0.9 }),
});

/** Classe da linha de transmissão: planejada, >= 500 kV, >= 230 kV ou menor. */
export function linhaTransmissaoClasse(props = {}) {
  if (props.planejada) return 'planejada';
  const kv = Number(props.tensao) || 0;
  if (kv >= 500) return 'kv525';
  if (kv >= 230) return 'kv230';
  return 'baixa';
}

export function subestacaoEstilo(p) {
  return {
    grupo: p.planejada ? 'planejada' : 'existente',
    size: p.planejada ? 9 : 7,
    color: p.planejada ? ENERGIA_CORES.planejada.css : '#38bdf8',
    alpha: p.planejada ? ENERGIA_CORES.planejada.alpha : 1,
    label: p.planejada
      ? `${p.nome} (prevista ${p.ano ?? '?'}) · ${p.tensao ?? ''} kV`
      : `${p.nome} · ${p.tensao ?? ''} kV`,
    labelMaxDist: p.planejada ? 900_000 : 250_000,
  };
}

export const SUBESTACAO_LEGENDA = Object.freeze([
  { grupo: 'existente', label: 'Existente', color: '#38bdf8' },
  { grupo: 'planejada', label: 'Prevista', color: '#fbbf24' },
]);

// Usinas SIGEL/ANEEL por tipo + aerogeradores individuais (torres) num
// mesmo layer: cor por fonte, tamanho por potencia; aerogeradores so
// aparecem de perto (sao detalhe dos parques eolicos, ja presentes como
// usina 'eol').
export const USINA_STYLE = Object.freeze({
  uhe: { cor: '#3b82f6', rotulo: 'UHE', base: 8 },
  pch: { cor: '#7dd3fc', rotulo: 'PCH', base: 5 },
  cgh: { cor: '#2dd4bf', rotulo: 'CGH', base: 4 },
  ute: { cor: '#fb923c', rotulo: 'UTE', base: 5.5 },
  eol: { cor: '#f8fafc', rotulo: 'EOL', base: 7 },
  ufv: { cor: '#fde047', rotulo: 'UFV', base: 6 },
});

export const fmtMw = (kw) => (kw ? `${(kw / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MW` : '');

export function usinaEstilo(p) {
  if (p.tipo === 'aerogerador') {
    return {
      grupo: 'aerogerador',
      size: 3.5,
      color: '#ffffff',
      alpha: 0.85,
      label: `Aerogerador ${p.nome}${p.alt ? ` · ${p.alt} m` : ''}`,
      labelMaxDist: 60_000,
    };
  }
  const s = USINA_STYLE[p.tipo];
  if (!s) return null;
  const mw = (Number(p.pot_kw) || 0) / 1000;
  return {
    grupo: p.tipo,
    size: mw >= 500 ? s.base + 5 : mw >= 50 ? s.base + 2 : s.base,
    color: s.cor,
    alpha: 0.9,
    label: `${s.rotulo} ${p.nome}${p.pot_kw ? ` · ${fmtMw(p.pot_kw)}` : ''}`,
    labelMaxDist: mw >= 500 ? 1_500_000 : mw >= 50 ? 400_000 : 130_000,
  };
}

export const USINA_LEGENDA = Object.freeze([
  ...Object.entries(USINA_STYLE).map(([grupo, s]) => ({ grupo, label: s.rotulo, color: s.cor })),
  { grupo: 'aerogerador', label: 'Aerogerador', color: '#ffffff' },
]);

// ------------------------------------------------------------- logística

export const fmtCap = (t) => {
  if (!t) return '';
  if (t >= 1000) return ` · ${Math.round(t / 1000)} mil t`;
  return ` · ${t} t`;
};

export function armazemEstilo(p) {
  if (p.kind === 'porto') {
    return { grupo: 'porto', size: 12, color: '#f97316', alpha: 1, label: p.nome, labelMaxDist: 2_000_000 };
  }
  const cap = Number(p.cap_t) || 0;
  return {
    grupo: 'armazem',
    // Capacidade dita o tamanho: silos grandes saltam na visão regional.
    size: cap >= 50_000 ? 7 : cap >= 10_000 ? 5 : 3.5,
    color: '#fbbf24',
    alpha: 0.85,
    label: `${p.nome}${fmtCap(cap)}`,
    labelMaxDist: 45_000,
  };
}

export const ARMAZEM_LEGENDA = Object.freeze([
  { grupo: 'armazem', label: 'Armazém', color: '#fbbf24' },
  { grupo: 'porto', label: 'Porto', color: '#f97316' },
]);

export const AGRO_STYLE = Object.freeze({
  frigorifico: { color: '#ef4444', size: 8, rotulo: 'Frigorífico', fonte: 'SIGSIF/MAPA' },
  laticinio: { color: '#bfdbfe', size: 5.5, rotulo: 'Laticínio', fonte: 'SIGSIF/MAPA' },
  serraria: { color: '#b45309', size: 5.5, rotulo: 'Serraria', fonte: 'OpenStreetMap' },
});

export function agroindustriaEstilo(p) {
  const s = AGRO_STYLE[p.kind];
  if (!s) return null;
  return { grupo: p.kind, size: s.size, color: s.color, alpha: 0.9, label: `${s.rotulo}: ${p.nome}`, labelMaxDist: 120_000 };
}

export const AGRO_LEGENDA = Object.freeze(
  Object.entries(AGRO_STYLE).map(([grupo, s]) => ({ grupo, label: s.rotulo, color: s.color })),
);

const AGRO_INSPECAO = Object.freeze({
  frigorifico: 'SIF · Serviço de Inspeção Federal (MAPA)',
  laticinio: 'SIF · Serviço de Inspeção Federal (MAPA)',
});

export function agroindustriaTooltipHtml(p) {
  const s = AGRO_STYLE[p.kind];
  if (!s) return '';
  return tipCard({
    icon: '🏭',
    title: p.nome,
    subtitle: [s.rotulo, p.municipio ? `${p.municipio} - PR` : ''].filter(Boolean).join(' · '),
    badge: { text: s.rotulo, tone: p.kind === 'frigorifico' ? 'alert' : 'info' },
    rows: [
      ['Atividade', s.rotulo],
      ['Município', p.municipio],
      ['Inspeção', AGRO_INSPECAO[p.kind]],
    ],
    source: `${s.fonte} · DataGeo PR`,
  });
}

// ------------------------------------------------ agroindústrias (IDR)
//
// Cadastro IDR: cada propriedade do GeoJSON já é um rótulo legível
// (scripts/build_agroindustrias_idr.py). O tooltip agrupa as ~60 respostas do
// diagnóstico em seções e junta as que se leem melhor numa linha só (mão de
// obra, canais de venda, necessidades); o que não estiver mapeado aqui cai em
// "Outros", para nenhum campo novo do cadastro sumir.

const IDR_MAX = 140; // caracteres por valor de texto livre
const corta = (v, max = IDR_MAX) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const juntar = (partes, sep = ' · ') => partes.filter((x) => x && String(x).trim()).join(sep);
const pct = (v) => {
  const t = String(v ?? '').trim();
  return t && /^\d+([.,]\d+)?$/.test(t) ? `${t.replace('.', ',')}%` : t;
};
const simNao = (v) => {
  const t = String(v ?? '').trim().toLowerCase();
  if (t.startsWith('sim')) return 'ok';
  if (t.startsWith('não') || t.startsWith('nao')) return 'warn';
  return null;
};
const ehZero = (v) => /^(0|zero|não|nao|-)?$/i.test(String(v ?? '').trim());

// Campos consumidos pelas linhas abaixo (o resto vai para "Outros").
const IDR_USADOS = new Set([
  'id', 'Agroindústria', 'Município', 'Regional', 'Endereço', 'Produtor responsável', 'Técnico do cadastro',
  'Tipo de empreendimento', 'Possui CNPJ', 'CNPJ', 'Situação legal', 'Ano de implantação', 'Área construída',
  'Local de processamento', 'Fonte da água', 'Resíduos sólidos', 'Resíduos líquidos', 'Matéria-prima',
  'Sistema de produção', 'Produção própria de MP', 'Mão de obra', 'Pessoas da família', 'Contratados permanentes',
  'Temporários (2022)', 'Controle de qualidade', 'Como controla a qualidade', 'Registro origem animal',
  'Registro MAPA (bebidas)', 'Regularização ambiental', 'Código de barras', 'Multifuncional', 'Produção mensal',
  'Comporta aumento', 'Investimento na instalação', 'Fonte dos recursos', 'Controle de receitas/custos',
  'Custo unitário', 'Participação na renda', 'Emite nota fiscal', 'Precisa de crédito', 'Investimento em 3 anos',
  'ATER na instalação', 'Demanda de ATER', 'Venda direta', 'Mercado institucional', 'Varejo local',
  'E-commerce/redes', 'Outros mercados', 'Quer ampliar mercado', 'Pode vender fora', 'Maior distância de entrega',
  'Produtos premiados', 'Prêmios', 'Observações', 'Checagem da coordenada', 'Fonte do ponto',
]);

/** "Alta: regularização, rotulagem · Média: gestão" a partir de "Necessidade: <área>". */
function necessidades(p) {
  const porNivel = new Map();
  for (const [k, v] of Object.entries(p)) {
    if (!k.startsWith('Necessidade: ')) continue;
    const nivel = String(v ?? '').trim();
    if (!nivel) continue;
    if (!porNivel.has(nivel)) porNivel.set(nivel, []);
    porNivel.get(nivel).push(k.slice('Necessidade: '.length));
  }
  const ordem = (n) => {
    const t = n.toLowerCase();
    if (t.startsWith('alt') || t.startsWith('muit')) return 0;
    if (t.startsWith('méd') || t.startsWith('med')) return 1;
    if (t.startsWith('baix') || t.startsWith('pouc')) return 2;
    return 3;
  };
  return [...porNivel.entries()]
    .sort((a, b) => ordem(a[0]) - ordem(b[0]))
    .map(([nivel, areas]) => [nivel, areas.join(', '), ordem(nivel) === 0 ? 'warn' : null]);
}

export function agroindustriaIdrTooltipHtml(p) {
  const legal = String(p['Situação legal'] ?? '').trim();
  const legalTom = simNao(legal);
  const cnpj = !ehZero(p.CNPJ) ? p.CNPJ : p['Possui CNPJ'];
  const maoDeObra = juntar([
    Number(p['Pessoas da família']) > 0 ? `${p['Pessoas da família']} da família` : '',
    Number(p['Contratados permanentes']) > 0 ? `${p['Contratados permanentes']} contratado(s)` : '',
    Number(p['Temporários (2022)']) > 0 ? `${p['Temporários (2022)']} temporário(s) em 2022` : '',
  ]) || p['Mão de obra'];
  const canais = juntar([
    p['Venda direta'] ? `direta ${pct(p['Venda direta'])}` : '',
    p['Mercado institucional'] ? `institucional ${pct(p['Mercado institucional'])}` : '',
    p['Varejo local'] ? `varejo local ${pct(p['Varejo local'])}` : '',
  ]);
  const checagem = p['Checagem da coordenada'];
  const outros = Object.entries(p)
    .filter(([k, v]) => !IDR_USADOS.has(k) && !k.startsWith('Necessidade: ') && !k.startsWith('GETEC · ') && typeof v !== 'object')
    .map(([k, v]) => [k, corta(v)]);
  return tipCard({
    icon: '🧺',
    title: p['Agroindústria'] ?? p['GETEC · Nome'] ?? 'Agroindústria',
    subtitle: juntar([p['Município'] ? `${p['Município']} - PR` : '', p.Regional ? `Regional ${p.Regional}` : '']),
    badge: legal ? { text: legalTom === 'ok' ? 'Legalizada' : legalTom === 'warn' ? 'Não legalizada' : corta(legal, 24), tone: legalTom ?? 'info' } : null,
    wide: true,
    rows: [
      ['Tipo', p['Tipo de empreendimento'] ?? p['GETEC · Tipo']],
      ['Matéria-prima', p['Matéria-prima']],
      ['Produtor', p['Produtor responsável'] ?? p['GETEC · Responsável']],
      ['Endereço', corta(p['Endereço'] ?? p['GETEC · Endereço'])],
      ['CNPJ', cnpj],
      ['Implantação', juntar([p['Ano de implantação'], p['Área construída'] ? `${p['Área construída']} construídos` : ''])],
      ['Situação legal', corta(legal), legalTom],
      ['Regul. ambiental', corta(p['Regularização ambiental']), simNao(p['Regularização ambiental'])],
    ],
    sections: [
      {
        title: 'Produção',
        rows: [
          ['Processamento', corta(p['Local de processamento'])],
          ['Sistema', corta(p['Sistema de produção'])],
          ['MP própria', pct(p['Produção própria de MP'])],
          ['Produção mensal', corta(p['Produção mensal'])],
          ['Multifuncional', p.Multifuncional],
          ['Comporta aumento', p['Comporta aumento']],
          ['Mão de obra', corta(maoDeObra)],
          ['Qualidade', corta(juntar([p['Controle de qualidade'], p['Como controla a qualidade']], ': '))],
          ['Registros', corta(juntar([p['Registro origem animal'], p['Registro MAPA (bebidas)'] ? `MAPA (bebidas): ${p['Registro MAPA (bebidas)']}` : '']))],
          ['Água', corta(p['Fonte da água'])],
          ['Resíduos', corta(juntar([
            p['Resíduos sólidos'] ? `sólidos: ${p['Resíduos sólidos']}` : '',
            p['Resíduos líquidos'] ? `líquidos: ${p['Resíduos líquidos']}` : '',
          ], '; '))],
        ],
      },
      {
        title: 'Comercialização',
        rows: [
          ['Canais', canais],
          ['E-commerce/redes', corta(p['E-commerce/redes'])],
          ['Outros mercados', corta(p['Outros mercados'])],
          ['Nota fiscal', corta(p['Emite nota fiscal'])],
          ['Código de barras', p['Código de barras']],
          ['Entrega até', corta(p['Maior distância de entrega'])],
          ['Ampliar mercado', juntar([p['Quer ampliar mercado'], p['Pode vender fora'] ? `condição atual: ${p['Pode vender fora']}` : ''])],
          ['Prêmios', ehZero(p['Prêmios']) ? (ehZero(p['Produtos premiados']) ? '' : p['Produtos premiados']) : corta(p['Prêmios'])],
        ],
      },
      {
        title: 'Gestão e crédito',
        rows: [
          ['Investimento', corta(juntar([p['Investimento na instalação'], p['Fonte dos recursos']]))],
          ['Controle financeiro', juntar([
            p['Controle de receitas/custos'] ? `receitas/custos: ${p['Controle de receitas/custos']}` : '',
            p['Custo unitário'] ? `custo unitário: ${p['Custo unitário']}` : '',
          ])],
          ['Peso na renda', corta(p['Participação na renda'])],
          ['Precisa de crédito', corta(p['Precisa de crédito'])],
          ['Planos (3 anos)', corta(p['Investimento em 3 anos'])],
          ['ATER', juntar([
            p['ATER na instalação'] ? `na instalação: ${p['ATER na instalação']}` : '',
            p['Demanda de ATER'] ? `demanda: ${corta(p['Demanda de ATER'], 80)}` : '',
          ])],
        ],
      },
      { title: 'Necessidades (avaliação do técnico)', rows: necessidades(p) },
      {
        title: 'Cadastro GETEC',
        rows: [
          ['Nome', p['GETEC · Nome'] !== p['Agroindústria'] ? p['GETEC · Nome'] : ''],
          ['Tipo', p['Tipo de empreendimento'] ? p['GETEC · Tipo'] : ''],
          ['Integrantes', corta(p['GETEC · Integrantes'])],
          ['Responsável', p['Produtor responsável'] ? p['GETEC · Responsável'] : ''],
          ['Endereço', p['Endereço'] ? corta(p['GETEC · Endereço']) : ''],
          ['Situação', p['GETEC · Situação'], simNao(p['GETEC · Situação']) ?? (/ativ/i.test(p['GETEC · Situação'] ?? '') ? 'ok' : null)],
        ],
      },
      {
        title: 'Cadastro',
        rows: [
          ['Técnico', p['Técnico do cadastro']],
          ['Ponto', p['Fonte do ponto']],
          ['Coordenada', checagem, /^FORA/i.test(checagem ?? '') ? 'warn' : null],
          ...outros,
        ],
      },
    ],
    note: p['Observações'] && !ehZero(p['Observações']) ? corta(p['Observações'], 260) : '',
    source: 'IDR-Paraná · diagnóstico 2023 + GETEC',
  });
}

export const IDR_GRUPOS = Object.freeze([
  { grupo: 'vegetal', label: 'Origem vegetal', color: '#4ade80' },
  { grupo: 'animal', label: 'Origem animal', color: '#f472b6' },
  { grupo: 'mista', label: 'Vegetal e animal', color: '#c084fc' },
]);
const IDR_COR = Object.fromEntries(IDR_GRUPOS.map((g) => [g.grupo, g.color]));

// Matéria-prima do diagnóstico ou, no ponto só do GETEC, o tipo (Vegetal/Animal/Mista).
export const idrGrupo = (mp = '') => {
  const animal = mp.includes('Animal') || mp.includes('Mista');
  const vegetal = mp.includes('Vegetal') || mp.includes('Mista');
  if (animal && vegetal) return 'mista';
  return animal ? 'animal' : 'vegetal';
};

export function agroindustriaIdrEstilo(p) {
  const grupo = idrGrupo(p['Matéria-prima'] ?? p['GETEC · Tipo']);
  return { grupo, size: 6, color: IDR_COR[grupo], alpha: 0.9, label: p['Agroindústria'], labelMaxDist: 40_000 };
}

export const ROTA_STYLE = Object.freeze({
  'Rota do Queijo Paranaense': { color: '#facc15', icon: '🧀' },
  'Rota da Uva e do Vinho': { color: '#a855f7', icon: '🍇' },
});

const linhasDe = (txt) => String(txt ?? '').split(/\n/).map((l) => l.trim());

/**
 * Descrição livre das rotas turísticas -> campos: produtos, registro,
 * experiências, município, telefone, e-mail e site/Instagram. Os dois
 * formulários (Rota do Queijo e Rota da Uva e do Vinho) escrevem de jeitos
 * diferentes; o que não casar fica de fora e o texto vai como nota.
 */
export function parseRotaDescricao(desc) {
  const txt = String(desc ?? '');
  const linhas = linhasDe(txt);
  const depois = (re) => {
    const k = linhas.findIndex((l) => re.test(l));
    if (k < 0) return '';
    const resto = linhas[k].replace(re, '').trim();
    if (resto) return resto;
    const out = [];
    for (let j = k + 1; j < linhas.length && linhas[j]; j++) out.push(linhas[j]);
    return out.join(' ');
  };
  const experiencias = (() => {
    const k = linhas.findIndex((l) => /^(experiências turísticas|qual a experiência)/i.test(l));
    if (k < 0) return '';
    const inline = linhas[k].replace(/^[^:?]*[:?]/, '').trim();
    if (inline) return inline;
    const out = [];
    for (let j = k + 1; j < linhas.length; j++) {
      const l = linhas[j];
      if (!l) { if (out.length) break; continue; }
      if (/^contato/i.test(l)) break;
      out.push(l.replace(/^[-•]\s*/, '').replace(/[;.]$/, ''));
    }
    return out.join('; ');
  })();
  const produtosLinha = /^(queijos?|tipos de queijos produzidos)\s*:/i;
  let produtos = depois(/^produtos comercializados\s*:/i);
  if (!produtos) {
    const l = linhas.find((x) => produtosLinha.test(x)) ?? '';
    produtos = l.replace(produtosLinha, '').replace(/\s+Registro:.*$/i, '').trim();
  }
  const registro = (/Registro:\s*([^\n]+)/i.exec(txt)?.[1] ?? '').trim();
  const telefone = (/(?:\(?\b\d{2}\)?[\s.-]*)?9?\s?\d{4,5}[\s.-]?\d{4}\b/.exec(txt)?.[0] ?? '').trim();
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(txt)?.[0] ?? '';
  const site = (/Site:\s*(\S+)/i.exec(txt)?.[1]) ?? '';
  const insta = (/(?:^|\s)(@[\w.]+)/m.exec(txt.replace(email, ''))?.[1]) ?? '';
  return {
    municipio: depois(/^município\s*:/i),
    produtos: produtos.replace(/[,.\s]+$/, ''),
    registro,
    experiencias: experiencias.replace(/[,.\s]+$/, ''),
    telefone,
    email,
    site: juntar([insta, site]),
  };
}

export function rotaTuristicaTooltipHtml(p) {
  const s = ROTA_STYLE[p.rota] ?? { icon: '📍' };
  const d = parseRotaDescricao(p.descricao);
  // "Queijaria Cornelia - Arapoti - PR": o município vem no nome (Rota do Queijo).
  const partes = String(p.nome ?? '').split(/\s+-\s+/).filter((x) => x && x !== 'PR');
  const nome = partes[0] ?? p.nome;
  const municipio = d.municipio || (partes.length > 1 ? partes[partes.length - 1] : '');
  const algum = d.produtos || d.experiencias || d.telefone;
  return tipCard({
    icon: s.icon,
    title: nome,
    subtitle: juntar([p.rota, municipio]),
    wide: true,
    rows: [
      ['Município', municipio],
      ['Produtos', corta(d.produtos, 220)],
      ['Registro', d.registro],
      ['Experiências', corta(d.experiencias, 260)],
      ['Telefone', d.telefone],
      ['E-mail', d.email],
      ['Redes/site', d.site],
    ],
    note: algum ? '' : corta(p.descricao, 300),
    source: `${p.rota ?? 'Rotas turísticas'} · DataGeo PR`,
  });
}

export function rotaTuristicaEstilo(p) {
  return { grupo: p.rota, size: 9, color: ROTA_STYLE[p.rota]?.color ?? '#e2e8f0', alpha: 1, label: p.nome, labelMaxDist: 150_000 };
}

export const ROTA_LEGENDA = Object.freeze(
  Object.entries(ROTA_STYLE).map(([grupo, s]) => ({ grupo, label: grupo, color: s.color })),
);

export function ceasaEstilo(p) {
  // So 5 unidades: label sempre visivel na visao estadual.
  return { grupo: 'ceasa', size: 11, color: '#22c55e', alpha: 1, label: p.nome, labelMaxDist: 2_500_000 };
}

export const CEASA_LEGENDA = Object.freeze([{ grupo: 'ceasa', label: 'CEASA', color: '#22c55e' }]);

// ------------------------------------------------------------ distribuição

/** Cor (CSS + alpha) e largura por tensão nominal (kV) da rede de média tensão. */
export const DISTRIBUICAO_KV = Object.freeze({
  34.5: Object.freeze({ css: '#fb7185', alpha: 0.8, width: 1.6 }),
  13.8: Object.freeze({ css: '#34d399', alpha: 0.7, width: 1.1 }),
});

// ------------------------------------------------- tooltips dos pontos
//
// Formato único tipCard (src/maplibre/tooltipCard.js), com os campos que cada
// arquivo traz (scripts/build_energia.py, build_logistica.py).

const anoValido = (a) => {
  const n = Number(a);
  return Number.isFinite(n) && n > 1900 ? String(n) : '';
};
const kvTxt = (t) => {
  const s = String(t ?? '').trim();
  return s && s !== '-' ? `${s.replace(/\./g, ',')} kV` : '';
};

export function subestacaoTooltipHtml(p) {
  const ano = anoValido(p.ano);
  const niveis = String(p.tensao ?? '').split('/').map((x) => Number(String(x).replace(',', '.'))).filter(Number.isFinite);
  const max = niveis.length ? Math.max(...niveis) : NaN;
  return tipCard({
    icon: '🔌',
    title: p.nome,
    subtitle: `Subestação${Number.isFinite(max) ? ` · ${fmtNum(max, max % 1 ? 1 : 0)} kV` : ''}`,
    badge: p.planejada ? { text: 'Prevista', tone: 'warn' } : { text: 'Em operação', tone: 'ok' },
    rows: [
      ['Tensões', kvTxt(p.tensao)],
      ['Situação', p.planejada ? `Prevista${ano ? ` para ${ano}` : ''} (plano da EPE)` : 'Em operação', p.planejada ? 'warn' : null],
      [p.planejada ? 'Entrada prevista' : 'Em operação desde', ano],
    ],
    source: 'EPE · DataGeo PR',
  });
}

const USINA_NOME = Object.freeze({
  uhe: 'Usina hidrelétrica',
  pch: 'Pequena central hidrelétrica',
  cgh: 'Central geradora hidrelétrica',
  ute: 'Usina termelétrica',
  eol: 'Usina eólica',
  ufv: 'Usina fotovoltaica',
});

const USINA_FONTE = Object.freeze({
  uhe: 'Hídrica', pch: 'Hídrica', cgh: 'Hídrica', ute: 'Térmica', eol: 'Eólica', ufv: 'Solar',
});

export function usinaTooltipHtml(p) {
  if (p.tipo === 'aerogerador') {
    return tipCard({
      icon: '🌬️',
      title: `Aerogerador ${p.nome}`,
      subtitle: 'Turbina de parque eólico',
      rows: [
        ['Parque', p.nome],
        ['Potência', Number(p.pot_kw) > 0 ? fmtInt(p.pot_kw, 'kW') : ''],
        ['Altura', Number(p.alt) > 0 ? fmtNum(p.alt, 1, 'm') : ''],
      ],
      source: 'SIGEL/ANEEL · DataGeo PR',
    });
  }
  const s = USINA_STYLE[p.tipo];
  if (!s) return '';
  const mw = (Number(p.pot_kw) || 0) / 1000;
  return tipCard({
    icon: '💡',
    title: p.nome,
    subtitle: `${USINA_NOME[p.tipo]} (${s.rotulo})`,
    badge: { text: s.rotulo, tone: mw >= 500 ? 'alert' : mw >= 50 ? 'warn' : 'info' },
    rows: [
      ['Fonte', USINA_FONTE[p.tipo]],
      ['Potência outorgada', mw ? fmtNum(mw, mw >= 100 ? 0 : mw >= 1 ? 1 : 2, 'MW') : ''],
    ],
    source: 'SIGEL/ANEEL · DataGeo PR',
  });
}

// O CSV da CONAB veio com Latin-1 lido como UTF-8 em alguns tipos.
const ARMAZEM_TIPO = Object.freeze({
  'Chapï¿½u Chines': 'Chapéu chinês',
  'Depï¿½sito': 'Depósito',
  'porto graneleiro': 'Porto graneleiro',
});
export const armazemTipo = (t) => ARMAZEM_TIPO[t] ?? String(t ?? '').replace(/ï¿½/g, '�');

export function armazemTooltipHtml(p) {
  const porto = p.kind === 'porto';
  const cap = Number(p.cap_t) || 0;
  const tipo = armazemTipo(p.tipo);
  return tipCard({
    icon: porto ? '⚓' : '🌾',
    title: p.nome,
    subtitle: juntar([tipo || (porto ? 'Porto' : 'Armazém'), p.municipio]),
    badge: porto ? { text: 'Porto', tone: 'warn' } : cap >= 50_000 ? { text: 'Grande', tone: 'info' } : null,
    rows: [
      ['Tipo', tipo],
      ['Capacidade estática', cap ? fmtInt(cap, 't') : ''],
      ['Município', p.municipio],
    ],
    source: porto ? 'DataGeo PR' : 'CONAB · Cadastro Nacional de Armazéns (CDA 2023)',
  });
}

export function ceasaTooltipHtml(p) {
  const cidade = String(p.nome ?? '').replace(/^CEASA\s+/i, '');
  return tipCard({
    icon: '🥬',
    title: p.nome,
    subtitle: 'Central de abastecimento (hortifrutigranjeiros)',
    rows: [
      ['Município', cidade !== p.nome ? cidade : ''],
      ['Operador', 'CEASA/PR · Centrais de Abastecimento do Paraná'],
    ],
    source: 'CEASA/PR · DataGeo PR',
  });
}

/** Tooltip de um trecho da rede de distribuição (célula fatiada: só a tensão). */
export function distribuicaoTooltipHtml({ kv, municipio = null, trechos = null, fonte = '' } = {}) {
  const n = Number(kv);
  const kvS = Number.isFinite(n) ? `${fmtNum(n, n % 1 ? 1 : 0)} kV` : '';
  return tipCard({
    icon: '🔗',
    title: `Rede de distribuição${kvS ? ` ${kvS}` : ''}`,
    subtitle: 'Média tensão · Copel Distribuição',
    badge: kvS ? { text: kvS, tone: n >= 30 ? 'warn' : 'info' } : null,
    rows: [
      ['Tensão nominal', kvS],
      ['Tipo', 'Rede primária de média tensão (SSDMT)'],
      ['Distribuidora', 'Copel Distribuição S.A.'],
      ['Município', municipio?.nome],
      ['Trechos na célula', Number(trechos) > 0 ? `${fmtInt(trechos)} (quadrícula de 0,25°)` : ''],
      ['Base', fonte ? fonte.replace(/^ANEEL · /, '') : 'BDGD COPEL-DIS 2022-12-31'],
    ],
    source: 'ANEEL · BDGD · DataGeo PR',
  });
}
