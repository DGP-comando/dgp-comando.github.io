# DataGeo Command — Plano de Fusão (God's Eye View × c2-parana)

> Criado em 2026-08-26. Este repo nasce da fusão de dois projetos:
> **God's Eye View** (bilawalsidhu, MIT) fornece a interface — globo CesiumJS,
> HUD tático, estilos de sensor GLSL, tracking, share links, gerenciador de
> camadas — e o **c2-parana / DataGeo PR** fornece a infraestrutura de dados:
> 18 pipelines em Supabase Edge Functions + pg_cron cobrindo os 399
> municípios do Paraná.
>
> Produto-alvo: **"DataGeo PR — Sala de Situação"**, a tela principal 3D do
> DataGeo, herdeira direta do pivô C4ISR original do c2.

---

## 1. Decisão arquitetural central

**O front lê o Supabase direto do browser, sem proxy.** Verificado em
2026-08-26: as 12 tabelas de dados do c2 (fire_spots, climate_data,
river_levels, cemaden_alerts, irtc_scores, dengue_data, air_quality,
anomalies, incidents, news_items, data_cache, situational_reports) respondem
HTTP 200 com a anon key (RLS anon-read, migration 008 do c2). A anon key é
client-exposed por design (mesma usada no console React).

Consequências:
- O GEV original dependia de ~20 proxies no dev-server Vite (chaves
  server-side) e por isso não era deployável estático. As camadas DataGeo
  não têm essa dependência: **o produto pode ir para GitHub Pages /
  Cloudflare Pages** com as camadas DataGeo + camadas keyless nativas.
- As camadas nativas do GEV que usam proxy (flights/OpenSky, satellites com
  cache de TLE, radio, launches) continuam funcionando em dev; em deploy
  estático, flights degrada para adsb.lol keyless ou fica off. Documentado
  na seção 6.
- O frescor dos dados é responsabilidade dos pipelines pg_cron do c2 — este
  repo é só apresentação. `etl_freshness`/`etl_stale` seguem sendo o monitor.

## 2. O que vem de cada lado

| Origem | Componentes |
|---|---|
| **GEV (UI)** | CesiumJS + Vite vanilla; HUD tático (hud.js); estilos GLSL 1-7 (CRT/NVG/FLIR/Noir); detection overlay; click-to-track + trilhas; label arbiter; share links; scene director; cockpit; painel Data Layers; stack de mapas |
| **Fork local (já feito)** | Stack `esri` tokenless (Esri World Imagery + labels — receita Serra do Mar); boot keyless (fallback sem Google 3D); dev hooks `__gevViewer`/`__gevDataManager`/`__gevMapStack`; ponte `/api/firms→Supabase` (substituída aqui por leitura client-side) |
| **c2 (dados)** | Supabase `fialxjcsgywvvuxjxcly`: 18 pipelines Edge+pg_cron; tabelas de domínio; caches (`data_cache`); `pr_centroids` (399 municípios); views de monitoração |
| **c2 (futuro)** | Auth/roles (profiles), paywall Stripe, public-api — Fase 3 |

## 3. Mapa pipeline → camada

Tokens do LAYER_STATE_REGISTRY entre parênteses (livres no GEV: h,j,k,l,n,o,p,v,y,z).

| Camada nova | Tabela/cache | Render | Status |
|---|---|---|---|
| `local-firms` (w, já existia) | `fire_spots` | heatmap FIRMS nativo do GEV, fetch client-side | **Fase 1 ✅** |
| `datageo-clima` (k) | `climate_data` (última leitura por estação) | pontos com T °C / UR %, cor por faixa térmica | **Fase 1 ✅** |
| `datageo-rios` (h) | `river_levels` | discos nas 8 estações, cor por alert_level | **Fase 1 ✅** |
| `datageo-cemaden` (n) | `cemaden_alerts` ativos | marcadores por severidade | **Fase 1 ✅** |
| `datageo-irtc` (z) | `irtc_scores` × centróides | disco por município, cor por risk_level, raio ∝ score | **Fase 1 ✅** |
| `datageo-dengue` (j) | `dengue_data` (última semana) × centróides | disco por alert_level InfoDengue 1-4 | **Fase 1 ✅** |
| `datageo-ar` (y) | `air_quality` | AQI nas 12 cidades | **Fase 2 ✅** |
| `datageo-incidentes` (o) | `incidents` (OODA) | ícone por tipo + severity | **Fase 2 ✅** (tabela hoje vazia) |
| `datageo-anomalias` (p) | `anomalies` | marcador z-score | **Fase 2 ✅** |
| `datageo-infohidro` (l) | `data_cache:infohidro_estacoes_pr` | 1.312 estações de telemetria | **Fase 2 ✅** |
| ticker de notícias | `news_items` | faixa no rodapé (`datageoTicker.js`) | **Fase 2 ✅** |
| briefing diário | `situational_reports` | card colapsável (`datageoBriefing.js`) | **Fase 2 ✅** |
| KPIs agro/leitos | caches vbp/comex/credito/leitos | cards no HUD | Fase 3 |
| voz/analista | getAnalystRecords das camadas DataGeo | "quantos municípios em risco alto?" | Fase 3 |

Camadas nativas do GEV mantidas: flights, military, satellites, earthquakes,
radio, launches, dams/datacenters/cables. Removíveis por configuração se o
produto quiser foco 100 % Paraná.

## 4. Convenções de código

- Cada camada DataGeo segue o contrato do GEV (`id, name, icon, source,
  updateInterval, init/enable/disable/update/destroy/getStats,
  getAnalystRecords`), com `earthquakes.js` como referência de implementação
  (entidades estáticas, sem CallbackProperty por frame — ver o cabeçalho de
  performance daquele módulo).
- Acesso a dados só via `src/data/datageoClient.js` (PostgREST + anon key via
  `VITE_DATAGEO_SUPABASE_URL`/`VITE_DATAGEO_ANON_KEY`, com default embutido —
  a anon key é pública por design).
- Municípios sem lat/lon (dengue, IRTC) ancoram em `src/data/prCentroids.js`
  (mesma matemática do ETL Python; gerado do geojson do c2).
- UTF-8 sempre; cores seguem a semântica já usada no console 2D do c2
  (risk_level baixo→verde ... crítico→vermelho; InfoDengue 1-4 verde→vermelho).

## 5. Fases

- **Fase 1 (este commit):** repo + branding + boot keyless sem exigência de
  chave Google + datageoClient + 5 camadas novas + fires client-side +
  registro no painel/share links. Critério: globo Esri com as camadas
  DataGeo ligadas e dados reais do Supabase, verificado em browser.
- **Fase 2 (2026-08-26 ✅):** camadas restantes (ar, anomalias, incidentes,
  infohidro), ticker de notícias, briefing diário, presets de missão no
  first-run (Defesa Civil / Epidemiológico / Agroambiental) e build estático
  validado (`npm run build` + `vite preview`, zero erros de console).
  Decisão de proxies em estático: camadas GEV dependentes de dev-server
  (flights/satellites/radio/launches/traffic/cctv/vessels) ficam default OFF
  e degradam graceful (o painel da camada mostra o erro); portá-las para
  Edge Functions do Supabase é opção da Fase 3. Publicação em Pages: pronta
  (dist/), aguardando decisão de hospedagem/domínio.
- **Fase 3:** auth Supabase (login do console c2), gating por plano
  (free/pro), integração com a public-api, voz (opcional, exige backend p/
  token OpenAI), embed no console React (`app.datageoparana.com.br/comando`).

## 5b. Mapa das páginas do console c2 → destino na fusão

O produto passa a ter DUAS superfícies sobre o mesmo Supabase, e cada página
do console React tem um destino explícito (isto conclui a consolidação
26→~10 páginas que o PIVOT.md do c2 já pedia):

**Absorvidas pela Sala de Situação (o globo JÁ cobre ou cobre na Fase 3):**

| Página do c2 | Destino no GEV | Status |
|---|---|---|
| MapPage (COP Leaflet 2D) | É o globo inteiro — a Sala de Situação substitui e supera | ✅ Fases 1-2 |
| ClimaPage | camada `datageo-clima` | ✅ Fase 1 |
| AmbientePage (FIRMS/AQI/rios) | camadas `local-firms` + `datageo-ar` + `datageo-rios` | ✅ Fases 1-2 |
| SaudePage (dengue) | camada `datageo-dengue`; leitos SUS → KPI no HUD | ✅ / Fase 3 |
| AguaPage (InfoHidro) | camada `datageo-infohidro`; reservatórios SAIC → card no HUD | ✅ / Fase 3 |
| NoticiasPage | ticker `datageoTicker.js` | ✅ Fase 2 |
| RelatoriosPage (situacional) | briefing `datageoBriefing.js` | ✅ Fase 2 |
| ReconhecimentoPage (perfil municipal, 8 indicadores) | **card de clique no município** — o candidato natural para o sistema de cards/contextStore do GEV | Fase 3 |
| AgroPage (VBP/Comex/emprego/crédito) | KPIs no HUD + coropléticos VBP/crédito por município (camadas novas em potencial) | Fase 3 |
| GetecPage | card por município (dado segue vindo do Actions) | Fase 3 |
| Dashboard (KPIs executivos) | os KPIs migram para o HUD; a página 2D pode aposentar | Fase 3 |

**Ficam no console React (CRUD, conta e análise tabular — não fazem sentido no globo):**

| Página | Motivo |
|---|---|
| Login/Register/ForgotPassword/ResetPassword/AuthCallback | Auth Supabase; o GEV consome a MESMA sessão na Fase 3 |
| PricingPage/CheckoutSuccess/CheckoutCancel | Billing Stripe |
| PrivacyPage/TermsPage | Legal |
| NotificationPrefsPage | preferências por usuário |
| AlertasPage (centro de alertas read/unread) | interação por usuário; a parte espacial já está no globo (cemaden + briefing) |
| IncidentesPage/IncidentDetailPage/ComandoPage | o CRUD OODA (criar, atribuir, playbook, audit) fica no console; a VISUALIZAÇÃO já está na camada `datageo-incidentes` — clique no incidente do globo abre o detail do console (deep link) |
| TendenciasPage | séries temporais/Recharts leem melhor em 2D; candidata a painel lateral no futuro |
| LegislativoPage | não-espacial; pode virar segunda faixa do ticker |

**Integração entre as superfícies (Fase 3):** auth compartilhada (mesmo
Supabase Auth), botão "Sala de Situação 3D" no console e botão "Console" no
HUD do GEV, deep links do globo para o console (incidente → IncidentDetail,
município → Reconhecimento) e embed em `app.datageoparana.com.br/comando`.

## 6. Limitações e pontos de atenção

- **Proxies do GEV em deploy estático:** flights/satellites/radio/launches
  usam middlewares do dev-server. Em produção estática: desligar por padrão
  ou portar os proxies para Edge Functions do próprio Supabase (padrão já
  dominado no c2). Decidir na Fase 2.
- **RLS anon-read em `notifications`/`incidents`** (herdado da migration 008
  do c2): funcional para a Sala de Situação, mas merece revisão LGPD antes
  de divulgar o produto (notifications carrega user_id). Item para o c2.
- **Licenças:** GEV é MIT (manter LICENSE + créditos); tiles Esri exigem
  atribuição (mantida no credit do stack); dados DataGeo têm fontes citadas
  em DATA_SOURCES.md do c2.
- **maritimo** segue morto (conta AISStream) — camada AIS nativa fica off.

## 7. Verificação (feito na Fase 1)

- `deno`/type-check não se aplica (JS vanilla); validação = boot no browser.
- Checklist: globo Esri ✅ · fires do Supabase ✅ · 5 camadas novas com
  contagem > 0 (exceto cemaden quando não há alerta ativo — estado válido) ✅
  · painel Data Layers listando as camadas ✅ · screenshot arquivado.
