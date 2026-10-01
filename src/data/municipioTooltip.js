// src/data/municipioTooltip.js
//
// Tooltip de hover dos municípios (camada-base): prefeito, VBP, cadeia líder
// e fontes protegidas pelo IDR. Só aparece quando nenhuma camada ligada está
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

/**
 * `info`: entrada de municipios-info.json; `fontes`: entrada do município em
 * fontes-protegidas.json; `fontesCarregadas`: o arquivo privado veio (logado).
 */
export function municipioTooltipHtml(nome, info, fontes = null, fontesCarregadas = false) {
  const vbp = info?.vbp;
  return tipCard({
    icon: '🏛️',
    title: nome,
    rows: [
      ['Prefeito', info?.prefeito ? `${info.prefeito} (${info.partido})` : ''],
      ['VBP', vbp ? `${fmtBRL(vbp.valB)} em ${vbp.anoB} (${vbp.deltaPct >= 0 ? '▲ +' : '▼ '}${String(vbp.deltaPct).replace('.', ',')}%)` : ''],
      ['Cadeia líder', info?.cadeia ?? ''],
      ['Fontes protegidas (IDR)', fontesTexto(fontes, fontesCarregadas)],
    ],
    note: 'Clique para abrir a ficha completa',
    source: 'TSE 2024 · SEAB/DERAL · IDR-Paraná',
  });
}
