# Plano: grade Open-Meteo no pg_cron do c2-parana -> data_cache

Data: 2026-09-13. Motivo: o DGP buscava 330 pontos da Open-Meteo por visitante e
estourou o limite por IP (429/503).

## Restrições descobertas
- Open-Meteo free: 600/min, 5.000/h, 10.000/dia. Na prática cada coordenada
  conta como chamada (429 após ~660 pontos). 330 pontos a cada 30 min = 15.840/dia:
  estoura. etl-clima já usa ~1.150/dia do lado Supabase.
- `current` == slot `minutely_15` do horário (verificado ao vivo em 3 pontos).
- data_cache é legível pela anon key em produção (43 chaves visíveis).
- CLI Supabase sem login nesta máquina; `db push` é bloqueado para o agente
  (docs/NEXT_SESSION.md do c2): usuário roda `supabase login` e `db push`.
- Ordem do c2: migration de cron com `etl.trigger_headers()` antes do deploy
  (aqui a função é nova, sem cron anterior: deploy primeiro é seguro).

## Desenho
- Edge Function `etl-meteo-grade` (runEtl, token de disparo):
  - lê `meteo_grade_pr_forecast`; chama a API só se ausente, > 110 min, sem
    slot cobrindo agora ou grade diferente. Busca `minutely_15`
    (past 2, forecast 12 = 3 h) em 3 lotes de 110 pontos.
  - grava `meteo_grade_pr` (slot vigente: u/v em m/s no formato do
    cesium-wind-layer + precip), source `etl_meteo_grade`.
  - Custo: 12 buscas/dia x 330 = 3.960 chamadas/dia.
- Migration 042: cron `*/30 * * * *` + `etl.expected_cadence`.
- DGP: `fetchWeatherGrid` tenta localStorage fresco -> `meteo_grade_pr` (< 75 min)
  -> Open-Meteo direto -> grade salva antiga.

## Testes
- Deno: lógica pura (grid.ts) com fixtures + script contra a API real.
- Node: cliente DGP com data_cache simulado (servidor, fallback, dimensões).
- Pós-deploy: disparo do cron, linha em data_cache via anon, E2E do DGP
  contando 0 chamadas à Open-Meteo.
