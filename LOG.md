# LOG de desenvolvimento — DataGeo Command

> Diário das sessões de trabalho neste repo. Uma entrada por sessão, mais
> recente primeiro. O plano vivo é o `PLANO_FUSAO.md`; aqui fica o registro
> de COMO cada fase aconteceu, com as decisões e as pegadinhas.

---

## Sessão 2026-09-11: municípios como piso, busca por município, precipitação, VBP/ha e conectividade

Quatro entregas, todas commitadas e no ar (`19c208d` → `1d4c263` → `61cdbbe` →
`355a878`). Cada uma revelou defeito real; o que quebrou está em Pegadinhas.

### 1. Municípios sempre ativos + busca por município (commit `19c208d`)
- **Piso de camadas** (`BASELINE_LAYER_IDS` em layerState.js): não existia
  mecanismo de "camada padrão ligada" — num boot limpo `start()` retornava
  cedo e NENHUMA camada subia. O piso é aplicado uma vez em `start()`, e
  deliberadamente NÃO dentro de `normalizeLayerState`: o estado durável
  precisa continuar capaz de dizer "desligada", senão o toggle mentiria no
  localStorage e no share link. Só o próximo boot religa.
- `_restoreBaselineLayers()` é estreito de propósito: liga só o piso, sem
  tocar em nenhuma outra camada nem empurrar params, preservando o contrato
  de que num boot limpo os inicializadores dos módulos são a verdade (o
  invariante do `models3d`).
- **Busca local dos 399** (`src/municipioSearch.js`, módulo puro): resolve o
  nome contra `prCentroids` ANTES do geocoder. O código IBGE que ela devolve
  é o que abre a ficha — o geocoder devolvia ponto sem identidade e por isso
  nunca conseguiu abrir a aba certa. Tolerante a acento, caixa, conectivo
  ("sao jorge do oeste" acha "São Jorge d'Oeste") e sufixo de UF.
- Escolher um município enquadra a câmera na **divisa real** do polígono
  (BoundingSphere unida por CD_MUN, então ilha de Paranaguá entra no
  enquadramento) e abre a ficha.

### 2. Camada de precipitação irmã da de ventos (commit `1d4c263`)
- As duas leem a MESMA grade Open-Meteo 22x15 na MESMA requisição: a lista
  `current=` já aceitava `precipitation` junto com vento. `fetchWindGrid`
  virou `fetchWeatherGrid` com a PROMESSA memoizada (TTL 25 min contra
  updateInterval de 30), o que resolve cache e dedup de concorrentes de uma
  vez. Medido em browser: 3 requisições com as duas ligadas, não 6.
- Render: retângulo comum a altura fixa (90 m) com textura de canvas, ABAIXO
  das partículas de vento (120 m); há teste travando essa relação porque as
  duas constantes moram em arquivos diferentes.
- Escala violeta→fúcsia que PARA em `#e879f9`. Violetas claros colapsam
  contra o ciano do vento sob protanopia/deuteranopia (ΔE 3-4), justamente
  no topo da escala. A magnitude acima do meio é carregada pelo ALPHA, não
  pelo brilho. O teto também evita o `#c084fc` dos quilombolas.

### 3. VBP por hectare na ficha (commit `61cdbbe`)
- Denominador = **área total do município** (IBGE agregado 4714, variável
  6318, Censo 2022), decisão do Avner e correta: metade do VBP do PR vem de
  criações que não declaram área NENHUMA (avicultura R$ 52 bi,
  bovinocultura R$ 32 bi, suinocultura R$ 14 bi). Só 47% do VBP tem área.
- Consequência registrada em teste: área é fixa entre 24 e 25, então a
  variação do R$/ha é IGUAL à do valor. Os dois +14,2% lado a lado não são
  bug — o que o indicador acrescenta é o NÍVEL (Curitiba R$ 297/ha,
  agrícolas intensivos > R$ 50 mil/ha).

### 4. Camada de Conectividade (commit `355a878`)
- 5.803 ERBs por geração mais alta (5G 816 · 4G 4.5K · 3G 407 · 2G 94) +
  o NEGATIVO da cobertura: 132.692 km² sem 3G+, 67% do estado.
- `scripts/build_conectividade.py` converte o acervo do IDR
  (`H:\IDR-PARANA\renovaPR\Conectividade`). Simplificação roda ANTES da
  reprojeção para a tolerância estar em metros; 600 m leva 7,3 MB → 2,6 MB
  mexendo +1,3% na área, e fragmentos < 0,5 km² saem.
- A DATA do levantamento vai na linha do painel ("levantamento 2024-01"),
  com teste travando o campo nos dois arquivos.

### Pegadinhas descobertas (economizam horas na próxima sessão)
- **`overflow` recorta dropdown que abre para CIMA**: `#command-dock
  .location-city-row` tinha `overflow: hidden`, e a lista de sugestões era
  montada, marcada visible, respondia às setas — e não pintava um pixel,
  com o clique atravessando para o globo. **`overflow-x: clip` NÃO resolve**:
  medido em Chrome real a 1440 e 390 px, a lista continua fora do hit-test.
  Só `overflow: visible`. Achado por revisão adversarial, não pelo meu
  smoke test — que passou porque eu dirigia o DOM por script em vez de
  clicar de verdade.
- **Popover do dock nasce fora da borda esquerda em tela estreita** (a 390 px
  a `.location-city-row` começa em x=-36), então qualquer coisa ancorada
  nela herda o deslocamento. A lista agora é presa ao viewport ao abrir.
- **Imagery layer está MORTA no stack photoreal**: `globe.show = false` e o
  `Globe.render()` do Cesium retorna cedo, então `imageryLayers` não desenha
  nada. Retângulo texturizado grudado no terreno também não serve: o próprio
  Cesium desaconselha e degrada EM SILÊNCIO para cor chapada sem a extensão
  WebGL. Retângulo comum a altura fixa é o caminho sem armadilha.
- **Partículas de vento não renderizam em automação**: nem headless com
  SwiftShader, nem aba em segundo plano com `viewer.render()` forçado (o
  rAF estrangulado dá dt≈0 e a advecção não anda). Elas somem MESMO com a
  precipitação desligada, então some ≠ oclusão. O par vento+chuva continua
  sem conferência visual.
- **API do IBGE responde gzip sem pedir** e o `urllib` não desempacota:
  `json.loads` morre com "can't decode byte 0x8b". `fetch()` do gerador
  agora trata Content-Encoding.
- **Falha do TSE APAGAVA o prefeito**, em silêncio: o gerador só acrescenta
  quem responde. Agora o JSON anterior preenche as lacunas. Já valeu nesta
  rodada (um 404, zero prefeitos perdidos).
- **Caminho fixo em `C:`**: o `GH` do build_municipios_info apontava para
  `C:/Users/avner/...` e o checkout vive em `E:`. Agora é derivado da posição
  do próprio arquivo.
- **Área com valor ZERO na base do VBP**: "Pastagens E Forragens" (4,2 mi ha)
  e "MATA NATIVA" (3,1 mi ha) são inventário de uso do solo, não produção.
  Entram no denominador se você somar `ar` sem filtrar por `v > 0`.
- **First-run launcher tapa o dock** numa sessão virgem: em automação,
  `localStorage['gev:first-run-mission:v1'] = 'suppressed'` ANTES do boot
  (`evaluateOnNewDocument`), senão `elementFromPoint` devolve o `<aside>`.
- **Git não está no PATH** desta máquina; o binário utilizável é o do
  GitHub Desktop (`...\GitHubDesktop\app-*\resources\app\git\cmd\git.exe`).
  Não havia `user.name`/`user.email` — foram gravados com `--local`.
- **Interceptação de request no puppeteer precisa devolver CORS**: a resposta
  sintética sem `Access-Control-Allow-Origin` é bloqueada, e o sintoma
  ("Failed to fetch") parece bug do produto.

### Estado ao fim da sessão
- 4 commits, todos com push para `origin/main`. Testes: 2623, 2572 passando.
  As 51 falhas são as MESMAS de antes da sessão (baseline 2587/2536/51) —
  nenhuma nova. Build limpo.
- Tokens de share link usados nesta sessão: `C` (precipitação), `D`
  (conectividade). Livres a partir de `E`.
- **Pendências**: (a) conferir vento + precipitação juntos na tela;
  (b) `particleHeight: 120` do vento é altura absoluta com teste de
  profundidade e o relevo do PR chega a 1877 m — no keyless/Esri o terreno é
  plano e não aparece, com tiles 3D o vento provavelmente está enterrado;
  (c) dado ANATEL mais novo que 2024-01 (dados.gov.br exige chave, Mosaico é
  UI em JS, caminhos de dados abertos dão 404); (d) `.pyc` commitado por
  engano em `scripts/__pycache__/build_energia.cpython-312.pyc`;
  (e) `layerState.test.mjs:158` afirma 16 camadas e o fork tem 39 — corrigir
  expõe a asserção de ordenação logo abaixo, que mudaria a ordem canônica
  dos tokens; (f) `docs/CURRENT-STATE.md` segue 100% upstream, sem DataGeo.

---

## Sessão "gev" (continuação) — 2026-08-26: usinas, TIs e quilombolas

- **Usinas de energia (token 0, Infraestrutura)**: SIGEL/ANEEL do projeto
  energy — 62 UHE + 323 PCH + 239 CGH + 222 UTE + 22 EOL + 3 UFV + 106
  aerogeradores individuais (977 pontos, 145 KB). Cor por fonte, tamanho
  por potência; UHE ≥500 MW tem label na visão estadual (a cascata do
  Iguaçu — Foz do Areia 1.676 MW, Salto Santiago 1.420, Segredo 1.268 —
  conta a história sozinha). Aerogeradores só aparecem < 60 km.
- **Terras indígenas (token A, Limites)**: FUNAI/CMR via seed
  restricted_areas do valor-de-terras (regex sobre WKT + shapely), 57
  polígonos com etapa e hectares, laranja com fill 0.25 + borda por anel.
  Pegadinha: o nome da FUNAI já vem com prefixo "TI " — checar antes de
  prefixar ("TI TI Marrecas" no primeiro screenshot).
- **Territórios quilombolas (token B, Limites)**: o INCRA passou a exigir
  LOGIN no acervo de certificação (o export_shp.py devolve a tela de
  login) — a fonte virou a malha OFICIAL do Censo 2022 do IBGE
  (ftp.ibge.gov.br/.../Quilombolas_Primeiros_resultados_do_universo/
  Arquivos_geoespaciais_vetoriais_2a_apuracao_20231222/BR_TQ_*.zip,
  colunas sg_uf/nom_tq/status). 10 territórios no PR com fase
  (PORTARIA/RTID/DECRETO), roxo. geopandas via zip://...!caminho/arquivo.shp
  (o zip tem subpasta; sem o fragmento o pyogrio não acha o .shp).
- **Espaço de tokens estendido a A-Z**: os 36 [a-z0-9] esgotaram (35 em
  uso + '0'). Encode/decode do hash preservam case de ponta a ponta
  (join/split '.' + Map por token), então maiúscula é segura. Dois testes
  usavam 'z' como "token desconhecido" e quebraram quando o 'z' foi
  atribuído na Fase 2 (falha pré-existente) — migrados para 'Z' e
  voltaram a passar.

## Sessão "gev" (continuação) — 2026-08-26: transmissão de energia (EPE)

- **Linhas de transmissão (token 8)** e **Subestações (token 9)** na
  classe Infraestrutura, segundo saque do backlog §8 (raw EPE do projeto
  energy local, normalizado por `scripts/build_energia.py`):
  - LTs: 248 em operação + **49 planejadas 2025-2037** (731 KB). Cor por
    tensão — 525 kV violeta (o corredor de Itaipu salta), 230 kV azul,
    demais cinza; planejadas TRACEJADAS em âmbar
    (PolylineDashMaterialProperty funciona em polyline clamped).
  - SEs: 83 + 10 planejadas (16 KB), via `makePointsLayer` (agora
    exportada de datageoLogistica.js com `category` parametrizável);
    planejadas maiores, âmbar, com ano previsto no label.
- Encoding: os raw EPE têm acentos corretos (0xE1 = á em "SE Andirá
  Leste"); o `�` no console é só o Git Bash — checar bytes antes de
  "consertar" encoding que não está quebrado.

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
