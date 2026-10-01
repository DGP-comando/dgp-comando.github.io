// src/data/municipioTooltip.js
//
// Tooltip de hover dos municípios (camada-base): prefeito, VBP, cadeia líder
// fontes protegidas e URs dos programas do IDR, faxinais do inventário do IAT. Só aparece quando nenhuma camada ligada está
// sob o cursor (a base cede o hover, ver layerHost.hoverHit).

import { fmtInt, tipCard } from '../maplibre/tooltipCard.js';

const fmtBRL = (reais) => {
  if (reais >= 1e9) return `R$ ${(reais / 1e9).toFixed(1).replace('.', ',')} bi`;
  if (reais >= 1e6) return `R$ ${(reais / 1e6).toFixed(1).replace('.', ',')} mi`;
  return `R$ ${Math.round(reais).toLocaleString('pt-BR')}`;
};

/** Texto das fontes protegidas: '' sem acesso ao dado, 'nenhuma' sem fonte. */
export function fontesTexto(fontes, carregado) {
  if (!carregado) return '';
  if (!fontes?.total) return 'nenhuma';
  const tipos = Object.entries(fontes.tipos ?? {}).map(([t, n]) => `${fmtInt(n)} ${t.toLowerCase()}`).join(' · ');
  return `${fmtInt(fontes.total)}${tipos ? ` (${tipos})` : ''}`;
}

/** Total do inventário de 2010; '' sem faxinal (a linha some). */
export const faxinaisTexto = (fax) => (fax?.total ? fmtInt(fax.total) : '');

/** Perímetros ARESUR reconhecidos hoje; '' sem nenhum (a linha some). */
export const aresurTexto = (fax) => (fax?.aresur ? `${fmtInt(fax.aresur)} ${fax.aresur === 1 ? 'faxinal' : 'faxinais'}` : '');

/** URs ativas dos programas: '5 (Grãos 3 · Café 2)'; '' sem UR (a linha some). */
export function ursTexto(urs) {
  if (!urs?.total) return '';
  const partes = Object.entries(urs.programas ?? {}).map(([prog, n]) => `${prog} ${fmtInt(n)}`).join(' · ');
  return `${fmtInt(urs.total)}${partes ? ` (${partes})` : ''}`;
}

/**
 * `info`: entrada de municipios-info.json; `fontes`: entrada do município em
 * fontes-protegidas.json; `fontesCarregadas`: o arquivo privado veio (logado);
 * `faxinais`: {total, aresur} do município (src/data/faxinais.js);
 * `urs`: {total, programas} do município (src/data/programasIdr.js).
 */
export function municipioTooltipHtml(nome, info, fontes = null, fontesCarregadas = false, faxinais = null, urs = null) {
  const vbp = info?.vbp;
  return tipCard({
    icon: '🏛️',
    title: nome,
    rows: [
      ['Prefeito', info?.prefeito ? `${info.prefeito} (${info.partido})` : ''],
      ['VBP', vbp ? `${fmtBRL(vbp.valB)} em ${vbp.anoB} (${vbp.deltaPct >= 0 ? '▲ +' : '▼ '}${String(vbp.deltaPct).replace('.', ',')}%)` : ''],
      ['Cadeia líder', info?.cadeia ?? ''],
      ['Fontes protegidas (IDR)', fontesTexto(fontes, fontesCarregadas)],
      ['URs dos programas (IDR)', ursTexto(urs)],
      ['Faxinais (IAT, 2010)', faxinaisTexto(faxinais)],
      ['ARESUR (IAT)', aresurTexto(faxinais)],
    ],
    note: 'Clique para abrir a ficha completa',
    source: `TSE 2024 · SEAB/DERAL · IDR-Paraná${faxinais?.total || faxinais?.aresur ? ' · IAT/GeoPR' : ''}`,
  });
}
