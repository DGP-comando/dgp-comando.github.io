// src/data/municipioTooltip.js
//
// HTML do tooltip de hover dos municípios (prefeito, VBP, cadeia líder), sem
// dependência de engine: usado pela camada Cesium (datageoMunicipios.js) e pelo
// protótipo MapLibre. As classes .mt-* são estilizadas por quem mostra.

const fmtBRL = (reais) => {
  if (reais >= 1e9) return `R$ ${(reais / 1e9).toFixed(1).replace('.', ',')} bi`;
  if (reais >= 1e6) return `R$ ${(reais / 1e6).toFixed(1).replace('.', ',')} mi`;
  return `R$ ${Math.round(reais).toLocaleString('pt-BR')}`;
};

export function municipioTooltipHtml(nome, info) {
  const lines = [`<div class="mt-nome">${nome}</div>`];

  if (info?.prefeito) {
    lines.push(`Prefeito: ${info.prefeito} <span class="mt-dim">(${info.partido})</span>`);
  } else {
    lines.push('Prefeito: <span class="mt-dim">—</span>');
  }

  if (info?.vbp) {
    const { anoA, anoB, valB, deltaPct } = info.vbp;
    const up = deltaPct >= 0;
    const arrow = up ? '▲' : '▼';
    const cls = up ? 'mt-up' : 'mt-down';
    const pct = `${up ? '+' : ''}${String(deltaPct).replace('.', ',')}%`;
    lines.push(
      `VBP ${anoA.slice(2)}→${anoB.slice(2)}: ` +
        `<span class="${cls}">${arrow} ${pct}</span> ` +
        `<span class="mt-dim">(${fmtBRL(valB)})</span>`,
    );
  } else {
    lines.push('VBP: <span class="mt-dim">sem dado</span>');
  }

  if (info?.cadeia) {
    lines.push(`Cadeia líder: ${info.cadeia}`);
  }

  lines.push(
    '<div class="mt-fontes">Clique para abrir a ficha completa<br/>TSE 2024 · VBP SEAB/DERAL 24-25</div>',
  );
  return lines.join('<br/>').replace('<br/><div class="mt-fontes">', '<div class="mt-fontes">');
}
