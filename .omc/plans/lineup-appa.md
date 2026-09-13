# Plano: navios do line-up da APPA na camada marítima do DGP

Data: 2026-09-13. Motivo: AISStream sem cobertura na costa do PR (1 msg/120 s na
bbox; mundial 2.794/30 s). Fonte oficial: relatório Line-up da APPA
(appaweb, HTML público, UTF-8, sem login).

## Fonte
`http://www.appaweb.appa.pr.gov.br/appaweb/pesquisa.aspx?WCI=relLineUpRetroativo`
Tabelas por seção: ATRACADOS, PROGRAMADOS, AO LARGO PARA REATRACAÇÃO, AO LARGO,
ESPERADOS, APOIO PORTUÁRIO / OUTROS, DESPACHADOS, LEGENDA. Cabeçalhos diferem
por seção (13 a 22 colunas); linhas de continuação (segundo operador) têm menos
colunas e pertencem ao navio anterior. Datas dd/mm/aaaa hh:mm em horário local.

## Posições (sem coordenada na fonte)
- Berços 201-219: face de atracação do cais comercial (OSM relation 7714317),
  interpolação oeste->leste, deslocada ~45 m para a água. Aproximado.
- 141-144: píer de inflamáveis (OSM way 10793688). 200/200A: píer FOSPAR
  (way 695717879). 113/114: Ponta do Félix, Antonina (way 378019579).
- Ao largo: fundeadouros da APPA no OSM (seamark anchorage 2..12); navio
  distribuído de forma determinística nas áreas 3-9, marcado "área de fundeio".
- 299/499 (apoio) e esperados/programados/despachados: sem posição; só contagem.

## Entregas
1. c2-parana `etl-lineup-appa`: parse.ts + berths.ts (puros, testados com
   fixture real), index.ts (runEtl), `data_cache.appa_lineup_pr`.
2. Migration 043: pg_cron `12,42 * * * *` + expected_cadence. (db push: usuário)
3. DGP: `fetchPortLineup()` e a camada Marítimo desenha atracados e fundeados
   (estilo próprio, rótulo "posição aproximada"), AIS continua somando se voltar.

## Testes
- Deno: parse do fixture (contagens por seção, continuação, datas, números,
  acentos), posições (todo berço conhecido resolve; desconhecido cai no porto).
- Ao vivo: parse do HTML atual.
- Node: cliente DGP + build da camada com payload simulado.
- Pós-deploy: disparo via SQL (dry), linha em data_cache, E2E com a camada ligada.
