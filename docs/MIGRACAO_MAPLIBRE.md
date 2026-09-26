# Migração do Cesium para o MapLibre

O app deixa o CesiumJS e passa a desenhar com o MapLibre GL JS 6.7. A
interface continua a mesma (index.html, style.css, ui.js, manager.js,
sharelink.js…); o que muda é o motor por baixo.

## Peças novas (src/maplibre/)

- `engine.js` — **o motor**. Substitui o `Cesium.Viewer`: todo módulo que
  recebia `viewer` recebe `engine`. Câmera em semântica Cesium (posição da
  câmera lat/lon/alt, heading, pitch −90 = nadir), voos, projeção para a tela,
  pick, acompanhamento de alvo, mapa base, globo, relevo e eventos. A API está
  documentada no cabeçalho do arquivo.
- `kit.js` — contrato das camadas desenhadas no MapLibre (`defineLayer`).
- `layerHost.js` — anfitrião único: adiciona fontes/layers em faixas verticais
  e atende hover (tooltip, feature-state) e clique de todas as camadas.
- `managerAdapter.js` — liga uma definição de camada ao `DataLayerManager`
  original (painel, estados, estado salvo, tokens de link).
  `toManagerModule(def, host)` para as camadas registradas no boot;
  `lazyManagerModule(def, extraApi)` para camadas exportadas como singleton
  (as do GEV), acrescentando a API pública que ui.js/voz/detecção usam.
- `layers/*.js` — as camadas DataGeo e de contexto já portadas.
- `basemaps.js` — Satélite (Esri + rótulos), OSM raster, OSM vetorial.

## Regras

1. Nada importa `cesium`, `cesium-wind-layer` ou `vite-plugin-cesium` ao fim
   da migração. `node scripts/check-maplibre-no-cesium.mjs src/main.js` percorre
   o grafo a partir do boot e aponta quem ainda chega ao Cesium.
2. Camadas desligadas em produção (dependem de proxy do dev-server) continuam
   registradas **só no dev** (`layerAvailableInBuild` em main.js), agora
   desenhadas no MapLibre, para poderem ser ligadas no futuro.
3. A API pública de cada módulo (o que ui.js, voz, detecção e cenas chamam)
   continua existindo com os mesmos nomes; quando a semântica for 3D-only
   (modelo 3D, cockpit preso ao terreno), a função existe e degrada para o
   equivalente 2D, documentando a diferença no cabeçalho.
4. Links compartilhados antigos (`#v=2&lat=…&alt=…&l=…`) continuam abrindo:
   o formato do link não muda; a câmera é convertida por `engine.getCameraView`
   / `setCameraView`.
5. Testes: funções puras mantêm seus testes; testes que só exercitavam a
   renderização Cesium são reescritos para a versão MapLibre ou removidos
   com justificativa no commit.
