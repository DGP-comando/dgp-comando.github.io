# Changelog

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased] — 2026-09-11

### Added

- A ficha municipal passa a mostrar o **VBP por hectare** ao lado da tendência
  de valor: `VBP/ha: R$ 3.399/ha ▲ +14,2% 2024→2025 · 1.510 km²`. O denominador
  é a **área total do município** (IBGE, Censo 2022), e não a área plantada,
  porque metade do VBP do Paraná vem de criações que não declaram área nenhuma
  (avicultura, bovinocultura, suinocultura, pesca) — dividir o VBP total por
  área plantada poria frango e boi sobre hectare de lavoura. Como a área não
  muda entre os dois anos, o percentual é por construção igual ao do valor; o
  que o indicador acrescenta é o **nível**, que é o que permite comparar
  municípios de tamanhos diferentes (Curitiba fica em R$ 297/ha, municípios
  agrícolas intensivos passam de R$ 50 mil/ha).
- `municipios-info.json` ganha `vbpHa` e `areaKm2` para os 399 municípios.

- Nova camada **Precipitação** (classe Clima), irmã da camada de Ventos: as
  duas leem a MESMA grade Open-Meteo (22×15 sobre o Paraná, ~33 km, 30 min) na
  MESMA requisição, então a chuva não custa nenhum acesso a mais que o vento já
  pagava. O campo é desenhado como um manto contínuo por baixo dos riscos de
  vento, com escala violeta→fúcsia escolhida para não colidir com o ciano das
  partículas — inclusive sob daltonismo, que é onde as escalas claras falham.
  Grade seca não pinta nada, e a linha do painel diz "sem chuva" para distinguir
  isso de falha de carregamento. A legenda por classe de intensidade
  (chuvisco/fraca/moderada/forte/muito forte, convenção horária WMO/INMET) vai
  na própria linha do painel.

- A busca da barra LOCALIZAÇÃO agora resolve os 399 municípios do Paraná
  localmente, antes de chamar o geocoder. Digitar parte do nome abre uma lista
  de sugestões (setas ↑/↓, Enter, Esc, clique), tolerante a acento, caixa e
  conectivo — "foz do iguacu" encontra "Foz do Iguaçu" e "sao jorge do oeste"
  encontra "São Jorge d'Oeste". Um código IBGE de 7 dígitos também busca.
- Escolher um município enquadra a câmera na divisa dele e abre a ficha
  municipal completa (IRTC, SEAB/DERAL, IBGE, SINESP, InfoDengue e o resto),
  que antes só abria com um clique no polígono. O que torna isso possível é o
  código IBGE que a busca local devolve: o geocoder devolvia um ponto sem
  identidade e por isso nunca conseguiu abrir a ficha certa.

### Changed

- A camada **Municípios do Paraná** passa a ser o piso da sala de situação:
  entra ATIVA em todo boot, venha o estado de primeira visita, do
  `localStorage` ou de um share link. O operador continua livre para
  desligá-la durante a sessão — o toggle funciona e o desligamento é gravado
  com honestidade no estado durável e no link gerado; apenas o próximo boot
  volta a ligá-la.
- A caixa de busca passou a ser escrita em português ("Buscar município ou
  local...").

## [Unreleased] — 2026-08-24

### Added

- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
