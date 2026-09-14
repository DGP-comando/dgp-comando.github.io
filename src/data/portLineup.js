// src/data/portLineup.js
//
// Line-up oficial dos Portos de Paranaguá e Antonina (APPA), gravado em
// data_cache `appa_lineup_pr` pelo job etl-lineup-appa do c2-parana (pg_cron,
// 30 min). Substitui na prática a AISStream na camada marítima: a AISStream
// não tem cobertura de receptores na costa do PR (diagnóstico 2026-09-13).
//
// Posições NÃO vêm da fonte: navio atracado vai no berço (coordenada
// aproximada derivada do OSM) e navio ao largo numa área de fundeio
// (posição ilustrativa). Os rótulos dizem isso explicitamente.
//
// Puro: sem Cesium nem rede, para testar.

/** Payload mais velho que isso não é desenhado: navio de horas atrás não é "agora". */
export const LINEUP_MAX_AGE_MS = 3 * 3600_000;

const SECAO_LABEL = {
  atracados: 'atracado',
  ao_largo: 'ao largo',
  ao_largo_reatracacao: 'ao largo (reatracação)',
};

/** Valida o payload do etl-lineup-appa; null se ausente, de outra versão ou velho. */
export function validLineup(payload, now = Date.now()) {
  if (!payload || payload.version !== 1 || !Array.isArray(payload.navios)) return null;
  const fetchedAt = Date.parse(payload.fetched_at ?? '');
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > LINEUP_MAX_AGE_MS) return null;
  return payload;
}

const formatHora = (iso) => {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  }).format(new Date(ms)).replace(',', '');
};

/**
 * Linhas prontas para desenhar: uma por navio com posição.
 * @returns {Array<{id: string, lat: number, lon: number, kind: 'berco'|'fundeio', label: string, props: object}>}
 */
export function lineupEntityRows(payload) {
  const rows = [];
  for (const navio of payload?.navios ?? []) {
    // typeof: Number(null) é 0 e desenharia o navio no Golfo da Guiné.
    const lat = navio?.posicao?.lat;
    const lon = navio?.posicao?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const kind = navio.posicao.tipo === 'fundeio' ? 'fundeio' : 'berco';
    const carga = (navio.mercadorias ?? []).slice(0, 1).join('');
    const quando = kind === 'berco'
      ? (navio.atracacao ? `atracou ${formatHora(navio.atracacao)}` : '')
      : (navio.chegada ? `chegou ${formatHora(navio.chegada)}` : (navio.eta ? `ETA ${formatHora(navio.eta)}` : ''));
    const linha2 = kind === 'berco'
      ? [`Berço ${navio.berco ?? '?'}`, carga].filter(Boolean).join(' · ')
      : [SECAO_LABEL[navio.secao] ?? 'ao largo', navio.berco ? `aguarda berço ${navio.berco}` : '', 'posição ilustrativa'].filter(Boolean).join(' · ');
    rows.push({
      id: `appa:${navio.programacao || `${navio.embarcacao}|${navio.berco ?? ''}`}`,
      lat,
      lon,
      kind,
      // Berços ficam a ~180 m: rótulo curto, e `labelAbove` alterna o lado
      // do ponto para vizinhos não se sobreporem.
      label: [navio.embarcacao, linha2].filter(Boolean).join('\n'),
      labelAbove: rows.length % 2 === 0,
      // Rumo do eixo do cais/píer (atracado); null no fundeio.
      rumo: typeof navio.posicao.rumo === 'number' ? navio.posicao.rumo : null,
      loaM: typeof navio.loa_m === 'number' ? navio.loa_m : null,
      props: {
        quando,
        fonte: 'APPA line-up',
        kind,
        secao: navio.secao,
        embarcacao: navio.embarcacao,
        imo: navio.imo ?? null,
        berco: navio.berco ?? null,
        local: navio.posicao.local ?? null,
        operadores: (navio.operadores ?? []).join(' + '),
        mercadorias: (navio.mercadorias ?? []).join(' + '),
        sentido: navio.sentido ?? null,
        agencia: navio.agencia ?? null,
        loaM: navio.loa_m ?? null,
        dwtT: navio.dwt_t ?? null,
        atracacao: navio.atracacao ?? null,
        chegada: navio.chegada ?? null,
        eta: navio.eta ?? null,
        janelaFim: navio.janela_fim ?? null,
        previsto: navio.previsto ?? null,
        realizado: navio.realizado ?? null,
        unidade: navio.unidade ?? null,
        emitidoEm: payload.emitted_at ?? null,
      },
    });
  }
  return rows;
}

/** Resumo para o painel: "16 atracados · 31 ao largo · 16 programados". */
export function lineupSummary(payload) {
  const c = payload?.counts ?? {};
  const parts = [
    [c.atracados, 'atracado', 'atracados'],
    [(c.ao_largo ?? 0) + (c.ao_largo_reatracacao ?? 0), 'ao largo', 'ao largo'],
    [c.programados, 'programado', 'programados'],
  ].filter(([n]) => Number(n) > 0).map(([n, one, many]) => `${n} ${Number(n) === 1 ? one : many}`);
  return parts.join(' · ');
}
