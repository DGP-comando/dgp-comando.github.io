# KNOWN ISSUES

Updated: September 26, 2026 (map engine moved from CesiumJS to MapLibre GL JS —
see `docs/MIGRACAO_MAPLIBRE.md`)

This file tracks active runtime issues only.

This file records current known issues; historical planning material is not part
of the public release.

---

## Open

### Switching the base map leaves the MAPA BASE status on "..."
Status: Open (found by `npm run qa:map-source-tray`, 2026-09-26)

Context:
- `engine.setBasemap()` (`src/maplibre/engine.js`) calls `map.setStyle(style, {transformStyle})`
  and only then subscribes `map.once('style.load')`. With an object style MapLibre fires
  `style.load` synchronously inside `setStyle`, so the promise never resolves: the map does
  switch, but `MapStackController.setStack()` never commits — the status chip stays `...`,
  the active tile does not move and the share link keeps the old `map=`.
- Fix direction: subscribe before calling `setStyle` (or resolve when `map.isStyleLoaded()`
  right after it).

### MAPA BASE tray overflows the viewport at narrow widths
Status: Open (found by `npm run qa:map-source-tray`, 2026-09-26)

Context:
- With the three sources plus the three toggles (Rótulos, Globo/2D, Relevo 3D) the tray grid
  wraps to two columns at ≤620 px and the popover's left edge lands off-screen
  (measured `left: -165px` at 620 px, `-95px` at 480 px).

### HUD place names from Google reverse geocoding never run
Status: Open (2026-09-26)

Context:
- `src/basemapLabelContext.js` (and `reverseGeocode` in `src/voice/gevActions.js`) read the key
  only from `window.__GOOGLE_MAPS_API_KEY__`, which nothing sets any more; the forward geocoders
  also fall back to `import.meta.env.GOOGLE_MAPS_API_KEY`. Even with the key configured, that
  lookup is skipped.

### Street traffic can be slow/uneven when panning across dense city blocks
Status: Open (partially mitigated)

Context:
- Current traffic loader fetches one clamped viewport tile at a time (major pass, then full pass).
- In dense cores, some visible roads can appear late after city jumps or fast pans.
- Zooming into adjacent streets does not always immediately trigger higher-detail coverage for all visible roads.

Current mitigation in runtime:
- Fair per-road dot budget allocation (reduces hard starvation under global `MAX_DOTS` cap).
- Center-shift threshold (reduces stale overlap lock while panning).

Next iteration candidates:
- Prioritize currently visible road segments inside the active viewport before off-center segments.
- Add neighbor prefetch ring for nearby tiles after jump-to-city actions.
- Add adaptive dot cap by frame time (coverage first, density second).
- Promote sync chip from loading indicator to true multi-phase progress.

---

### CCTV panel can appear "missing" after layout refactors
Status: Open (workaround available)

Context:
- Panel positions are persisted in local storage and can restore off-screen after UI changes.

Workaround:
- In browser console:
  - `localStorage.removeItem('godsEyeView.v6.panelPos.cctv-panel');`
  - `localStorage.removeItem('godsEyeView.v6.panelCollapsed.cctv-panel');`
  - `location.reload();`

Related keys (current versions):
- Panel positions: `godsEyeView.v7.panelPos.<panel-id>` (re-versioned 2026-06-10)
- Panel collapsed state: `godsEyeView.v6.panelCollapsed.<panel-id>`
- CCTV calibration: `godsEyeView.cctv.calibration.v2`

---

## Closed / Intentional (for clarity)

### Height-datum residuals
Status: Not applicable since the MapLibre engine (2026-09-26)

- The Cesium build drew grounded aircraft on the rendered 3D mesh and had cold-start
  floor latency and a born-grounded first poll at the geoid. The MapLibre map draws
  every contact on the map plane (no 3D mesh, no vertical datum), so neither residual
  exists. The oracle `scripts/qa-floor-verify.mjs` was retired (`scripts/APOSENTADOS.md`).

---

### Proxy SSRF and error-surface hardening gaps
Status: Closed as fixed on `main`

Context:
- Proxy middleware previously allowed broader error/internal surface area and looser upstream handling.
- Current `main` includes hardened proxy behavior in `vite.config.js`:
  - CCTV upstream URL no longer accepted from client query params.
  - Error payloads are sanitized.
  - OpenSky cache stores successful responses only.
  - OpenSky token refresh is coalesced.
  - GBFS/CCTV memory growth is bounded.

Validation target:
- `vite.config.js`

---

### NVG vignette edge color bleed
Status: Closed as fixed in current shader composite

Context:
- Earlier builds leaked original scene colors near the NVG tube edge.
- Current composite now masks NVG output with tube falloff before final blend, removing the color edge bleed.

Validation target:
- `src/styles/surveillance.js`

---

### Wildfires layer unavailable / static bundled snapshot
Status: Closed — live FIRMS integration shipped (2026-07-16)

Context:
- Wildfires (NASA FIRMS) were removed from runtime in v0.5.3, returned June 2026 as a
  bundled-snapshot layer (`local-firms`, 2026-05-25 data, ~58 MB in-repo), and were
  converted to **live NASA FIRMS data** on 2026-07-16: the `/api/firms` proxy merges
  three VIIRS NRT sources (trailing 24 h, 30 min cache, serve-stale-on-failure) and the
  bundled snapshot was deleted. Since the MapLibre engine (2026-09) the `local-firms`
  layer reads the DataGeo PR Supabase table `fire_spots` (NASA FIRMS detections ingested
  by the DataGeo ETL), so the app itself needs no FIRMS key; the `/api/firms` proxy is no
  longer on the layer's path.
- Weather radar is still held out of OSS v1 after QA found the previous overlay did not provide reliable visible value.
