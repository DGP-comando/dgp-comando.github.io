# LOG de desenvolvimento — DataGeo Command

> Diário das sessões de trabalho neste repo. Uma entrada por sessão, mais
> recente primeiro. O plano vivo é o `PLANO_FUSAO.md`; aqui fica o registro
> de COMO cada fase aconteceu, com as decisões e as pegadinhas.

---

## Sessão "gev" (continuação) — 2026-08-26: classe "Logística agro"

- **Conjunto novo de camadas** (classe própria no painel, após
  Infraestrutura), primeiro aproveitamento do backlog §8 do PLANO_FUSAO:
  - **Armazéns (CONAB)** — token 5: cadastro CDA/CONAB 2023-11 extraído do
    seed SQL do projeto valor-de-terras (2.458 pontos + porto de
    Paranaguá), 537 KB. Tamanho do ponto proporcional à capacidade
    (≥50 mil t salta na visão regional); label com nome + capacidade
    aparece a < 45 km.
  - **Agroindústrias** — token 6: SIGSIF/MAPA (9 frigoríficos vermelho,
    92 laticínios azul-claro, geocode por centroide municipal) + 28
    serrarias OSM (marrom), 22 KB.
  - **CEASAs** — token 7: 5 unidades da CEASA/PR com label sempre visível.
    Overpass não tem as unidades nomeadas ("ceasa" retornou <3 hits na
    área do PR) — coords hardcoded no build_logistica.py.
- `scripts/build_logistica.py` parseia os INSERTs dos seeds
  (st_makepoint com regex + split ciente de aspas) — o caminho previsto
  no §8 ("extrair INSERTs → JSON") funcionou como planejado.
- `datageoLogistica.js`: factory de pontos estáticos clamped
  (contrato earthquakes: zero CallbackProperty), scaleByDistance,
  distanceDisplayCondition nos labels.

## Sessão "gev" (continuação) — 2026-08-26: Tráfego aéreo ao vivo em produção

- **Causa raiz do feed morto**: airplanes.live respondeu 403 "contact us" a
  partir de 2026-08-12 e o etl-aviacao do c2 parou de gravar. Fonte trocada
  para **adsb.lol** (mesma API v2/readsb, aberta por política, parser
  intacto) — commit 0a78778 no c2, função redeployada, tabela voltou a
  receber snapshots por minuto no mesmo dia.
- **Camada "Tráfego aéreo" (ex Live Flights) em produção, classe
  Infraestrutura**: `_fetchStatesPayload` em flights.js — dev/testes seguem
  no proxy OpenSky; o build de produção lê `aviation_traffic` do Supabase
  (janela 5 min, dedupe por icao24) convertida client-side para o shape
  `/states/all` num Response sintético, então TODO o pipeline GEV
  (billboards, trilha, dead-reckoning, click-to-track) funciona sem tocar.
  ~44 aeronaves no PR em teste.
- Pegadinhas:
  - A string "adsb.lol" no rótulo da fonte dispara a heurística de
    FALLBACK do manager (era a fonte reserva do GEV) — rótulo virou
    "DataGeo PR · etl-aviacao" e o estado lê ATIVA.
  - `import.meta.env` NÃO existe sob node:test: acesso direto crashava o
    LOAD de todo teste que importa datageoClient (flights, firms, voice,
    sprites — falhavam como arquivo desde a ponte de fires). `?.` +
    `DEV !== false` destravou; 6 arquivos voltaram a rodar e expuseram 7
    falhas latentes do FIRMS (pré-existentes, não desta feature).
  - "Aviões parados" na visão estadual é escala, não bug: 240 m/s ≈ 1 px
    a cada ~5 s com o estado inteiro na tela; em zoom próximo o
    dead-reckoning desliza entre os snapshots de 1 min (verificado com
    capturas em T e T+12 s).

## Sessão "gev" (continuação) — 2026-08-26: rodovias em 3 níveis + painel por classes

- **Camada Rodovias (token 4)** em três níveis:
  - Federais (BR-xxx, âmbar) e estaduais (PR/PRC-xxx, azul) estáticas:
    `scripts/build_rodovias.py` consulta o Overpass pela área do PR
    (relation 297640), arredonda a 5 casas e decima vértices — 6,2 MB,
    16,4k trechos, 38 BRs + 268 PRs.
  - **Municipais só com zoom no município** (< 90 km de altura):
    secondary/tertiary/unclassified SEM ref BR/PR, buscadas AO VIVO no
    Overpass por células de 0,25° cacheadas, somem ao afastar o zoom.
    Pegadinha: fan-out paralelo leva 429 do overpass-api.de (limite ~2
    conexões) — a busca é uma FILA SERIAL com 700 ms de respiro e rotação
    de espelho para overpass.kumi.systems em erro. Verificado: 420 vias
    carregadas sobre Guarapuava, show=false ao subir para 500 km.
- **Painel de camadas por classes** (Limites, Infraestrutura, Clima,
  Hidrologia, Ambiente, Saúde e ar, Riscos e alertas, Contexto global):
  módulo declara `category`, `getAll()` expõe, `_renderToggles` agrupa com
  headers estáticos (o refresh só reescreve rows, headers ficam). Fallback
  "Contexto global" para as camadas GEV herdadas. As factories
  (`createDatageoLayer`, `createFirmsHeatmapLayer`) precisaram repassar o
  campo — config com category sem repasse morre em silêncio.
- Teste `cockpitMarkup` pinava a linha literal `if (!layer.showInTogglePanel)
  continue;` do manager — regex atualizada para o novo filter.

## Sessão "gev" (continuação) — 2026-08-26: ficha municipal, UI pt-BR e mobile

- **Ficha municipal ao clique** (`src/datageoFicha.js` + LEFT_CLICK em
  `datageoMunicipios.js`): painel lateral (quase-modal, z=120) com seções
  extensíveis — Economia SEAB (VBP 24→25 + **top-3 produtos** com barras e
  R$), População IBGE (estimativa 2025 + nascidos/óbitos 2024 + saldo
  vegetativo), Segurança SINESP (vítimas 2022 vs 2021 + taxa/100k, com o
  aviso de que a série municipal para em 2022), IRTC com barras por
  domínio, Dengue (série 8 SE + projeção), focos 7/30d, clima, hidro,
  ar, incidentes e notícias. `fetchMunicipioFicha` faz Promise.allSettled
  em 11 fontes Supabase; o resto vem do `municipios-info.json` local.
- **Gerador agrega o ecossistema DataGeo** (o que não está no c2):
  `saude-parana` (populacao_anos/nascidos/obitos, SIDRA D1C/V/D3N) e
  `seguranca-parana` (criminalidade SINESP 2018-2022, soma de vítimas por
  município/ano). 209 KB, cobertura 399/399 em produtos+pop+segurança.
- **UI 100% pt-BR** (pedido: vai para o secretário da agricultura):
  painéis (CAMADAS DE DADOS, CENAS, TELA, MAPA BASE, ESTILOS VISUAIS,
  LOCALIZAÇÃO), estados das camadas (ATIVA/DESLIGADA/CARREGANDO/
  DESATUALIZADA/INDISPONÍVEL...), meta-linhas ("há 2 min", "nova tentativa
  em 30s"), HUD — o "TOP SECRET // SI-TK // NOFORN" fake virou
  "DADOS PÚBLICOS // DATAGEO PR" (mandar classificação falsa para um
  secretário de Estado seria um tiro no pé). Nomes de camadas em pt claro
  (Terremotos, Barragens, Cabos submarinos, Focos de calor (queimadas),
  Nível dos rios, Alertas de desastre...).
- **LOCALIZAÇÃO agora é o Paraná**: Austin/SF/NYC/Tóquio/Londres/Paris/
  Dubai/DC substituídas por Curitiba, Londrina, Maringá, Cascavel, Foz
  (Cataratas/Itaipu/Marco/Ponte), Ponta Grossa (Vila Velha), Guarapuava e
  Paranaguá (porto/Ilha do Mel). Nada referencia as chaves antigas fora de
  testes de voz (dev-only) — 12 testes de voz/cockpit derivaram por citar
  Austin; deriva intencional, documentada aqui.
- **Passe mobile** (screenshot do Android mostrou o estrago): dock sem a
  coluna de voz via `:has()`, ficha em tela quase cheia, painéis da
  esquerda na largura útil, HUD/TELA/CENAS ocultos ≤700px, alvos de toque
  maiores, tooltip municipal desativado em `pointer: coarse` (sem hover em
  touch; o clique abre a ficha).
- **Produção sem cadáveres**: `main.js` remove os painéis CCTV/contexto/
  rádio do DOM e não inicializa a voz (dock "VOICE STANDBY" morto que
  aparecia no celular) fora do dev.
- Testes: rótulos atualizados em manager/traffic/panelStack/mapStackChips/
  locationStatus; suíte sem falhas NOVAS além da deriva de voz acima
  (baseline já tinha dezenas de falhas próprias do fork; 4 do chip esri
  seguem).
- **Inventário de assets** (agente varreu 6 projetos: valor-de-terras,
  3d-land-cover, ndvi/no2-parana, pr-temp, energy) — backlog em
  PLANO_FUSAO.md §7.

## Sessão "gev" (continuação) — 2026-08-26: ventos, VBP 24→25 e bordas

- **`datageo-ventos` (token 3)**: partículas estilo earth.nullschool via
  `cesium-wind-layer` (GPU, 4.096 partículas) alimentada por grade 22×15 do
  **Open-Meteo** (gratuito, sem chave — funciona no deploy estático).
  u/v da direção meteorológica; flipY false com linha 0 = sul. A camada
  segura `holdContinuousRender` enquanto ligada (partícula anima todo
  frame) e libera no disable. No preset Agroambiental.
- **VBP do tooltip agora 24→25 (SEAB/DERAL)**: o gerador trocou a PAM/IBGE
  pela base local do projeto vbp-parana do Avner
  (dashboard/public/data/detailed_municipio_*.json, R$ correntes) — mesma
  fonte do avnergomes.github.io/vbp-parana. Bônus: "cadeia líder" agora usa
  as 26 cadeias SEAB (inclui pecuária) — Toledo virou Suinocultura (antes a
  PAM cegava para pecuária e dizia soja), Curitiba Olericultura.
- **Bordas municipais permanentes**: polyline clamped por anel externo
  (399), cyan 0.32 — contorno "queimado" no satélite o tempo todo; o hover
  ignora o pick da divisa para o tooltip não piscar.
- Painel reordenado (DataGeo primeiro) e, em produção, só camadas com
  backend vivo (proxy-dependentes do GEV ficam fora do build estático).
- Pegadinha nova: heredoc do Git Bash come backslashes em scripts Python
  inline — usar forward slashes em paths Windows.

## Sessão "gev" (continuação) — 2026-08-26: marítimo, ferrovias e a verdade sobre trânsito/CCTV

- **`datageo-maritimo` (token 1)**: lê `maritime_traffic` com janela ESTRITA
  de 24 h — mostra 0 hoje porque a conta AISStream segue cortada (health de
  hoje: total_vessels 0; tabela parada em 2026-08-02 com 52 linhas). Plotar
  navio velho como posição atual seria desinformação. Reativação = conta
  nova em aisstream.io → `supabase secrets set AISSTREAM_API_KEY` →
  reagendar o cron do etl-maritimo (ação do usuário; a camada acorda
  sozinha).
- **`datageo-ferrovias` (token 2)**: malha ferroviária via Overpass/OSM
  (railway=rail, 1.819 trechos, 1,1 MB em public/data/ferrovias-pr.geojson),
  clamped, no preset Agroambiental. CONTEXTO, não fluxo: não existe posição
  de trem pública no Brasil (Rumo não expõe GPS).
- **Trânsito**: fluxo ao vivo tokenless para o PR NÃO existe. EPR Paraná tem
  mapa "tempo real" (obras/acidentes/interdições) sem API pública; rota real
  é TomTom BYOK via Edge Function (Fase 3) ou parceria Waze CCP (nota: órgão
  público pode pleitear). Nada fingido com simulação.
- **CCTV**: o pack do GEV (Austin/TfL/Caltrans) depende de open data de
  câmeras com CORS — não existe equivalente no PR. URBS tem CCO/câmeras mas
  sem catálogo público acessível (site 403 para fetch externo; streams
  municipais sem CORS não embedam client-side). Camada CCTV segue sem fonte
  PR; candidata a ocultar do painel em produção (item Fase 3).
- Tokens a-z esgotaram; validador aceita [a-z0-9] — passamos aos dígitos.

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
