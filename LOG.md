# LOG de desenvolvimento — DataGeo Command

> Diário das sessões de trabalho neste repo. Uma entrada por sessão, mais
> recente primeiro. O plano vivo é o `PLANO_FUSAO.md`; aqui fica o registro
> de COMO cada fase aconteceu, com as decisões e as pegadinhas.

---

## Sessão "gev" (continuação) — 2026-08-26: tooltip municipal

- **Camada `datageo-municipios` (token v)**: 399 polígonos do
  municipios-pr.geojson (207 KB, clamped) com hover → highlight + tooltip
  DOM: prefeito atual (partido), variação do VBP de lavouras entre os dois
  últimos anos da PAM e lavoura líder. Incluída nos 3 presets de missão.
- **Dataset `public/data/municipios-info.json`** (73 KB) gerado por
  `scripts/build_municipios_info.py`: prefeitos dos resultados OFICIAIS do
  TSE 2024 (JSONs de resultados.tse.jus.br — o CDN de dados abertos
  bloqueia curl/urllib com 403; a rota de resultados não), 1º e 2º turno;
  VBP e lavoura líder do SIDRA t5457 v215 (2023→2024 — PAM 2025 ainda não
  existe; o tooltip rotula o biênio real). 398/399 prefeitos — São Tomé
  (4126108) deu 404 no TSE (provável pleito anulado/suplementar), tooltip
  mostra "—".
- Nota SIDRA: na t5457, v214 é QUANTIDADE (t) e **v215 é o valor da
  produção** — o etl_agro do c2 usa v214 como VBP (bug latente anotado).
- Verificado com hover real: Prudentópolis → Adelmo (PSD), VBP ▼ -17,3%,
  Soja (em grão).
- **Fix do seletor de basemaps**: o tray usava a allowlist original do GEV
  (Google/Bing/OSM) — o `esri` não aparecia e, ao escolher OSM, não havia
  volta. Agora `esri` está na lista e o tray renderiza SÓ os stacks
  disponíveis (keyless = SAT + OSM; com chaves, Google/Bing reaparecem).

## Sessão "gev" (continuação) — 2026-08-26: publicação

- **Org GitHub `DGP-comando` criada** (via browser — criação de org não tem
  API pública; form preenchido com a conta do Avner, plano Free).
- **Repo `DGP-comando/dgp-comando.github.io`** criado via gh CLI; main
  pushado (histórico completo da fusão).
- **GitHub Pages no ar: https://dgp-comando.github.io/** com o workflow
  `.github/workflows/deploy-pages.yml` (Node 26, npm ci + vite build +
  actions/deploy-pages).
- Pegadinha de Pages em repo `<org>.github.io`: o Pages se auto-ativa em
  modo BRANCH (Jekyll) e o build automático serve o fonte cru por cima do
  artifact do workflow (`Failed to resolve module specifier "cesium"` foi o
  sintoma — o HTML publicado era o `/src/main.js` fonte). Fix:
  `gh api repos/.../pages -X PUT -f build_type=workflow` + re-dispatch.

## Sessão "gev" — 2026-08-25 → 2026-08-26

A sessão que criou este repo. Arco completo, do estudo ao produto:

### 1. Estudo do God's Eye View (2026-08-25)
- Repo `bilawalsidhu/gods-eye-view` (MIT, 3.7k stars) estudado: globo
  CesiumJS + 13 camadas live + HUD tático + voz. Clone completo estoura
  timeout (~80 MB de GIFs em docs/media); usar `--filter=blob:none` +
  sparse-checkout sem `docs/media`.
- Conclusão do estudo: o GEV é a "sala de comando" que o pivô C4ISR do
  c2-parana abandonou; o c2 tem o backend que o GEV não tem. Fusão óbvia.

### 2. Ponte piloto no fork (`gods-eye-view` local)
- Plugin `datageoFiresProxy` no vite.config.js servindo `fire_spots` do
  Supabase no contrato de `/api/firms` — 368 focos renderizados no heatmap
  FIRMS sem tocar o cliente. Janela de 48 h (cadência do cron é 12 h).
- Boot keyless: chave Google placeholder → fallback globo Cesium + OSM
  (comportamento já previsto em main.js).
- Stack `esri` criado (Esri World Imagery + labels de referência, receita
  tokenless do webgis Serra do Mar) e promovido a fallback keyless default.
- Dev hooks: `__gevViewer`, `__gevDataManager`, `__gevMapStack`.

### 3. Contexto paralelo: cutover do c2 (registrado no repo do c2)
- A migração Actions→Supabase do c2 foi concluída na mesma sessão: 13 Edge
  Functions deployadas + migrations 039-041 (pg_cron). Relevante aqui porque
  ESTE repo consome esses pipelines — inclusive o cache
  `infohidro_estacoes_pr` que a nova `scrape-infohidro` gravou às 06:33.

### 4. Fusão — Fase 1 (repo criado, commit 81c70af)
- Decisão arquitetural verificada antes de codar: as 12 tabelas do c2 têm
  RLS anon-read ⇒ leitura direto do browser, sem proxy ⇒ deployável estático.
- `datageoClient.js`, `prCentroids.js` (399 municípios por IBGE), 5 camadas
  (clima/rios/cemaden/irtc/dengue), fires client-side, `flyToParana`,
  `dynamicAtmosphereLighting=false` (o dia/noite apagava o satélite à
  noite), branding Sala de Situação.
- Verificação em browser: clima 12 · rios 8 · cemaden 0 (válido) · IRTC 399
  · dengue 399 · focos 368, zero erros.

### 5. Fusão — Fase 2 (commit 8cec1ed)
- 4 camadas novas: ar (AQICN, 12), anomalias (z-score 7 d, âncora por nome,
  12 reais no teste), incidentes (0, tabela vazia), infohidro (1.312
  estações). Tokens y/p/o/l nos share links.
- `datageoTicker.js` (notícias no rodapé) e `datageoBriefing.js` (relatório
  situacional diário, card colapsável).
- Presets de missão no first-run: Defesa Civil / Epidemiológico /
  Agroambiental. Testado com clique real: preset ligou 4 camadas e o share
  link serializou `l=w.k.h.n`.
- Build estático validado (`vite build` + `preview` :4175, zero erros).

### 6. Mapa das 26 páginas do c2 (commit da seção 5b do plano)
- Cada página do console React ganhou destino explícito: absorvida pelo
  globo, feature da Fase 3, ou permanece no console (auth/billing/CRUD).
  Ver `PLANO_FUSAO.md` §5b.

### Pegadinhas descobertas (economizam horas na próxima sessão)
- **Vite no Windows**: `--host localhost` binda só em IPv6 `[::1]` e o
  Chrome não conecta; usar `--host 127.0.0.1`.
- **Aba em background**: o GEV suspende o render loop (`visibilitychange`) —
  tela preta e fila de tiles travada. Em automação, sobrescrever
  `document.hidden` e religar `useDefaultRenderLoop`. Screenshots borrados
  em background NÃO são bug do produto.
- **Estado persistido**: localStorage + sessionStorage reidratam
  `map=osm`/dismissals de sessões velhas; teste limpo exige limpar os dois e
  recarregar sem hash.
- **flyTo do boot** sobrescreve `setView` feito durante o voo; usar
  `camera.cancelFlight()` antes.
- **IRTC**: "médio" cobre quase o estado — label/outline só em alto/crítico,
  senão são 300+ labels de ruído.
- **`fire_spots` sem `frp`**: cards mostram "0.0 MW" até o ETL do c2 gravar
  o campo (fix conhecido, 1 coluna + 1 linha no ETL).
- **Anon key**: a válida vem do bundle publicado do console
  (`avnergomes.github.io/c2-parana`); a do `.env.local` do c2 está
  rotacionada.

### Estado ao fim da sessão
- Commits: `81c70af` (Fase 1) → `8cec1ed` (Fase 2) → docs §5b. Sem remoto.
- Dev: `npm run dev -- --host 127.0.0.1 --port 4174`.
- Próximo (Fase 3): card de clique no município (ReconhecimentoPage no
  globo), KPIs agro no HUD, auth compartilhada, deep links para o console,
  publicação do `dist/` (aguarda decisão de hospedagem/domínio).
