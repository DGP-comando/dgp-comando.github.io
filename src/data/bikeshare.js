/**
 * @module bikeshare
 * @description GBFS bikeshare station data overlay with real-time availability
 * — MapLibre version (migração do CesiumJS).
 *
 * Fetches station information and status from GBFS-compliant feeds (via the
 * dev proxy `/api/gbfs/*`), renders stations as color-coded circles sized by
 * capacity, and provides click-to-inspect and HUD detection integration.
 * Stations load on demand by camera proximity and altitude gating, with
 * periodic status polling to keep availability colors current.
 *
 * No MapLibre (o que mudou):
 *  - Estações: fonte GeoJSON `dg-bikeshare` + `circle` (antes
 *    PointPrimitiveCollection com escala/translucidez por distância).
 *  - Seleção: clique numa estação a destaca (anel ciano) e publica o cartão
 *    do selecionado no host de cartões (mapCardHost.js, marcador DOM) — antes
 *    uma Entity Cesium + worldOverlay. Clique no vazio ou Esc limpa.
 *  - Posições públicas (`record.position`, detecção, cartão) são
 *    `{lon, lat, height}` em vez de Cesium.Cartesian3.
 */

import { defineLayer, EMPTY_FC, esc, row } from '../maplibre/kit.js';
import { getActiveLayerHost } from '../maplibre/layerHost.js';
import { cameraAltitudeM, getMapCardHost } from './mapCardHost.js';

export const BIKESHARE_SELECTED_OVERLAY_SOURCE_ID = 'bikeshare-selected';
export const BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const NOOP_OVERLAY_HOST = Object.freeze({
  setEntries() {},
  setVisible() {},
  clearSource() {},
});
let _overlayHostOverride = null;
function overlayHost() {
  return _overlayHostOverride || getMapCardHost(_engine) || NOOP_OVERLAY_HOST;
}

// --- Activation / display thresholds ---
/** Altitude (m) at which bikeshare layer becomes eligible for display. */
const ACTIVATION_ALTITUDE_M = 50000;
/** Hysteresis enter threshold — layer activates when camera drops below this. */
const ACTIVATION_ENTER_ALTITUDE_M = ACTIVATION_ALTITUDE_M - 2000;
/** Hysteresis exit threshold — layer deactivates when camera rises above this. */
const ACTIVATION_EXIT_ALTITUDE_M = ACTIVATION_ALTITUDE_M + 2000;
/** Debounce interval (ms) for camera-change proximity checks. */
const CAMERA_DEBOUNCE_MS = 340;
/** Default radius (km) for determining whether a city is in camera range. */
const CITY_RANGE_BASE_KM = 100;
/** Polling interval (ms) for refreshing station status data. */
const STATUS_POLL_MS = 60000;

// --- Point rendering constants ---
const POINT_SIZE_MIN = 4;
const POINT_SIZE_MAX = 12;
const DEFAULT_CAPACITY = 15;
const MAX_TOTAL_POINTS = 8000;

// --- Availability color palette (CSS) ---
const COLOR_GREEN = 'rgba(0,255,136,0.95)';
const COLOR_YELLOW = 'rgba(255,170,0,0.94)';
const COLOR_RED = 'rgba(255,68,68,0.94)';
const COLOR_NEUTRAL = 'rgba(145,164,180,0.62)';
const COLOR_MUTED = 'rgba(104,117,129,0.48)';

const SRC_STATIONS = 'dg-bikeshare';
const LYR_STATIONS = 'dg-bikeshare-pt';
const LYR_SELECTED = 'dg-bikeshare-selected';

/**
 * Build GBFS endpoint URLs for a BCycle-hosted system.
 * @param {string} systemId - BCycle system identifier (e.g. 'bcycle_boulder').
 * @returns {{ stationInformationUrl: string, stationStatusUrl: string }}
 */
function buildBcycleUrls(systemId) {
  return {
    stationInformationUrl: `https://gbfs.bcycle.com/${systemId}/station_information.json`,
    stationStatusUrl: `https://gbfs.bcycle.com/${systemId}/station_status.json`,
  };
}

/**
 * Convenience factory for a BCycle-hosted city registry entry.
 * Merges caller-supplied metadata with auto-generated BCycle GBFS URLs.
 * @param {Object} opts
 * @param {string} opts.id - Unique city identifier.
 * @param {string} opts.city - Human-readable city name.
 * @param {number} opts.centerLat - City center latitude.
 * @param {number} opts.centerLon - City center longitude.
 * @param {string} opts.systemId - BCycle system identifier.
 * @param {number} [opts.loadRadiusKm=100] - Activation radius in km.
 * @param {string} [opts.provider='BCycle'] - Display provider name.
 * @returns {Object} Raw registry entry suitable for RAW_GBFS_CITY_REGISTRY.
 */
function bcycleEntry({ id, city, centerLat, centerLon, systemId, loadRadiusKm = 100, provider = 'BCycle' }) {
  return {
    id,
    city,
    centerLat,
    centerLon,
    loadRadiusKm,
    provider,
    ...buildBcycleUrls(systemId),
  };
}

/**
 * Raw registry of supported GBFS bikeshare cities.
 * Each entry specifies the city center, load radius, GBFS feed URLs, and provider name.
 * Entries using BCycle hosting are constructed via bcycleEntry() for brevity.
 * @type {Object[]}
 */
const RAW_GBFS_CITY_REGISTRY = [
  {
    id: 'nyc-citibike',
    city: 'New York, NY',
    centerLat: 40.7484,
    centerLon: -73.9967,
    loadRadiusKm: 140,
    stationInformationUrl: 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json',
    stationStatusUrl: 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json',
    provider: 'Citi Bike',
  },
  {
    id: 'chicago-divvy',
    city: 'Chicago, IL',
    centerLat: 41.8781,
    centerLon: -87.6298,
    loadRadiusKm: 120,
    stationInformationUrl: 'https://gbfs.lyft.com/gbfs/2.3/chi/en/station_information.json',
    stationStatusUrl: 'https://gbfs.lyft.com/gbfs/2.3/chi/en/station_status.json',
    provider: 'Divvy',
  },
  {
    id: 'dc-capital-bikeshare',
    city: 'Washington, DC',
    centerLat: 38.9072,
    centerLon: -77.0369,
    loadRadiusKm: 120,
    stationInformationUrl: 'https://gbfs.lyft.com/gbfs/2.3/dca-cabi/en/station_information.json',
    stationStatusUrl: 'https://gbfs.lyft.com/gbfs/2.3/dca-cabi/en/station_status.json',
    provider: 'Capital Bikeshare',
  },
  {
    id: 'sf-bay-wheels',
    city: 'San Francisco, CA',
    centerLat: 37.7749,
    centerLon: -122.4194,
    loadRadiusKm: 110,
    stationInformationUrl: 'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_information.json',
    stationStatusUrl: 'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_status.json',
    provider: 'Bay Wheels',
  },
  {
    id: 'boston-bluebikes',
    city: 'Boston, MA',
    centerLat: 42.3601,
    centerLon: -71.0589,
    loadRadiusKm: 100,
    stationInformationUrl: 'https://gbfs.bluebikes.com/gbfs/en/station_information.json',
    stationStatusUrl: 'https://gbfs.bluebikes.com/gbfs/en/station_status.json',
    provider: 'Blue Bikes',
  },
  {
    id: 'philadelphia-indego',
    city: 'Philadelphia, PA',
    centerLat: 39.9526,
    centerLon: -75.1652,
    loadRadiusKm: 100,
    stationInformationUrl: 'https://gbfs.bcycle.com/bcycle_indego/station_information.json',
    stationStatusUrl: 'https://gbfs.bcycle.com/bcycle_indego/station_status.json',
    provider: 'Indego',
  },
  {
    id: 'portland-biketown',
    city: 'Portland, OR',
    centerLat: 45.5152,
    centerLon: -122.6784,
    loadRadiusKm: 95,
    stationInformationUrl: 'https://gbfs.biketownpdx.com/gbfs/2.3/en/station_information.json',
    stationStatusUrl: 'https://gbfs.biketownpdx.com/gbfs/2.3/en/station_status.json',
    provider: 'BIKETOWN',
  },
  {
    id: 'la-metro-bike',
    city: 'Los Angeles, CA',
    centerLat: 34.0522,
    centerLon: -118.2437,
    loadRadiusKm: 120,
    stationInformationUrl: 'https://gbfs.bcycle.com/bcycle_lametro/station_information.json',
    stationStatusUrl: 'https://gbfs.bcycle.com/bcycle_lametro/station_status.json',
    provider: 'Metro Bike',
  },
  {
    id: 'austin-capmetro',
    city: 'Austin, TX',
    centerLat: 30.2672,
    centerLon: -97.7431,
    loadRadiusKm: 90,
    stationInformationUrl: 'https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl: 'https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'CapMetro',
  },
  {
    id: 'honolulu-biki',
    city: 'Honolulu, HI',
    centerLat: 21.3069,
    centerLon: -157.8583,
    loadRadiusKm: 90,
    stationInformationUrl: 'https://hon.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl: 'https://hon.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Biki',
  },
  {
    id: 'columbus-cogo',
    city: 'Columbus, OH',
    centerLat: 39.9612,
    centerLon: -82.9988,
    loadRadiusKm: 90,
    stationInformationUrl: 'https://gbfs.cogobikeshare.com/gbfs/2.3/en/station_information.json',
    stationStatusUrl: 'https://gbfs.cogobikeshare.com/gbfs/2.3/en/station_status.json',
    provider: 'CoGo',
  },
  {
    id: 'chattanooga-bikechatt',
    city: 'Chattanooga, TN',
    centerLat: 35.0456,
    centerLon: -85.3097,
    loadRadiusKm: 90,
    stationInformationUrl: 'https://chat.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl: 'https://chat.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bike Chattanooga',
  },
  bcycleEntry({
    id: 'boulder-bcycle',
    city: 'Boulder, CO',
    centerLat: 40.0150,
    centerLon: -105.2705,
    systemId: 'bcycle_boulder',
  }),
  bcycleEntry({
    id: 'milwaukee-bublr',
    city: 'Milwaukee, WI',
    centerLat: 43.0389,
    centerLon: -87.9065,
    systemId: 'bcycle_bublr',
    provider: 'Bublr',
  }),
  bcycleEntry({
    id: 'madison-bcycle',
    city: 'Madison, WI',
    centerLat: 43.0731,
    centerLon: -89.4012,
    systemId: 'bcycle_madison',
  }),
  bcycleEntry({
    id: 'nashville-bcycle',
    city: 'Nashville, TN',
    centerLat: 36.1627,
    centerLon: -86.7816,
    systemId: 'bcycle_nashville',
  }),
  bcycleEntry({
    id: 'salt-lake-greenbike',
    city: 'Salt Lake City, UT',
    centerLat: 40.7608,
    centerLon: -111.8910,
    systemId: 'bcycle_greenbikeslc',
    provider: 'GREENbike',
  }),
  bcycleEntry({
    id: 'san-antonio-bcycle',
    city: 'San Antonio, TX',
    centerLat: 29.4241,
    centerLon: -98.4936,
    systemId: 'bcycle_sanantonio',
  }),
  bcycleEntry({
    id: 'cincinnati-red-bike',
    city: 'Cincinnati, OH',
    centerLat: 39.1031,
    centerLon: -84.5120,
    systemId: 'bcycle_cincyredbike',
    provider: 'Red Bike',
  }),
  bcycleEntry({
    id: 'el-paso-bcycle',
    city: 'El Paso, TX',
    centerLat: 31.7619,
    centerLon: -106.4850,
    systemId: 'bcycle_elpaso',
  }),
  bcycleEntry({
    id: 'indianapolis-pacers',
    city: 'Indianapolis, IN',
    centerLat: 39.7684,
    centerLon: -86.1581,
    systemId: 'bcycle_pacersbikeshare',
    provider: 'Pacers Bikeshare',
  }),
  bcycleEntry({
    id: 'fort-lauderdale-broward',
    city: 'Fort Lauderdale, FL',
    centerLat: 26.1224,
    centerLon: -80.1373,
    systemId: 'bcycle_broward',
    provider: 'Broward B-cycle',
  }),
  bcycleEntry({
    id: 'memphis-bcycle',
    city: 'Memphis, TN',
    centerLat: 35.1495,
    centerLon: -90.0490,
    systemId: 'bcycle_memphis',
  }),
  bcycleEntry({
    id: 'des-moines-bcycle',
    city: 'Des Moines, IA',
    centerLat: 41.5868,
    centerLon: -93.6250,
    systemId: 'bcycle_desmoines',
  }),
  bcycleEntry({
    id: 'tucson-tugo',
    city: 'Tucson, AZ',
    centerLat: 32.2226,
    centerLon: -110.9747,
    systemId: 'bcycle_tugo',
    provider: 'Tugo',
  }),
  bcycleEntry({
    id: 'fort-worth-trinity',
    city: 'Fort Worth, TX',
    centerLat: 32.7555,
    centerLon: -97.3308,
    systemId: 'bcycle_fortworth',
    provider: 'Trinity Metro',
  }),
  bcycleEntry({
    id: 'omaha-heartland',
    city: 'Omaha, NE',
    centerLat: 41.2565,
    centerLon: -95.9345,
    systemId: 'bcycle_heartland',
    provider: 'Heartland B-cycle',
  }),
  bcycleEntry({
    id: 'lincoln-bikelnk',
    city: 'Lincoln, NE',
    centerLat: 40.8136,
    centerLon: -96.7026,
    systemId: 'bcycle_bikelnk',
    provider: 'BikeLNK',
  }),
  bcycleEntry({
    id: 'greenville-sc-bcycle',
    city: 'Greenville, SC',
    centerLat: 34.8526,
    centerLon: -82.3940,
    systemId: 'bcycle_greenville',
  }),
  bcycleEntry({
    id: 'buffalo-reddy',
    city: 'Buffalo, NY',
    centerLat: 42.8864,
    centerLon: -78.8784,
    systemId: 'bcycle_reddy',
    provider: 'Reddy Bikeshare',
  }),
  bcycleEntry({
    id: 'las-vegas-rtc-bike-share',
    city: 'Las Vegas, NV',
    centerLat: 36.1699,
    centerLon: -115.1398,
    systemId: 'bcycle_rtcbikeshare',
    provider: 'RTC Bike Share',
  }),
  bcycleEntry({
    id: 'santa-barbara-bcycle',
    city: 'Santa Barbara, CA',
    centerLat: 34.4208,
    centerLon: -119.6982,
    systemId: 'bcycle_santabarbara',
  }),
];

/**
 * Validate and normalize a raw GBFS city registry entry.
 * Ensures required fields are present, URLs are HTTPS and match expected
 * GBFS endpoint patterns, and coordinates are finite numbers.
 * @param {Object} entry - Raw registry entry from RAW_GBFS_CITY_REGISTRY.
 * @returns {Object} Normalized entry with validated fields and extracted hostnames.
 * @throws {Error} If any required field is missing or invalid.
 */
function normalizeRegistryEntry(entry) {
  const id = String(entry?.id || '').trim().toLowerCase();
  const city = String(entry?.city || '').trim();
  const centerLat = Number(entry?.centerLat);
  const centerLon = Number(entry?.centerLon);
  const loadRadiusKm = Number(entry?.loadRadiusKm);
  const stationInformationUrl = new URL(String(entry?.stationInformationUrl || '').trim());
  const stationStatusUrl = new URL(String(entry?.stationStatusUrl || '').trim());

  if (!id) throw new Error('GBFS entry id is required');
  if (!city) throw new Error(`GBFS entry "${id}" city is required`);
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
    throw new Error(`GBFS entry "${id}" has invalid center coordinates`);
  }
  // Enforce HTTPS-only for GBFS feeds
  if (stationInformationUrl.protocol !== 'https:' || stationStatusUrl.protocol !== 'https:') {
    throw new Error(`GBFS entry "${id}" must use https URLs`);
  }
  // Validate that URLs end with expected GBFS endpoint filenames
  if (!/\/station_information\.json$/i.test(stationInformationUrl.pathname)) {
    throw new Error(`GBFS entry "${id}" station_information URL is invalid`);
  }
  if (!/\/station_status\.json$/i.test(stationStatusUrl.pathname)) {
    throw new Error(`GBFS entry "${id}" station_status URL is invalid`);
  }

  // Deduplicate hostnames across both feed URLs for proxy allowlisting
  const hosts = Array.from(
    new Set([stationInformationUrl.hostname.toLowerCase(), stationStatusUrl.hostname.toLowerCase()])
  );

  return {
    id,
    city,
    centerLat,
    centerLon,
    loadRadiusKm: Number.isFinite(loadRadiusKm) && loadRadiusKm > 0 ? loadRadiusKm : CITY_RANGE_BASE_KM,
    stationInformationUrl: stationInformationUrl.toString(),
    stationStatusUrl: stationStatusUrl.toString(),
    provider: String(entry?.provider || 'GBFS').trim() || 'GBFS',
    hosts,
  };
}

/**
 * Validated and deduplicated city registry, built at module load time.
 * Throws if any entry fails validation or has a duplicate id.
 * @type {Object[]}
 */
const GBFS_CITY_REGISTRY = (() => {
  const seen = new Set();
  return RAW_GBFS_CITY_REGISTRY.map((entry) => {
    const normalized = normalizeRegistryEntry(entry);
    if (seen.has(normalized.id)) {
      throw new Error(`Duplicate GBFS city id: ${normalized.id}`);
    }
    seen.add(normalized.id);
    return normalized;
  });
})();

/** Lookup map from city id to its normalized registry entry. */
const CITY_BY_ID = new Map(GBFS_CITY_REGISTRY.map((entry) => [entry.id, entry]));
// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------

let _engine = null;
let _map = null;
let _enabled = false;
let _cameraDebounceTimer = null;
let _offs = [];
let _altitudeGateEnabled = false;
let _proximityGeneration = 0;

let _activeCityIds = new Set();
let _cityRuntime = new Map();

let _stationInfoCache = new Map();
let _statusCache = new Map();
let _inFlightInfo = new Map();
let _inFlightStatus = new Map();

/** @type {Map<string, Object>} Render records keyed by "cityId:stationId". */
let _stationRenderMap = new Map();
let _selectedKey = null;
let _keyListenerBound = false;
let _renderQueued = false;

let _count = 0;
let _lastUpdate = null;
let _loading = false;
let _loadingOps = 0;
let _error = null;
let _limitWarned = false;

/**
 * Convert an upstream GBFS URL into a local proxy URL.
 * The dev server proxies /api/gbfs/* to avoid CORS issues with third-party feeds.
 * @param {string} upstreamUrl - Full HTTPS GBFS endpoint URL.
 * @returns {string} Relative proxy URL.
 */
function toProxyUrl(upstreamUrl) {
  return `/api/gbfs/${encodeURIComponent(upstreamUrl)}`;
}

/** Increment the loading reference count and mark loading state active. */
function beginLoading() {
  _loadingOps++;
  _loading = true;
}

/** Decrement the loading reference count; clear loading flag when zero. */
function endLoading() {
  _loadingOps = Math.max(0, _loadingOps - 1);
  _loading = _loadingOps > 0;
}

/**
 * Coerce a GBFS boolean field to a native boolean.
 * GBFS feeds are inconsistent — some use booleans, others use 0/1 or strings.
 * @param {*} value - Raw field value from GBFS JSON.
 * @param {boolean} [fallback=true] - Default when value is null/undefined/unrecognized.
 * @returns {boolean}
 */
function normalizeGbfsBool(value, fallback = true) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const num = Number(value);
  if (Number.isFinite(num)) return num !== 0;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === 'yes') return true;
  if (text === 'false' || text === 'no') return false;
  return fallback;
}

/**
 * Parse a value as a non-negative integer, returning fallback on failure.
 * @param {*} value - Raw numeric value.
 * @param {number|null} [fallback=null] - Returned when value is not a valid non-negative number.
 * @returns {number|null}
 */
function toNonNegativeInteger(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}

/**
 * Build a globally unique render key for a station.
 * @param {string} cityId - City identifier.
 * @param {string} stationId - Station identifier within the city.
 * @returns {string} Composite key in "cityId:stationId" format.
 */
function stationKey(cityId, stationId) {
  return `${cityId}:${stationId}`;
}

/**
 * Compute the great-circle distance between two points using the Haversine formula.
 * @param {number} aLat - Latitude of point A in degrees.
 * @param {number} aLon - Longitude of point A in degrees.
 * @param {number} bLat - Latitude of point B in degrees.
 * @param {number} bLon - Longitude of point B in degrees.
 * @returns {number} Distance in kilometers.
 */
function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const p1 = toRad(aLat);
  const p2 = toRad(bLat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Determine whether the layer should be active at the given camera altitude.
 * Uses hysteresis (separate enter/exit thresholds) to avoid rapid toggling
 * when the camera hovers near the activation boundary.
 * @param {number} altitude - Camera altitude in meters.
 * @returns {boolean} True if the layer should remain/become active.
 */
function shouldActivateAtAltitude(altitude) {
  if (!Number.isFinite(altitude)) {
    _altitudeGateEnabled = false;
    return false;
  }
  if (_altitudeGateEnabled) {
    // Deactivate only after crossing the higher exit threshold
    if (altitude >= ACTIVATION_EXIT_ALTITUDE_M) _altitudeGateEnabled = false;
  } else if (altitude <= ACTIVATION_ENTER_ALTITUDE_M) {
    // Activate when dropping below the lower enter threshold
    _altitudeGateEnabled = true;
  }
  return _altitudeGateEnabled;
}

/**
 * Determine which cities are close enough to the camera to warrant loading.
 * Compares haversine distance from the camera center to each city's center
 * against the city's configured load radius.
 * @param {{ lat: number, lon: number }} center - Camera center in degrees.
 * @returns {Set<string>} Set of city ids currently within load range.
 */
function computeInRangeCities(center) {
  const active = new Set();
  if (!center) return active;

  for (const city of GBFS_CITY_REGISTRY) {
    const distance = haversineKm(center.lat, center.lon, city.centerLat, city.centerLon);
    const radius = Math.max(CITY_RANGE_BASE_KM, city.loadRadiusKm);
    if (distance <= radius) active.add(city.id);
  }

  return active;
}

/**
 * Extract the stations array from a GBFS JSON payload.
 * Handles multiple response shapes: { data: { stations: [...] } },
 * { data: [...] }, and nested objects with a stations sub-key.
 * @param {Object} payload - Parsed GBFS JSON response.
 * @returns {Object[]} Array of raw station objects (may be empty).
 */
function extractStationsArray(payload) {
  const data = payload?.data;
  if (Array.isArray(data?.stations)) return data.stations;
  if (Array.isArray(data)) return data;
  // Some feeds nest stations under an additional key (e.g. locale wrappers)
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (Array.isArray(value?.stations)) return value.stations;
    }
  }
  return [];
}

/**
 * Parse a GBFS station_information payload into a Map of station metadata.
 * Handles field-name variations across different GBFS providers
 * (station_id vs id, lat vs latitude, etc.). Stations with missing or
 * invalid coordinates are silently skipped.
 * @param {Object} payload - Parsed station_information.json response.
 * @returns {Map<string, Object>} Map of stationId to station info objects.
 */
function parseStationInformation(payload) {
  const stations = extractStationsArray(payload);
  const stationMap = new Map();

  for (const raw of stations) {
    // Accept both GBFS 2.x (station_id) and alternate (id) field names
    const stationId = String(raw?.station_id ?? raw?.id ?? '').trim();
    const lat = Number(raw?.lat ?? raw?.latitude);
    const lon = Number(raw?.lon ?? raw?.longitude);
    if (!stationId || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    stationMap.set(stationId, {
      stationId,
      name: String(raw?.name || raw?.short_name || '').trim(),
      lat,
      lon,
      capacity: toNonNegativeInteger(raw?.capacity),
      isInstalled: normalizeGbfsBool(raw?.is_installed, true),
      isRenting: normalizeGbfsBool(raw?.is_renting, true),
      isReturning: normalizeGbfsBool(raw?.is_returning, true),
    });
  }

  return stationMap;
}

/**
 * Parse a GBFS station_status payload into a Map of real-time availability.
 * @param {Object} payload - Parsed station_status.json response.
 * @returns {Map<string, Object>} Map of stationId to status objects containing
 *   bikesAvailable, docksAvailable, and operational flags.
 */
function parseStationStatus(payload) {
  const stations = extractStationsArray(payload);
  const statusMap = new Map();

  for (const raw of stations) {
    const stationId = String(raw?.station_id ?? raw?.id ?? '').trim();
    if (!stationId) continue;

    const bikes = toNonNegativeInteger(raw?.num_bikes_available);
    const docks = toNonNegativeInteger(raw?.num_docks_available);
    statusMap.set(stationId, {
      stationId,
      bikesAvailable: bikes,
      docksAvailable: docks,
      isInstalled: normalizeGbfsBool(raw?.is_installed, true),
      isRenting: normalizeGbfsBool(raw?.is_renting, true),
      isReturning: normalizeGbfsBool(raw?.is_returning, true),
      lastReported: toNonNegativeInteger(raw?.last_reported),
    });
  }

  return statusMap;
}

/**
 * Fetch and parse JSON from a GBFS endpoint via the local proxy.
 * @param {string} upstreamUrl - Full HTTPS GBFS endpoint URL.
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - Optional abort signal for cancellation.
 * @returns {Promise<Object>} Parsed JSON payload.
 * @throws {Error} On non-OK HTTP status or malformed JSON.
 */
async function fetchGbfsJson(upstreamUrl, { signal } = {}) {
  const response = await fetch(toProxyUrl(upstreamUrl), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error(`GBFS HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload || typeof payload !== 'object') {
    throw new Error('Malformed GBFS payload');
  }
  return payload;
}

/**
 * Abort an in-flight GBFS request for a specific city and remove it from the map.
 * @param {Map<string, { controller: AbortController }>} map - In-flight request map.
 * @param {string} cityId - City whose request should be cancelled.
 */
function abortInFlight(map, cityId) {
  const entry = map.get(cityId);
  if (!entry) return;
  try {
    entry.controller?.abort();
  } catch {
    // no-op
  }
  map.delete(cityId);
}

/** Abort all in-flight station info and status requests across all cities. */
function abortAllInFlight() {
  for (const cityId of _inFlightInfo.keys()) abortInFlight(_inFlightInfo, cityId);
  for (const cityId of _inFlightStatus.keys()) abortInFlight(_inFlightStatus, cityId);
}

/**
 * Load station information for a city. Returns cached data if available,
 * deduplicates concurrent requests, and caches the result on success.
 * Station info is static metadata (location, name, capacity) and is
 * fetched once per city per session.
 * @param {string} cityId - City identifier.
 * @param {number} generation - Proximity generation to detect stale requests.
 * @returns {Promise<Map<string, Object>>} Map of stationId to station info.
 * @throws {Error} On unknown city, fetch failure, or empty station list.
 */
async function loadCityStationInfo(cityId, generation) {
  if (_stationInfoCache.has(cityId)) return _stationInfoCache.get(cityId);
  const inFlight = _inFlightInfo.get(cityId);
  if (inFlight) return inFlight.promise;

  const city = CITY_BY_ID.get(cityId);
  if (!city) throw new Error(`Unknown GBFS city "${cityId}"`);
  const controller = new AbortController();

  const promise = (async () => {
    beginLoading();
    try {
      const payload = await fetchGbfsJson(city.stationInformationUrl, { signal: controller.signal });
      const stationMap = parseStationInformation(payload);
      if (stationMap.size === 0) {
        throw new Error(`No station information for ${city.city}`);
      }
      _stationInfoCache.set(cityId, stationMap);
      return stationMap;
    } finally {
      endLoading();
    }
  })().finally(() => {
    // Clean up in-flight entry only if it is still ours (not replaced by a newer request)
    const current = _inFlightInfo.get(cityId);
    if (current && current.controller === controller) _inFlightInfo.delete(cityId);
  });

  _inFlightInfo.set(cityId, { promise, controller, generation });
  return promise;
}

/**
 * Load real-time station status for a city (bike/dock counts, operational flags).
 * Unlike station info, status is NOT served from cache — it is always re-fetched
 * to keep availability data current. Concurrent requests are deduplicated.
 * @param {string} cityId - City identifier.
 * @param {number} generation - Proximity generation to detect stale requests.
 * @returns {Promise<Map<string, Object>>} Map of stationId to status objects.
 * @throws {Error} On unknown city or fetch failure.
 */
async function loadCityStationStatus(cityId, generation) {
  const inFlight = _inFlightStatus.get(cityId);
  if (inFlight) return inFlight.promise;

  const city = CITY_BY_ID.get(cityId);
  if (!city) throw new Error(`Unknown GBFS city "${cityId}"`);
  const controller = new AbortController();

  const promise = (async () => {
    beginLoading();
    try {
      const payload = await fetchGbfsJson(city.stationStatusUrl, { signal: controller.signal });
      const statusMap = parseStationStatus(payload);
      _statusCache.set(cityId, {
        statusMap,
        timestamp: Date.now(),
      });
      return statusMap;
    } finally {
      endLoading();
    }
  })().finally(() => {
    const current = _inFlightStatus.get(cityId);
    if (current && current.controller === controller) _inFlightStatus.delete(cityId);
  });

  _inFlightStatus.set(cityId, { promise, controller, generation });
  return promise;
}

/**
 * Resolve the effective dock capacity for a station.
 * Prefers the explicit capacity from station_information; falls back to
 * bikes+docks from status data; uses DEFAULT_CAPACITY as last resort.
 * @param {number|null} capacityFromInfo - Capacity from station_information, or null.
 * @param {Object|null} status - Station status object with bikesAvailable/docksAvailable.
 * @returns {number} Resolved capacity (always > 0).
 */
function resolveCapacity(capacityFromInfo, status) {
  const fromInfo = toNonNegativeInteger(capacityFromInfo);
  if (fromInfo && fromInfo > 0) return fromInfo;

  // Derive capacity from current bikes + available docks
  const bikes = toNonNegativeInteger(status?.bikesAvailable, 0);
  const docks = toNonNegativeInteger(status?.docksAvailable, 0);
  const derived = bikes + docks;
  if (derived > 0) return derived;

  return DEFAULT_CAPACITY;
}

/**
 * Map station capacity to a point pixel size using a sqrt scale.
 * Larger-capacity stations render as bigger dots; clamped to [POINT_SIZE_MIN, POINT_SIZE_MAX].
 * @param {number} capacity - Station dock capacity.
 * @returns {number} Point size in pixels.
 */
function capacityToPixelSize(capacity) {
  const c = Math.max(1, Math.min(80, Number(capacity) || DEFAULT_CAPACITY));
  // sqrt scale so large stations don't dominate visually
  const normalized = Math.sqrt(c) / Math.sqrt(80);
  const size = POINT_SIZE_MIN + normalized * (POINT_SIZE_MAX - POINT_SIZE_MIN);
  return Math.max(POINT_SIZE_MIN, Math.min(POINT_SIZE_MAX, size));
}

/**
 * Determine the display color for a station based on its availability ratio.
 * - No status data: neutral gray.
 * - Offline (not installed/renting/returning): muted gray.
 * - >60% bikes available: green.
 * - 30-60% bikes available: yellow.
 * - <30% bikes available: red.
 * @param {Object|null} status - Station status object.
 * @param {number} capacity - Resolved station capacity.
 * @returns {string} CSS color to apply to the station point.
 */
function statusToColor(status, capacity) {
  if (!status) return COLOR_NEUTRAL;
  if (!status.isInstalled || !status.isRenting || !status.isReturning) return COLOR_MUTED;

  const bikes = toNonNegativeInteger(status.bikesAvailable);
  if (!Number.isFinite(bikes)) return COLOR_NEUTRAL;

  const cap = Math.max(1, Number(capacity) || DEFAULT_CAPACITY);
  const ratio = bikes / cap;
  if (ratio > 0.6) return COLOR_GREEN;
  if (ratio >= 0.3) return COLOR_YELLOW;
  return COLOR_RED;
}

/**
 * Build a multi-line text label for the selected station popup.
 * Shows station name, availability counts, and any abnormal operational flags.
 * @param {Object} record - Render record from _stationRenderMap.
 * @returns {string} Newline-delimited source text for the selected host card.
 */
function buildSelectionLabel(record) {
  const stationName = String(record?.stationName || '').trim();
  const stationLabel = stationName || (record?.stationId ? `Station ${record.stationId}` : 'Station');
  const bikes = Number.isFinite(record?.bikesAvailable) ? record.bikesAvailable : '?';
  const docks = Number.isFinite(record?.docksAvailable) ? record.docksAvailable : '?';
  const capacity = Number.isFinite(record?.capacity) ? record.capacity : '?';

  const lines = [
    stationLabel,
    `🚲 ${bikes} avail · ${docks} docks · ${capacity} cap`,
  ];

  // Append warnings for stations that are offline or partially non-operational
  const abnormal = [];
  if (record?.isInstalled === false) abnormal.push('⚠️ Not installed');
  if (record?.isRenting === false) abnormal.push('⚠️ Not renting');
  if (record?.isReturning === false) abnormal.push('⚠️ Not returning');
  if (abnormal.length > 0) {
    lines.push(abnormal.join(' · '));
  }

  return lines.join('\n');
}


/**
 * Selected-station card entry for the card host. `record.position` is
 * `{lon, lat, height}` (was `record.point.position`, a Cesium.Cartesian3; the
 * old shape is still read for compatibility).
 * @param {string} key
 * @param {Object} record
 * @returns {Object|null}
 */
export function createBikeshareSelectedOverlayEntry(key, record) {
  const position = record?.position ?? record?.point?.position;
  if (!key || !position) return null;
  const [title, ...details] = buildSelectionLabel(record).split('\n');
  return {
    id: String(key),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: '#00ffff',
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    gapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

// ---------------------------------------------------------------------------
// MapLibre rendering
// ---------------------------------------------------------------------------

const BIKESHARE_LAYER_DEF = defineLayer({
  id: 'bikeshare',
  name: 'Bikeshare',
  category: 'Contexto',
  icon: '🚲',
  source: 'GBFS',
  sources: { [SRC_STATIONS]: { type: 'geojson', data: EMPTY_FC } },
  layers: [
    {
      id: LYR_STATIONS,
      type: 'circle',
      source: SRC_STATIONS,
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['*', ['get', 'size'], 0.3], 15, ['*', ['get', 'size'], 0.75]],
        'circle-stroke-color': 'rgba(0,0,0,0.25)',
        'circle-stroke-width': 1,
      },
    },
    {
      id: LYR_SELECTED,
      type: 'circle',
      source: SRC_STATIONS,
      filter: ['==', ['get', 'key'], ''],
      paint: {
        'circle-color': '#00ffff',
        'circle-radius': 7,
        'circle-stroke-color': '#000000',
        'circle-stroke-width': 2,
      },
    },
  ],
  interactive: [LYR_STATIONS, LYR_SELECTED],
  tooltip: (props) => {
    const record = _stationRenderMap.get(props.key);
    if (!record) return '';
    const bikes = Number.isFinite(record.bikesAvailable) ? record.bikesAvailable : '?';
    const docks = Number.isFinite(record.docksAvailable) ? record.docksAvailable : '?';
    return `<b>${esc(record.stationName || `Station ${record.stationId}`)}</b>`
      + `${row('Bicicletas', bikes)}${row('Vagas', docks)}${row('Capacidade', record.capacity)}`;
  },
  click: (props) => {
    if (props?.key && _stationRenderMap.has(props.key)) {
      if (props.key !== _selectedKey) _selectStation(props.key);
    }
  },
});

function stationFeatures() {
  const features = [];
  for (const record of _stationRenderMap.values()) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [record.position.lon, record.position.lat] },
      properties: { key: record.key, color: record.color, size: record.pixelSize },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Coalesce source rewrites to one per frame (fetches settle in bursts). */
function scheduleRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  const run = () => {
    _renderQueued = false;
    _map?.getSource(SRC_STATIONS)?.setData(_enabled ? stationFeatures() : EMPTY_FC);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

function setSelectedFilter() {
  if (_map?.getLayer(LYR_SELECTED)) {
    _map.setFilter(LYR_SELECTED, ['==', ['get', 'key'], _selectedKey || '']);
  }
}

function _clearSelection() {
  if (_selectedKey) {
    const record = _stationRenderMap.get(_selectedKey);
    if (record?.point) record.point.show = true;
  }
  _selectedKey = null;
  setSelectedFilter();
  overlayHost().clearSource(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID);
}

function _selectStation(key) {
  _clearSelection();
  const record = _stationRenderMap.get(key);
  if (!record || !(record.position || record.point?.position)) return;
  _selectedKey = key;
  if (record.point) record.point.show = false;
  setSelectedFilter();
  const entry = createBikeshareSelectedOverlayEntry(key, record);
  if (entry) {
    overlayHost().setEntries(
      BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
      [entry],
      BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
  }
}

function ensureCityRuntime(cityId) {
  if (_cityRuntime.has(cityId)) return _cityRuntime.get(cityId);
  const runtime = { stationKeys: new Set() };
  _cityRuntime.set(cityId, runtime);
  return runtime;
}

function ensureCityPoints(cityId, stationMap) {
  const runtime = ensureCityRuntime(cityId);
  for (const station of stationMap.values()) {
    const key = stationKey(cityId, station.stationId);
    if (_stationRenderMap.has(key)) {
      runtime.stationKeys.add(key);
      continue;
    }
    if (_stationRenderMap.size >= MAX_TOTAL_POINTS) {
      if (!_limitWarned) {
        _limitWarned = true;
        console.warn(`[Data:Bikeshare] Point cap reached (${MAX_TOTAL_POINTS}).`);
      }
      break;
    }
    const lon = Number(station.lon);
    const lat = Number(station.lat);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    _stationRenderMap.set(key, {
      key,
      cityId,
      stationId: station.stationId,
      stationName: station.name,
      position: { lon, lat, height: 0 },
      color: COLOR_NEUTRAL,
      pixelSize: capacityToPixelSize(station.capacity),
      capacity: toNonNegativeInteger(station.capacity),
      bikesAvailable: null,
      docksAvailable: null,
      isInstalled: station.isInstalled,
      isRenting: station.isRenting,
      isReturning: station.isReturning,
    });
    runtime.stationKeys.add(key);
  }
  _count = _stationRenderMap.size;
  scheduleRender();
}

function removeCityPoints(cityId) {
  const runtime = _cityRuntime.get(cityId);
  if (!runtime) return;
  if (_selectedKey && runtime.stationKeys.has(_selectedKey)) _clearSelection();
  for (const key of runtime.stationKeys) _stationRenderMap.delete(key);
  _cityRuntime.delete(cityId);
  _count = _stationRenderMap.size;
  scheduleRender();
}

function applyStatusToPoints(cityId, statusMap) {
  const runtime = _cityRuntime.get(cityId);
  if (!runtime) return;
  for (const key of runtime.stationKeys) {
    const record = _stationRenderMap.get(key);
    if (!record) continue;
    const status = statusMap.get(record.stationId) || null;
    const capacity = resolveCapacity(record.capacity, status);
    record.capacity = capacity;
    record.bikesAvailable = toNonNegativeInteger(status?.bikesAvailable);
    record.docksAvailable = toNonNegativeInteger(status?.docksAvailable);
    record.isInstalled = normalizeGbfsBool(status?.isInstalled, true);
    record.isRenting = normalizeGbfsBool(status?.isRenting, true);
    record.isReturning = normalizeGbfsBool(status?.isReturning, true);
    record.pixelSize = capacityToPixelSize(capacity);
    record.color = statusToColor(status, capacity);
  }
  scheduleRender();
  // Keep the selected card's numbers current.
  if (_selectedKey && runtime.stationKeys.has(_selectedKey)) {
    const entry = createBikeshareSelectedOverlayEntry(_selectedKey, _stationRenderMap.get(_selectedKey));
    if (entry) overlayHost().setEntries(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID, [entry], BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS);
  }
}
/**
 * Build a compact HUD detection ID string for a station.
 * Truncates long names to 24 chars for readability.
 * @param {Object} record - Render record from _stationRenderMap.
 * @returns {string} Formatted label like "Station Name [5/20]".
 */
function buildDetectionId(record) {
  const bikes = Number.isFinite(record.bikesAvailable) ? record.bikesAvailable : '?';
  const capacity = Number.isFinite(record.capacity) ? record.capacity : '?';
  // Render record stores the station name under `stationName` (see the render-map
  // shape), so `record.name` was always undefined → every label read "Dock N".
  const label = record.stationName || `Dock ${record.stationId}`;
  // Truncate long station names to keep HUD readable
  const short = label.length > 24 ? label.slice(0, 22) + '…' : label;
  return `🚲 ${short} [${bikes}/${capacity}]`;
}


function collectDetectableStations(options = {}) {
  if (!_enabled || _stationRenderMap.size === 0) return [];
  const records = [..._stationRenderMap.values()];
  const maxCount = Number.isFinite(options.maxCount)
    ? Math.max(1, Math.floor(options.maxCount))
    : records.length;
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
  const stride = Math.max(1, Math.ceil(records.length / maxCount));
  const start = ((seed % stride) + stride) % stride;
  const result = [];
  for (let i = start; i < records.length; i += stride) {
    const record = records[i];
    result.push({
      position: record.position,
      lon: record.position.lon,
      lat: record.position.lat,
      sourceId: record.key,
      id: buildDetectionId(record),
      type: 'VEH',
      skipLabel: record.key === _selectedKey,
    });
    if (result.length >= maxCount) break;
  }
  return result;
}

function getCameraAltitude() {
  return cameraAltitudeM(_engine);
}

/** Center of the view (look-at point), falling back to the camera position. */
function getCameraCenterLatLon() {
  const view = _engine?.getCameraView?.();
  if (!view) return null;
  if (Number.isFinite(view.targetLat) && Number.isFinite(view.targetLon)) {
    return { lat: view.targetLat, lon: view.targetLon };
  }
  if (Number.isFinite(view.lat) && Number.isFinite(view.lon)) return { lat: view.lat, lon: view.lon };
  return null;
}

function deactivateCity(cityId) {
  abortInFlight(_inFlightInfo, cityId);
  abortInFlight(_inFlightStatus, cityId);
  removeCityPoints(cityId);
}

function deactivateAllCities() {
  for (const cityId of Array.from(_activeCityIds)) deactivateCity(cityId);
  _activeCityIds.clear();
}

async function activateCity(cityId, generation) {
  if (!_enabled || !_activeCityIds.has(cityId)) return;
  try {
    const stationMap = await loadCityStationInfo(cityId, generation);
    if (!_enabled || !_activeCityIds.has(cityId) || generation !== _proximityGeneration) return;
    ensureCityPoints(cityId, stationMap);
    const cachedStatus = _statusCache.get(cityId)?.statusMap;
    if (cachedStatus) applyStatusToPoints(cityId, cachedStatus);
    const statusMap = await loadCityStationStatus(cityId, generation);
    if (!_enabled || !_activeCityIds.has(cityId) || generation !== _proximityGeneration) return;
    applyStatusToPoints(cityId, statusMap);
    _lastUpdate = Date.now();
    _error = null;
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.warn(`[Data:Bikeshare] ${cityId} activate error:`, error);
    _error = 'GBFS fetch error';
    deactivateCity(cityId);
    _activeCityIds.delete(cityId);
  } finally {
    _count = _stationRenderMap.size;
  }
}

async function runProximityCheck() {
  if (!_enabled || !_engine) return;
  const generation = ++_proximityGeneration;
  const altitude = getCameraAltitude();
  if (!shouldActivateAtAltitude(altitude)) {
    deactivateAllCities();
    return;
  }
  const center = getCameraCenterLatLon();
  if (!center) return;
  const nextActive = computeInRangeCities(center);
  for (const cityId of _activeCityIds) {
    if (!nextActive.has(cityId)) deactivateCity(cityId);
  }
  _activeCityIds = nextActive;
  if (_activeCityIds.size === 0) {
    _count = 0;
    return;
  }
  const toActivate = [];
  for (const cityId of _activeCityIds) {
    if (!_cityRuntime.has(cityId)) toActivate.push(cityId);
  }
  if (toActivate.length === 0) return;
  await Promise.all(toActivate.map((cityId) => activateCity(cityId, generation)));
}

function scheduleProximityCheck() {
  clearTimeout(_cameraDebounceTimer);
  _cameraDebounceTimer = setTimeout(() => {
    void runProximityCheck();
  }, CAMERA_DEBOUNCE_MS);
}

function onCameraChanged() {
  if (!_enabled) return;
  scheduleProximityCheck();
}

function _onKeyDown(e) {
  if (e.key === 'Escape' && _selectedKey) _clearSelection();
}

function wireEvents() {
  if (_offs.length || !_engine) return;
  _offs.push(_engine.on('moveend', onCameraChanged));
  _offs.push(_engine.on('click', (e) => {
    if (!_enabled || !_selectedKey) return;
    const hit = getActiveLayerHost()?.pickAt?.(e.x, e.y);
    // Clicked empty space (or another layer) — deselect; station clicks
    // select through the layer host.
    if (!hit || hit.def?.id !== BIKESHARE_LAYER_DEF.id) _clearSelection();
  }));
  if (typeof document !== 'undefined' && !_keyListenerBound) {
    document.addEventListener('keydown', _onKeyDown);
    _keyListenerBound = true;
  }
}

function unwireEvents() {
  for (const off of _offs) off?.();
  _offs = [];
  if (typeof document !== 'undefined' && _keyListenerBound) {
    document.removeEventListener('keydown', _onKeyDown);
    _keyListenerBound = false;
  }
}

/**
 * Bikeshare data layer (same interface as before; `engine` in place of `viewer`).
 */
const bikeshareLayer = {
  id: 'bikeshare',
  name: 'Bikeshare',
  icon: '🚲',
  source: 'GBFS',
  updateInterval: STATUS_POLL_MS,

  init(engine) {
    _engine = engine;
    _map = engine?.map || null;
    const host = getActiveLayerHost();
    host?.register(BIKESHARE_LAYER_DEF);
    host?.ensureAdded(BIKESHARE_LAYER_DEF);

    _enabled = false;
    _cameraDebounceTimer = null;
    _altitudeGateEnabled = false;
    _proximityGeneration = 0;
    _activeCityIds = new Set();
    _cityRuntime = new Map();
    _stationInfoCache = new Map();
    _statusCache = new Map();
    _inFlightInfo = new Map();
    _inFlightStatus = new Map();
    _stationRenderMap = new Map();
    _selectedKey = null;
    _count = 0;
    _lastUpdate = null;
    _loading = false;
    _loadingOps = 0;
    _error = null;
    _limitWarned = false;

    overlayHost().setVisible(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID, false);
    console.log(`[Data:Bikeshare] Initialized with ${GBFS_CITY_REGISTRY.length} cities`);
    return true;
  },

  enable() {
    _enabled = true;
    _error = null;
    getActiveLayerHost()?.setVisible(BIKESHARE_LAYER_DEF.id, true);
    overlayHost().setVisible(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID, true);
    wireEvents();
    void runProximityCheck();
    return true;
  },

  disable() {
    _enabled = false;
    _proximityGeneration++;
    _altitudeGateEnabled = false;
    clearTimeout(_cameraDebounceTimer);
    _cameraDebounceTimer = null;
    _clearSelection();
    overlayHost().setVisible(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID, false);
    unwireEvents();
    abortAllInFlight();
    deactivateAllCities();
    _cityRuntime.clear();
    _stationRenderMap.clear();
    getActiveLayerHost()?.setVisible(BIKESHARE_LAYER_DEF.id, false);
    scheduleRender();
    _count = 0;
    _loading = false;
    _loadingOps = 0;
    return true;
  },

  async update() {
    if (!_enabled || _activeCityIds.size === 0) return true;
    const generation = _proximityGeneration;
    const cityIds = Array.from(_activeCityIds);
    await Promise.all(cityIds.map(async (cityId) => {
      try {
        const statusMap = await loadCityStationStatus(cityId, generation);
        if (!_enabled || !_activeCityIds.has(cityId) || generation !== _proximityGeneration) return;
        applyStatusToPoints(cityId, statusMap);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.warn(`[Data:Bikeshare] ${cityId} status update error:`, error);
        _error = 'GBFS status update failed';
      }
    }));
    _count = _stationRenderMap.size;
    if (_count > 0) _lastUpdate = Date.now();
    return true;
  },

  /** @returns {Array<{position:{lon:number,lat:number,height:number}, lon:number, lat:number, sourceId:string, id:string, type:string, skipLabel:boolean}>} */
  getDetectableObjects(options = {}) {
    return collectDetectableStations(options);
  },

  getStats() {
    const stats = {
      count: _count,
      lastUpdate: _lastUpdate,
      loading: _loading,
    };
    if (_loading) {
      stats.loadingLabel = _activeCityIds.size > 0
        ? `syncing ${_activeCityIds.size} city feeds...`
        : 'scanning nearby systems...';
    }
    if (_error) stats.error = _error;
    return stats;
  },

  destroy() {
    if (_enabled) this.disable();
    else {
      _clearSelection();
      overlayHost().setVisible(BIKESHARE_SELECTED_OVERLAY_SOURCE_ID, false);
      unwireEvents();
    }
    abortAllInFlight();
    _engine = null;
    _map = null;
    return true;
  },
};

/** Test seam: primes the selection state with one record and an overlay host. */
export function _setBikeshareSelectionStateForTest({ engine = null, viewer = null, key, record, overlayHost: host }) {
  _engine = engine || viewer;
  _map = _engine?.map || null;
  _stationRenderMap = new Map([[key, record]]);
  _selectedKey = null;
  _overlayHostOverride = host || null;
}

export function _selectBikeshareStationForTest(key) {
  _selectStation(key);
}

export function _clearBikeshareSelectionForTest() {
  _clearSelection();
  _overlayHostOverride = null;
}

/** Test seam: the currently selected station key. */
export function _selectedBikeshareKeyForTest() {
  return _selectedKey;
}

export default bikeshareLayer;
