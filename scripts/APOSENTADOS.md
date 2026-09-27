# Scripts de QA aposentados na troca Cesium → MapLibre

O app passou a desenhar com o MapLibre GL JS (ver `docs/MIGRACAO_MAPLIBRE.md`).
Os harnesses abaixo verificavam comportamento que só existia no motor Cesium
(malha 3D fotorrealista, modelos glTF, datum vertical, loop de render do
Cesium) e foram apagados. Estão no histórico do git (`git log -- scripts/<nome>`)
caso alguma ideia precise ser reaproveitada.

| Script | O que verificava | Por que saiu |
|---|---|---|
| `qa-floor-hold.mjs` | Contato no solo segurando o "piso" da malha 3D renderizada durante queda do proxy de alturas (`/api/terrain/heights`). | Não há malha 3D: no MapLibre as aeronaves são desenhadas no plano do mapa; não existe piso a segurar. |
| `qa-floor-verify.mjs` | Âncora visível de cada contato contra a malha renderizada (`scene.sampleHeight`) no aeroporto de Austin. | Mesmo motivo: sem malha e sem altura de desenho. |
| `qa-floorhold-mutations.mjs` | Mutações nos pinos do floor-hold (flights/groundFloor/renderAltitude) para provar que os testes pegavam cada defeito. | O floor-hold saiu da camada de voos com o Cesium; os pinos que ele reforçava não descrevem mais o desenho. |
| `qa-floorhold-probe-cost.mjs` | Custo das sondas de células vizinhas do floor-hold. | Mesmo motivo (medição de uma decisão de projeto do piso 3D). |
| `qa-floorhold-staircase.mjs` | Forma da transição (flutuar/afundar em degraus) de um contato no solo enquanto as células de altura chegam; importava `cesium` direto. | Mesmo motivo. |
| `qa-height-datum.mjs` | Alturas/datum vertical (geoide, elipsoide, provedor de terreno) lidas de entidades Cesium vivas. | Não há datum vertical no desenho 2D; o HUD mostra altitude sem geoide. |
| `shot-sink.mjs` | Servidor que gravava capturas do canvas Cesium com GPU real para o `qa-height-datum`. | Só servia ao `qa-height-datum`. |
| `qa-view-target-prewarm.mjs` | Crash de `Cartographic.fromCartesian` no prewarm do alvo de visada sobre o céu vazio (`scene.pickPosition`). | O prewarm e o `pickPosition` do Cesium não existem no motor MapLibre. |
| `qa-l9-matrix.mjs` | Matriz L9 de release (portões de repo, feeds, app e a frota de harnesses) com o piso Google 3D, créditos Cesium e modelos 3D. | Amarrado ao build Cesium (créditos `#cesium-credits`, tiles 3D, harnesses aposentados). Removido junto: `src/qaL9MatrixVerdicts.test.mjs`, que testava o classificador de veredictos desse script. |
| `qa-cockpit-plates.mjs` | Placas de rótulo do cockpit contra o céu com câmera abaixo do elipsoide (JFK). | O cockpit virou câmera de perseguição sem céu 3D nem câmera sub-elipsoide. |
| `qa-heading-b3.mjs` | Rumo exibido derivado da `modelMatrix` do `Cesium.Model` rastreado em curva (harness descartável do lote 3). | Sem modelo 3D; o rumo exibido segue coberto pelos testes de unidade (`motionModel`, `flights`). |
| `qa-sprites-b5.mjs` | Data-URI do billboard por classe e `Cesium.Model.scale` (harness descartável do lote 5). | Sem billboards/modelos Cesium; o ícone por classe é propriedade da feição (`img`), coberto por `qa-enrich-ambient.mjs` e pelos testes de `flights`. |
| `qa-vessel-datum.mjs` | Billboards de navios sem teste de profundidade e ancorados na superfície do mar (banda EGM96). | Sem profundidade nem datum no mapa 2D. |
| `qa-focus-evidence.mjs` | Evidência visual do desfoque de foco dirigindo o relógio de quadros do Cesium (`scene.render()` manual). | Dependia de controlar o loop de render do Cesium; o desfoque segue coberto pelos testes de `focusDeemphasis`. |
| `qa-label-readability.mjs` | Capturas antes/depois da legibilidade de rótulos sobre o chão fotorrealista e no horizonte do cockpit. | Evidência de uma mudança já encerrada, presa ao imageamento Google 3D e às poses do cockpit 3D. |
| `qa-overlay-baseline.mjs` | Linha de base "Phase 0" do world-overlay do Cesium (custo por cena). | Media a implementação Cesium; no MapLibre os rótulos das camadas são layers `symbol` nativos. |
| `qa-cables-render-probe.mjs` | Custo de `viewer.render()` com os cabos ligados/desligados. | Media o render do Cesium; `qa-cables-overlay.mjs` (portado) mede a cadência de quadros do MapLibre. |
| `qa-traffic-baseline.mjs` | Segmentos de User Timing da cadeia causal do tráfego (`?trafficDebug=1`). | A instrumentação de tempo ligada ao agendamento do Cesium saiu de `src/data/traffic.js` (`getTrafficTimingDiagnostics()` ficou inerte). |

Também saíram `tools/cesium-render.html` e `tools/cesium-render.mjs`
(renderização CesiumJS + Google 3D headless), ver `tools/README.md`.

## Testes removidos junto

- `src/qaL9MatrixVerdicts.test.mjs` — importava `scripts/qa-l9-matrix.mjs`.
- `src/creditAttribution.test.mjs` — fixava a geometria (cascata CSS) do
  `#cesium-credits`, a linha de créditos do Cesium, contra o dock e o trilho
  direito. O elemento não existe no MapLibre (a atribuição é o
  `AttributionControl` do mapa + o controle "Data attribution" de
  `src/data/dataCredits.js`, ambos dentro do contêiner `#map`); as regras
  mortas de `#cesium-credits` saíram do `style.css`.

## Portados (continuam valendo)

Portados para o motor (`window.__godsEyeView.engine`, `scripts/lib/qaBrowser.mjs`):
`qa-map-source-tray`, `track-regression`, `qa-perf`, `qa-labels`, `qa-estradas`,
`qa-estradas-conveniadas`, `qa-distribuicao`, `qa-agroindustrias`, `qa-car`,
`qa-torres`, `qa-radios`, `qa-firms`, `qa-cables-overlay`, `qa-cables-shot`,
`qa-attribution-b12`, `qa-voice-routing`, `qa-voice-wav`, `qa-flyroute-cinema`,
`qa-flyroute-mutations`, `qa-cctv-v2`, `qa-radio`, `qa-traffic`,
`qa-traffic-jamviz-ab`, `qa-traffic-preset-ab`, `qa-failstate-b10`,
`qa-enrich-ambient`, `qa-vessel-cards`, `qa-cockpit-utility`.
`qa-firms`, `qa-cctv-v2`, `qa-radio` e `track-regression` foram reescritos em
versões menores: as verificações que dependiam de entidades/primitivas do
Cesium deram lugar às equivalentes do MapLibre (fontes GeoJSON, layers de
estilo, `engine.trackedTarget`), e cada cabeçalho diz o que ficou de fora.
