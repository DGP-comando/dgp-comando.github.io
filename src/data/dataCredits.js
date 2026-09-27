/**
 * Per-layer data attribution shown in the "Data attribution" lightbox.
 *
 * Legal requirement (see DATA_SOURCES.md, findings H10/H11 in
 * every third-party data layer this app can
 * display carries its own license and required attribution — ODbL (OSM
 * datacenters/dams, adsb.lol, Overpass roads), CC BY-NC-SA (TeleGeography
 * cables), NASA FIRMS, CelesTrak, USGS, City of Austin, GBFS operators, OpenSky.
 * The MIT code license does NOT cover this data.
 *
 * MOTOR: MapLibre. `registerDataCredits(engine)` adds ONE map control next to
 * MapLibre's AttributionControl (bottom-right, inside the map container, so it
 * stays visible in the clean view): a "Data attribution" link that opens a
 * lightbox with these credits plus the base map/terrain attributions of the
 * current style. The lightbox takes its sizing/scrolling rules from style.css
 * (`.dg-credit-lightbox*`) and its base look from the CSS injected once here.
 * Credits never go on the map's own attribution line, so it stays short.
 * Always-present is intentional and reversible: the lightbox is the app's
 * canonical attribution surface and DATA_SOURCES.md is the
 * machine-readable index. Strings are copied verbatim from DATA_SOURCES.md — if
 * you add a data source, add it there AND here.
 */

/**
 * Attribution entries. `html` is the credit markup; keep it minimal and
 * link out where DATA_SOURCES.md provides a canonical URL. Order roughly
 * follows DATA_SOURCES.md (live sources, then bundled snapshots).
 * @type {{ key: string, html: string }[]}
 */
export const DATA_CREDITS = [
  // ── Live sources ────────────────────────────────────────────────
  {
    key: 'opensky',
    html:
      'Flights: OpenSky Network — Schäfer et al., ' +
      '“Bringing Up OpenSky”, IPSN 2014 · ' +
      '<a href="https://opensky-network.org" target="_blank" rel="noopener">opensky-network.org</a> ' +
      '(non-commercial)',
  },
  {
    key: 'adsblol',
    html:
      'Military flights, aircraft traces &amp; bounded regional flight fallback: ' +
      '<a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'aisstream',
    html:
      'Live vessels (AIS): ' +
      '<a href="https://aisstream.io" target="_blank" rel="noopener">AISStream.io</a>',
  },
  {
    key: 'appa-lineup',
    html:
      'Navios em Paranaguá e Antonina: line-up da ' +
      '<a href="https://www.portosdoparana.pr.gov.br/Pagina/Tempo-Real" target="_blank" rel="noopener">Portos do Paraná (APPA)</a>; ' +
      'posição aproximada dos berços e fundeadouros: © colaboradores do ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> (ODbL)',
  },
  {
    key: 'incra-assentamentos',
    html:
      'Assentamentos da reforma agrária: ' +
      '<a href="https://acervofundiario.incra.gov.br/acervo/" target="_blank" rel="noopener">INCRA · Acervo Fundiário (SIPRA)</a>',
  },
  {
    key: 'aneel-bdgd',
    html:
      'Linhas de distribuição (média tensão Copel): ' +
      '<a href="https://dadosabertos-aneel.opendata.arcgis.com/" target="_blank" rel="noopener">ANEEL · Base de Dados Geográfica da Distribuidora (BDGD)</a>, COPEL-DIS 2022-12-31',
  },
  {
    key: 'sicar-car',
    html:
      'Imóveis rurais (CAR, apenas ativos): ' +
      '<a href="https://consultapublica.car.gov.br" target="_blank" rel="noopener">SICAR · Serviço Florestal Brasileiro</a>, ' +
      'WFS público; divisas declaratórias generalizadas a 30 m',
  },
  {
    key: 'radio-browser',
    html:
      'Rádios: comunitárias outorgadas pela <a href="https://sistemas.anatel.gov.br/srd/" target="_blank" rel="noopener">Anatel (SRD)</a>; ' +
      'estações e streams via <a href="https://radio.garden" target="_blank" rel="noopener">radio.garden</a>, ' +
      '<a href="https://www.acheradios.com.br" target="_blank" rel="noopener">Ache Rádios</a>, ' +
      '<a href="https://www.rankeador.com.br" target="_blank" rel="noopener">Rankeador</a> e ' +
      '<a href="https://www.radio-browser.info" target="_blank" rel="noopener">Radio Browser</a>; ' +
      'o áudio vem direto de cada emissora',
  },
  {
    key: 'seab-estradas-conveniadas',
    html:
      'Estradas rurais conveniadas 2026 (preliminar), protocolos 2025 e malha automatizada 2025: ' +
      'SEAB-PR, Secretaria da Agricultura e do Abastecimento',
  },
  {
    key: 'idr-agroindustrias',
    html:
      'Agroindústrias: IDR-Paraná, diagnóstico das agroindústrias 2023 e cadastro do IDR GETEC; ' +
      'frigoríficos e laticínios do SIGSIF/MAPA',
  },
  {
    key: 'idr-regionais',
    html: 'Regionais: IDR-Paraná, mapa municipal das regionais',
  },
  {
    key: 'secid-associacoes',
    html:
      'Associações de municípios: ' +
      '<a href="https://www.secid.pr.gov.br/Categoria-de-Endereco/Associacoes-Regionais-de-Municipios-do-Parana" target="_blank" rel="noopener">SECID-PR, Associações Regionais de Municípios</a>',
  },
  {
    key: 'rotas-turisticas',
    html: 'Rotas turísticas: Rota do Queijo Paranaense e Rota da Uva e do Vinho do Paraná',
  },
  {
    key: 'osm-estradas',
    html:
      'Estradas municipais (urbanas e rurais): ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© colaboradores do OpenStreetMap</a> ' +
      '(ODbL 1.0), extrato Geofabrik da região Sul',
  },
  {
    key: 'mma-cnuc',
    html:
      'Unidades de conservação federais e estaduais: ' +
      '<a href="https://dados.mma.gov.br/dataset/unidadesdeconservacao" target="_blank" rel="noopener">MMA · Cadastro Nacional de Unidades de Conservação (CNUC)</a>, polígonos 2025-08',
  },
  {
    key: 'celestrak',
    html:
      'Satellites (TLEs): CelesTrak ' +
      '(<a href="https://celestrak.org" target="_blank" rel="noopener">celestrak.org</a>), ' +
      'Dr. T.S. Kelso',
  },
  {
    key: 'launch-library-2',
    html:
      'Space mission launch, payload &amp; recovery metadata: ' +
      '<a href="https://ll.thespacedevs.com/docs/" target="_blank" rel="noopener">Launch Library 2 — The Space Devs</a> ' +
      '(API documentation and rate limits)',
  },
  {
    key: 'usgs',
    html: 'Earthquakes: Data courtesy of the U.S. Geological Survey',
  },
  {
    key: 'overpass',
    html:
      'Road geometry (traffic): ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'military-installations-osm',
    html:
      'Mapped installation context: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0; incomplete mapped context)',
  },
  {
    key: 'cockpit-place-osm',
    html:
      'Cockpit place context: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      'via Nominatim (ODbL 1.0)',
  },
  {
    key: 'open-meteo',
    html:
      'Cockpit current conditions + grade estadual de vento e precipitação: ' +
      '<a href="https://open-meteo.com/en/licence" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> ' +
      '(CC BY 4.0)',
  },
  {
    key: 'br-dwgd',
    html:
      'Clima histórico 1961–2022 (camada e ficha municipal): BR-DWGD, Xavier, Scanlon, King &amp; Alves (2022), ' +
      '<a href="https://doi.org/10.1002/joc.7731" target="_blank" rel="noopener">Int. J. Climatol. 42(16)</a> ' +
      '(CC BY 4.0), via <a href="https://gee-community-catalog.org/projects/br_dwgd/" target="_blank" rel="noopener">awesome-gee-community-catalog</a>',
  },
  {
    key: 'google-news-rss',
    html:
      'Cockpit regional headlines: ' +
      '<a href="https://policies.google.com/terms" target="_blank" rel="noopener">Google News RSS</a> ' +
      '(location-matched article links; publisher terms apply)',
  },
  {
    key: 'gdelt',
    html:
      'Cockpit regional headlines: ' +
      '<a href="https://www.gdeltproject.org/about.html" target="_blank" rel="noopener">GDELT Project</a> ' +
      '(location-matched article links; publisher terms apply)',
  },
  {
    key: 'austin-cctv',
    html:
      'CCTV cameras &amp; frames: City of Austin, TX — ' +
      '<a href="https://data.austintexas.gov" target="_blank" rel="noopener">data.austintexas.gov</a>',
  },
  {
    key: 'caltrans-cctv',
    html:
      'CCTV cameras &amp; frames (California): Caltrans — ' +
      '<a href="https://cwwp2.dot.ca.gov/" target="_blank" rel="noopener">cwwp2.dot.ca.gov</a>',
  },
  {
    key: 'tfl-cctv',
    html:
      'CCTV cameras &amp; frames (London): ' +
      '<a href="https://tfl.gov.uk/info-for/open-data-users/" target="_blank" rel="noopener">Powered by TfL Open Data</a>. ' +
      'Contains OS data © Crown copyright and database rights.',
  },
  {
    key: 'gbfs',
    html: 'Bikeshare availability: GBFS operator feeds (e.g. Austin BCycle)',
  },
  {
    key: 'radio-browser',
    html:
      'Internet-radio station directory: ' +
      '<a href="https://www.radio-browser.info/" target="_blank" rel="noopener">Radio Browser</a> ' +
      '(public domain; audio delivered directly by each broadcaster)',
  },
  {
    key: 'reearth-terrain',
    html:
      'Terrain (keyless globe stacks): ' +
      '<a href="https://terrain.reearth.land" target="_blank" rel="noopener">Re:Earth Terrain</a> / ' +
      'Mapterhorn (CC BY 4.0) / EGM2008 (NGA)',
  },
  // ── Bundled snapshots ───────────────────────────────────────────
  {
    key: 'datacenters',
    html:
      'Datacenters: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'dams',
    html:
      'Dams: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0) + Open Infrastructure Map',
  },
  {
    key: 'firms',
    html:
      'Active fires: NASA FIRMS — we acknowledge the use of data and/or imagery ' +
      'from NASA’s Fire Information for Resource Management System ' +
      '(<a href="https://earthdata.nasa.gov/firms" target="_blank" rel="noopener">earthdata.nasa.gov/firms</a>), ' +
      'part of NASA’s Earth Observing System Data and Information System (EOSDIS)',
  },
  {
    key: 'telegeography',
    html:
      'Submarine cables: © TeleGeography — ' +
      '<a href="https://www.submarinecablemap.com" target="_blank" rel="noopener">submarinecablemap.com</a> ' +
      '(CC BY-NC-SA 3.0 — NonCommercial)',
  },
];

/**
 * Conditional credits — registered via `registerDynamicCredit` only when the
 * corresponding capability actually activates (deliberately NOT part of
 * DATA_CREDITS, which is always-on). TomTom terms require attribution when
 * their flow data is displayed; keyless installs never show it, so the
 * credit only appears once live traffic-flow mode activates.
 * @type {{ key: string, html: string }}
 */
export const TOMTOM_CREDIT = {
  key: 'tomtom',
  html:
    'Traffic flow data © ' +
    '<a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>',
};

/** Registered when the first Natural Earth region outline resolves (public
 * domain — no attribution required; credited as a courtesy). */
export const NATURAL_EARTH_CREDIT = {
  key: 'natural-earth',
  html:
    'Physical region boundaries from ' +
    '<a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a> (public domain)',
};

/** @type {Map<string, string>} Dynamic credits registered this session (key → html). */
const _dynamicCredits = new Map();
/** Controls added per map (idempotent registration). */
const _controlsByMap = new WeakMap();
/** Open lightbox (at most one). */
let _openLightbox = null;

const STYLE_ID = 'dg-data-credits-style';
const CREDITS_CSS = `
.dg-data-credits.maplibregl-ctrl { margin: 0 10px 10px 0; clear: both; }
.dg-data-credits button {
  font: 10px/1.6 var(--font-mono, ui-monospace, monospace);
  color: rgba(232, 234, 237, 0.85);
  background: rgba(8, 12, 18, 0.62);
  border: 0; border-radius: 10px; padding: 1px 8px; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.dg-data-credits button:hover, .dg-data-credits button:focus-visible { color: #fff; background: rgba(8, 12, 18, 0.85); }
.dg-credit-lightbox-overlay {
  position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.dg-credit-lightbox {
  position: relative; box-sizing: border-box; color: #e8eaed; background: #10151c;
  border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 6px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  font-family: var(--font-mono, ui-monospace, monospace);
}
.dg-credit-lightbox-title { margin: 0; padding: 14px 44px 8px 20px; font-size: 14px; font-weight: 600; letter-spacing: 0.04em; }
.dg-credit-lightbox-close {
  position: absolute; top: 8px; right: 10px; width: 28px; height: 28px; border: 0; border-radius: 4px;
  background: transparent; color: #e8eaed; font-size: 20px; line-height: 1; cursor: pointer;
}
.dg-credit-lightbox-close:hover, .dg-credit-lightbox-close:focus-visible { background: rgba(255, 255, 255, 0.12); }
.dg-credit-lightbox a { color: #8ecbff; }
.dg-credit-lightbox > ul { list-style: disc; }
`;

function ensureCreditsStyle(doc) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CREDITS_CSS;
  doc.head.appendChild(style);
}

/**
 * Base-map / terrain attributions of the current style (the `attribution` of
 * each source), deduplicated.
 * @param {object} [map] maplibregl.Map
 * @returns {string[]}
 */
function styleAttributions(map) {
  try {
    const sources = map?.getStyle?.()?.sources ?? {};
    return [...new Set(Object.values(sources).map((src) => src?.attribution).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Every credit line the lightbox shows, in order: the map style's own
 * attributions, the always-on data credits, then conditional credits.
 * @param {object} [map] maplibregl.Map (optional)
 * @returns {string[]} Credit HTML strings (trusted, from this module and the style).
 */
export function getDataCreditsHtml(map) {
  return [
    ...styleAttributions(map),
    ...DATA_CREDITS.map(({ html }) => html),
    ..._dynamicCredits.values(),
  ];
}

function closeLightbox() {
  if (!_openLightbox) return;
  const { overlay, onKey, opener } = _openLightbox;
  _openLightbox = null;
  overlay.ownerDocument?.removeEventListener('keydown', onKey, true);
  overlay.remove();
  opener?.focus?.();
}

function renderCreditList(list, map) {
  list.replaceChildren();
  for (const html of getDataCreditsHtml(map)) {
    const li = list.ownerDocument.createElement('li');
    li.innerHTML = html;
    list.appendChild(li);
  }
}

/** Open the "Data attribution" lightbox. */
export function openDataCreditsLightbox(map, opener = null) {
  const doc = opener?.ownerDocument || globalThis.document;
  if (!doc?.body) return null;
  closeLightbox();
  ensureCreditsStyle(doc);
  const overlay = doc.createElement('div');
  overlay.className = 'dg-credit-lightbox-overlay';
  const box = doc.createElement('div');
  box.className = 'dg-credit-lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'dg-credit-lightbox-title');
  const title = doc.createElement('h2');
  title.id = 'dg-credit-lightbox-title';
  title.className = 'dg-credit-lightbox-title';
  title.textContent = 'Data attribution';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'dg-credit-lightbox-close';
  close.setAttribute('aria-label', 'Fechar');
  close.textContent = '×';
  const list = doc.createElement('ul');
  renderCreditList(list, map);
  box.append(title, close, list);
  overlay.appendChild(box);
  close.addEventListener('click', closeLightbox);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeLightbox();
  });
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeLightbox();
    }
  };
  doc.addEventListener('keydown', onKey, true);
  doc.body.appendChild(overlay);
  _openLightbox = { overlay, onKey, opener, list, map };
  close.focus?.();
  return overlay;
}

/** MapLibre IControl: the "Data attribution" link beside the AttributionControl. */
class DataCreditsControl {
  onAdd(map) {
    this._map = map;
    const doc = map.getContainer?.()?.ownerDocument || globalThis.document;
    ensureCreditsStyle(doc);
    const el = doc.createElement('div');
    el.className = 'maplibregl-ctrl dg-data-credits';
    el.id = 'dg-data-credits';
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = 'Data attribution';
    button.setAttribute('aria-haspopup', 'dialog');
    button.title = 'Fontes e licenças dos dados do mapa';
    button.addEventListener('click', () => openDataCreditsLightbox(map, button));
    el.appendChild(button);
    this._el = el;
    return el;
  }

  onRemove() {
    this._el?.remove();
    this._el = null;
    this._map = null;
  }
}

/**
 * Register a conditional credit at the moment its data source activates.
 * Idempotent per `credit.key`; lands in the same "Data attribution" lightbox
 * as the static credits.
 * @param {object} [_engine] — the map engine (kept for the old call shape; unused)
 * @param {{ key: string, html: string }} credit — e.g. `TOMTOM_CREDIT`
 * @returns {boolean} True when the credit is (now) registered.
 */
export function registerDynamicCredit(_engine, credit) {
  if (!credit?.key || !credit?.html) return false;
  if (_dynamicCredits.has(credit.key)) return true;
  _dynamicCredits.set(credit.key, credit.html);
  if (_openLightbox) renderCreditList(_openLightbox.list, _openLightbox.map);
  return true;
}

/**
 * Add the "Data attribution" control to the engine's map (bottom-right, next
 * to MapLibre's AttributionControl). Idempotent per map.
 * @param {object} engine — Motor MapLibre (src/maplibre/engine.js); usa `engine.map`.
 * @returns {boolean} True when the control is on the map.
 */
export function registerDataCredits(engine) {
  const map = engine?.map;
  if (!map || typeof map.addControl !== 'function') return false;
  if (_controlsByMap.has(map)) return true;
  const control = new DataCreditsControl();
  map.addControl(control, 'bottom-right');
  _controlsByMap.set(map, control);
  return true;
}
