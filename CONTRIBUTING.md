# Contributing to God's Eye View

Thanks for being here. God's Eye View is an open foundation for live spatial intelligence in the browser, and it gets better when more people run it, break it, and extend it.

## Getting set up

Use Node.js 24.14.x or 26.x (also enforced by `package.json`).

```bash
git clone https://github.com/bilawalsidhu/gods-eye-view.git
cd gods-eye-view
nvm install 24.14.0
nvm use 24.14.0
npm install
./scripts/dev-fresh.sh        # or: npm run dev
```

The map needs **no API key** — it runs on MapLibre GL JS with keyless base maps (see the [README](README.md#-api-keys)); an optional Google Maps key only adds free-text geocoding. Most data layers work with no accounts at all. On macOS the launcher pulls keys from the Keychain; on any platform you can pass them as env vars or use a `.env` (copy `.env.example`).

Open `http://localhost:4173/?semlogin` (the dev server skips the DataGeo login with `?semlogin`). Before sending a PR run `npm run build`, `npm test`, and `npm run test:track` (dev server must be up; `QA_BASE_URL` points it at another port) — **all three must stay green.** `node scripts/check-maplibre-no-cesium.mjs src/main.js` must also report that nothing reaches the old `cesium` package.

## Good first contributions

The highest-leverage places to jump in:

- **🌆 Add a CCTV source pack.** Austin is the reference camera source. Adding another city means a clean public camera catalog with coordinates, attribution, and server-registered frame URLs (the proxy only fetches registered URLs — never client-supplied ones, see [SECURITY.md](SECURITY.md)). City packs are the best first lane.
- **🛰️ Add or improve a data layer.** New map layers are declared with the MapLibre layer contract in `src/maplibre/kit.js` (`defineLayer`: GeoJSON sources + style layers + `load`/tooltip/click) and registered through `src/maplibre/managerAdapter.js`; see `docs/MIGRACAO_MAPLIBRE.md` and the layers in `src/maplibre/layers/` as templates. Larger live layers keep the manager interface (`init/enable/disable/update/destroy/getStats`, optional `getDetectableObjects`) in `src/data/<layer>.js`.
- **🎙️ Extend voice control.** Voice tools are declared server-side (`GEV_REALTIME_TOOLS` in `vite.config.js`) and executed client-side (`src/voice/gevActions.js`). Keep the tool surface tight and the responses honest (confirm only what actually happened).
- **🎨 Add a visual style.** Styles are GLSL post-process shaders in `src/styles/`.
- **🐛 Fix bugs / improve the first-run experience.** See [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).

## Architecture in one minute

- **No framework.** Vanilla JS + [MapLibre GL JS](https://maplibre.org/) + [Vite](https://vitejs.dev/). The map engine facade is `src/maplibre/engine.js` (camera, flights, projection, picking, tracking, base map, globe, relief).
- **UI lives in `src/ui.js`** (panels, HUD, styles, the control facade). **Layer logic lives in `src/data/<layer>.js`.** Keep them separate.
- **Secrets stay server-side.** Anything needing a private key goes through a Vite proxy in `vite.config.js`. The browser only ever sees the optional Google Maps key (which you restrict) and ephemeral tokens.
- `docs/MIGRACAO_MAPLIBRE.md` describes the engine, the layer contract and what degraded from 3D; `docs/CURRENT-STATE.md` is the runtime reference (its older sections describe the Cesium build).

## Coding style

- ES modules, **2-space indent, single quotes, semicolons.**
- JSDoc on exported/public functions.
- Match the surrounding code — comment density, naming, and idiom.
- Prefer small, reviewable commits. Conventional-commit-style prefixes (`feat:`, `fix:`, `perf:`, `docs:`) are appreciated but not required.

## Pull requests

1. Branch off `main`.
2. Keep `npm run build`, `npm test`, and `npm run test:track` green and avoid new console errors.
3. If you change runtime behavior, update `docs/CURRENT-STATE.md` and `CHANGELOG.md` in the same PR.
4. If you add or change a data source, update [DATA_SOURCES.md](DATA_SOURCES.md) with its license and attribution. **Don't add data you don't have the right to redistribute** — fetch it at runtime instead.
5. Describe what you changed and how you verified it (screenshots welcome for anything visual).

## Ground rules

- This is a tool for **public** data. Don't add scraping of sources whose terms forbid it, private/paywalled datasets, or anything that misrepresents public-data inference as authoritative intelligence.
- Be decent to each other. Assume good faith, keep it constructive.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
