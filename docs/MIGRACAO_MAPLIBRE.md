# Migração do Cesium para o MapLibre

O app deixou o CesiumJS e desenha com o **MapLibre GL JS 6.7**. A interface
continua a mesma (index.html, style.css, ui.js, manager.js, sharelink.js…);
o que mudou é o motor por baixo. Nada no grafo do app importa `cesium`,
`cesium-wind-layer` ou `vite-plugin-cesium`
(`node scripts/check-maplibre-no-cesium.mjs src/main.js`).

## Peças (src/maplibre/)

- `engine.js` — **o motor**. Substitui o `Cesium.Viewer`: todo módulo que
  recebia `viewer` recebe `engine` (e `window.__godsEyeView.viewer` é o mesmo
  objeto que `.engine`). Câmera em semântica Cesium — posição da câmera
  lat/lon/alt (m), heading (graus, 0 = norte), pitch (graus, −90 = nadir) —
  com `getCameraView()`, `setCameraView()`, `flyToCamera()`, `flyToTarget()`,
  `flyToBounds()`; projeção para a tela (`project`/`unproject`), `pick`,
  acompanhamento de alvo (`track`, `trackedTarget`, evento `trackedchange`),
  mapa base, globo/2D, relevo e eventos (`camerachange`, `moveend`, `render`,
  `click`…). A API está documentada no cabeçalho do arquivo; o mapa MapLibre
  é `engine.map` (use com parcimônia).
- `cameraMath.js` — conversão entre a câmera Cesium (posição + orientação) e
  a vista do MapLibre (centro, zoom, bearing, pitch).
- `basemaps.js` — mapas base sem chave: **Satélite** (Esri World Imagery +
  rótulos "Boundaries and Places"), **OSM** raster e **OSM vetorial**
  (OpenFreeMap); fontes dos rótulos (glyphs) do OpenFreeMap.
- `kit.js` — contrato das camadas desenhadas no MapLibre (`defineLayer`) e
  utilitários (`point`, `fc`, `esc`, `row`, `zoomForHeight`, `LABEL_PAINT`…).
- `layerHost.js` — anfitrião único: adiciona fontes/layers de estilo em faixas
  verticais (preenchimento < linhas < pontos < rótulos), liga/desliga a
  visibilidade e atende hover (tooltip `#dg-tooltip`, feature-state) e clique
  de todas as camadas.
- `managerAdapter.js` — liga uma definição de camada ao `DataLayerManager`
  (painel, estados, "há X min", erro/nova tentativa, chips, legenda, estado
  salvo, tokens de link). `toManagerModule(def, host)` para as camadas
  registradas no boot; `lazyManagerModule(def, extraApi)` para as camadas
  exportadas como singleton (as do GEV), acrescentando a API pública que
  ui.js/voz/detecção usam.
- `layers/*.js` — as camadas DataGeo e de contexto (terremotos, datacenters,
  barragens, cabos submarinos, focos de calor) no contrato do kit;
  `layers/index.js` fixa a ordem do painel.
- `slicedLines.js` — linhas fatiadas em células por zoom (estradas,
  distribuição…); `gridImage.js` — grades raster (clima);
  `windParticles.js` — partículas de vento (substitui o `cesium-wind-layer`);
  `postProcess.js` — estilos de tela (CRT, NVG, FLIR, bloom, sharpen) num
  canvas WebGL2 sobreposto, com os mesmos shaders de `src/styles/`.

As camadas "vivas" maiores continuam em `src/data/<camada>.js` com a interface
do manager (voos, militares, satélites, navios, CCTV, rádio, tráfego,
bikeshare, lançamentos) e desenham no MapLibre por fontes GeoJSON próprias.

## Regras

1. Nada importa `cesium`, `cesium-wind-layer` ou `vite-plugin-cesium`.
   `node scripts/check-maplibre-no-cesium.mjs src/main.js` percorre o grafo a
   partir do boot e aponta quem ainda chega ao Cesium.
2. Camadas desligadas em produção (dependem de proxy do dev-server) continuam
   registradas **só no dev** (`layerAvailableInBuild` em main.js), desenhadas
   no MapLibre; no build estático entram os stubs de `src/prodStubs/`.
3. A API pública de cada módulo (o que ui.js, voz, detecção e cenas chamam)
   continua com os mesmos nomes; quando a semântica era 3D-only (modelo 3D,
   cockpit preso ao terreno), a função existe e degrada para o equivalente 2D,
   documentando a diferença no cabeçalho do módulo.
4. Links compartilhados antigos (`#v=2&lat=…&alt=…&l=…`) continuam abrindo:
   o formato não mudou e a câmera é convertida por `getCameraView` /
   `setCameraView`. Ids de mapa base da era Cesium (`photoreal`,
   `bing-aerial`, `bing-labels`) caem no Satélite (`normalizeStackId`).
5. Posições públicas deixaram de ser `Cesium.Cartesian3`: são o ponto neutro
   de `src/data/geoPoint.js` (`{lon, lat, height, x, y, z}`) ou `{lon, lat}`.
6. Testes: funções puras mantêm seus testes; testes que só exercitavam a
   renderização Cesium foram reescritos para o MapLibre ou removidos com
   justificativa. Harnesses de QA: `scripts/lib/qaBrowser.mjs` (motor, câmera,
   `?semlogin&welcome=0`); os aposentados estão em `scripts/APOSENTADOS.md`.

## O que degradou (3D → 2D)

- **Sem Google Photorealistic 3D Tiles e sem Bing/Cesium ion.** O mapa base é
  Satélite (Esri), OSM ou OSM vetorial; o relevo 3D é opcional (tiles
  Terrarium Mapzen/AWS, chip "Relevo"), e há globo ou mapa plano 2D.
- **Aeronaves e navios sempre como ícone** rotacionado pelo rumo; os modelos
  glTF (frota e alvo), o "encaixe no solo" (groundSnap / piso da malha) e a
  oclusão pelo horizonte do elipsoide não existem. As opções de modelos 3D
  continuam aceitas no link e em `getParams`/`setParams`, sem efeito no desenho.
- **Cockpit = câmera de perseguição** atrás do alvo, no rumo dele
  (`cockpitChaseMapView`), com o HUD e a faixa de briefing; não há cabine
  presa ao terreno 3D.
- **Satélites no ponto subsatélite**: círculo no chão e o traço da órbita
  projetado; a altitude real fica no tooltip, no cartão e nas APIs.
- **CCTV com viewshed no chão**: o frustum 3D e o volume viram o polígono
  onde o cone encontra o solo (`cctvViewshed.groundFootprint`); o quadro ao
  vivo é um cartão "monitor" no fim do eixo; o gizmo de calibração virou dois
  marcadores arrastáveis (base e mira); sem sonda de obstrução contra a malha.
- **Altitude do HUD sem geoide**: o MapLibre dá a altura da câmera acima do
  nível do mar; o HUD a mostra como está (o build Cesium aplicava a ondulação
  EGM96).
- **Anotações de voz no chão** (sem drapeado sobre prédios 3D); rotas e
  voos de rota continuam, com a câmera em semântica Cesium.
- **Créditos**: a linha `#cesium-credits` deu lugar ao `AttributionControl`
  do MapLibre e ao controle "Data attribution" (`src/data/dataCredits.js`),
  ambos dentro do contêiner do mapa (`#map`).
- **Rádio**: o globo do MapLibre esconde o outro hemisfério sozinho; a
  recentralização do disco da Terra no "keyhole" não se aplica.
- **Tráfego**: pontos no plano do mapa (sem altura de terreno); a
  instrumentação de tempo ligada ao agendamento do Cesium saiu.

## Como adicionar uma camada nova (contrato kit.js)

1. Crie (ou use) um arquivo em `src/maplibre/layers/` e declare a camada com
   `defineLayer`:

   ```js
   import { defineLayer, EMPTY_FC, fc, point, row } from '../kit.js';

   export const minhaCamada = defineLayer({
     id: 'datageo-minha-camada',        // id estável: vai para o painel e o link
     name: 'Minha camada',
     category: 'Infraestrutura',
     icon: '📍',
     source: 'Fonte dos dados',
     sources: { 'dg-minha': { type: 'geojson', data: EMPTY_FC } },   // ids sempre com `dg-`
     layers: [{ id: 'dg-minha-pt', type: 'circle', source: 'dg-minha',
       paint: { 'circle-radius': 5, 'circle-color': '#22e6f0' } }],
     async load(ctx) {                  // busca e desenha; devolve a contagem do painel
       const rows = await (await fetch('/data/minha.json')).json();
       ctx.setData('dg-minha', fc(rows.map((r) => point(r.lon, r.lat, r)).filter(Boolean)));
       return rows.length;
     },
     refreshMs: 0,                      // >0 para recarregar enquanto ligada
     interactive: ['dg-minha-pt'],      // layers com hover/clique
     tooltip: (p) => `<strong>${p.nome}</strong>${row('Município', p.municipio)}`,
   });
   ```

   Opcionais: `onEnable`/`onDisable` (camadas dinâmicas), `hoverState`,
   `click`, `rowControls`/`onChip` (chips e legenda na linha do painel),
   `focusOn` (município em foco), `analystRecords` (voz). Tetos de escala do
   app Cesium (altura da câmera) viram `minzoom` com `zoomForHeight(metros)`.
   Nada importado pela camada pode chegar ao `cesium`.
2. Exporte a definição no array default do arquivo e ponha o id em
   `LAYER_ORDER` (`src/maplibre/layers/index.js`) na posição do painel.
3. Registre o estado da camada em `LAYER_STATE_REGISTRY`
   (`src/data/layerState.js`: token do link e disposição) — o
   `finalizeRegistrations` do manager exige correspondência 1:1 com o que
   `main.js` registrou. Camadas `datageo-*` são registradas automaticamente
   pelo laço de `main.js`; as demais precisam de um `dataManager.register`.
4. Credite a fonte em `DATA_SOURCES.md` e em `DATA_CREDITS`
   (`src/data/dataCredits.js`).
5. Teste as funções puras com `node --test` e, no navegador, com um harness
   baseado em `scripts/lib/qaBrowser.mjs` (veja `scripts/qa-distribuicao.mjs`
   ou `scripts/qa-torres.mjs` como modelo).
