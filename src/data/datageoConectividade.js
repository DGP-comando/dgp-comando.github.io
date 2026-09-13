// src/data/datageoConectividade.js
//
// Conectividade do Parana: as ERBs (torres) e o NEGATIVO da cobertura movel —
// a area sem 3G ou superior, que e onde o programa ParanaConectado precisa
// chegar. As duas metades vivem na mesma camada porque so fazem sentido juntas:
// a mancha cinza diz onde nao ha sinal, e os pontos dizem de onde o sinal sai.
//
// Dados gerados por scripts/build_conectividade.py a partir do acervo do
// IDR-Parana (levantamento sobre o licenciamento ANATEL). O levantamento tem
// DATA, e ela e mostrada na linha do painel: um mapa de cobertura sem data
// engana mais do que informa.

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { createCachedFactory, createReadyPump } from './entityDiff.js';

const TORRES_URL = '/data/conectividade-torres.json';
const COBERTURA_URL = '/data/conectividade-sem-cobertura.geojson';

/**
 * Cor por geracao mais alta da torre. A familia verde/lima esta livre no app:
 * ciano e dos municipios e do vento, violeta da precipitacao, ambar do militar
 * e das rodovias, e a rampa quente do FIRMS. A geracao mais nova e a mais
 * clara, para a leitura "onde ja chegou o 5G" saltar sem legenda.
 */
const TEC_CLASSES = Object.freeze([
  Object.freeze({ key: '5G', bit: 8, label: '5G', color: '#a3e635' }),
  Object.freeze({ key: '4G', bit: 4, label: '4G', color: '#4ade80' }),
  Object.freeze({ key: '3G', bit: 2, label: '3G', color: '#15803d' }),
  Object.freeze({ key: '2G', bit: 1, label: '2G', color: '#71717a' }),
]);
/** Torre sem tecnologia declarada. Existe na base, entao tem cor propria. */
const TEC_INDEFINIDA = Object.freeze({ key: 'na', label: 'SEM INFO', color: '#52525b' });

/**
 * A ausencia de cobertura e desenhada em ardosia neutra de proposito: nao e um
 * fenomeno com intensidade, e um VAZIO. Qualquer cor tematica (vermelho de
 * risco, ambar de alerta) sugeriria severidade que o dado nao mede, alem de
 * colidir com camadas que ja usam essas familias.
 */
const SEM_COBERTURA_FILL = Cesium.Color.fromCssColorString('#64748b').withAlpha(0.22);
const SEM_COBERTURA_LINE = Cesium.Color.fromCssColorString('#94a3b8').withAlpha(0.45);

// Uma Color por classe de torre (5,8 mil torres, 5 classes), nao uma por torre.
const corDaClasse = createCachedFactory(
  (css) => Cesium.Color.fromCssColorString(css).withAlpha(0.9),
  (css) => css,
);
// 5,8 mil pontos viram uma mancha solida na escala estadual; encolher com a
// distancia preserva a leitura de DENSIDADE, que e a informacao util de longe,
// e devolve o ponto individual de perto. Imutavel: uma instancia para todas.
const TORRE_SCALE = new Cesium.NearFarScalar(2.0e4, 1.6, 1.2e6, 0.45);

/**
 * Aneis de poligono (GeoJSON Polygon/MultiPolygon) com pelo menos um anel
 * externo utilizavel. Puro: sem Cesium, testavel.
 * @param {object|null|undefined} geometry
 * @returns {Array<Array<Array<[number, number]>>>}
 */
export function poligonosDaGeometria(geometry) {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return (polys ?? []).filter((rings) => Array.isArray(rings?.[0]) && rings[0].length >= 3);
}

function anelParaCartesianos(ring) {
  const flat = new Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    flat[i * 2] = ring[i][0];
    flat[i * 2 + 1] = ring[i][1];
  }
  return Cesium.Cartesian3.fromDegreesArray(flat);
}

/**
 * Um unico GroundPrimitive com todos os poligonos sem cobertura, no lugar de
 * ~1.100 entidades clamped. Mesmo visual do GeoJsonDataSource anterior: fill
 * plano translucido por instancia, arcos RHUMB, classificacao BOTH (o outline
 * do GeoJSON nunca era desenhado: poligono clamped nao tem outline no Cesium).
 * @param {object} geojson
 * @returns {{primitive: Cesium.GroundPrimitive|null, poligonos: number}}
 */
function criarPrimitiveCobertura(geojson) {
  const instances = [];
  for (const feature of geojson.features ?? []) {
    for (const rings of poligonosDaGeometria(feature?.geometry)) {
      const holes = rings.slice(1)
        .filter((hole) => Array.isArray(hole) && hole.length >= 3)
        .map((hole) => new Cesium.PolygonHierarchy(anelParaCartesianos(hole)));
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(anelParaCartesianos(rings[0]), holes),
          arcType: Cesium.ArcType.RHUMB,
          vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(SEM_COBERTURA_FILL),
        },
      }));
    }
  }
  if (instances.length === 0) return { primitive: null, poligonos: 0 };
  const primitive = new Cesium.GroundPrimitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
    classificationType: Cesium.ClassificationType.BOTH,
    // Ninguem faz pick na mancha de cobertura: poupa memoria de GPU.
    allowPicking: false,
    asynchronous: true,
  });
  return { primitive, poligonos: instances.length };
}

/**
 * Classe da torre a partir da mascara de bits gravada pelo gerador.
 * @param {number} mask
 * @returns {{key: string, label: string, color: string}}
 */
export function classeDaTorre(mask) {
  const bits = Number(mask) || 0;
  for (const klass of TEC_CLASSES) {
    if (bits & klass.bit) return klass;
  }
  return TEC_INDEFINIDA;
}

/**
 * Legenda no contrato do painel (`{label, color, count}`), na ordem da escala e
 * sem classes vazias.
 * @param {Record<string, number>} counts
 * @returns {Array<{label: string, color: string, count: number}>}
 */
export function conectividadeLegend(counts) {
  return [...TEC_CLASSES, TEC_INDEFINIDA]
    .filter((klass) => (counts?.[klass.key] || 0) > 0)
    .map((klass) => ({ label: klass.label, color: klass.color, count: counts[klass.key] }));
}

export const datageoConectividadeLayer = (() => {
  let _viewer = null;
  let _torresSource = null;
  // Cobertura: GroundPrimitive em lote (caminho normal) OU GeoJsonDataSource
  // (fallback quando o contexto WebGL nao suporta ground primitives).
  let _coberturaPrimitive = null;
  let _coberturaSource = null;
  let _coberturaPump = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _legend = [];
  let _vintage = null;
  let _areaKm2 = null;

  function aplicarVisibilidade() {
    if (_torresSource) _torresSource.show = _enabled;
    if (_coberturaSource) _coberturaSource.show = _enabled;
    if (_coberturaPrimitive) _coberturaPrimitive.show = _enabled;
    // O GroundPrimitive so progride quando ha frames: no requestRenderMode do
    // governor alguem precisa pedi-los ate ele ficar pronto.
    if (_enabled && _coberturaPrimitive && !_coberturaPrimitive.ready) _coberturaPump?.start();
    else _coberturaPump?.stop();
  }

  function pararPump() {
    _coberturaPump?.stop();
    _coberturaPump = null;
  }

  async function carregarTorres() {
    if (_torresSource) return;
    const resp = await fetch(TORRES_URL);
    if (!resp.ok) throw new Error(`torres HTTP ${resp.status}`);
    const data = await resp.json();
    _vintage = data.geradoDe || null;

    const source = new Cesium.CustomDataSource('datageo-conectividade-torres');
    const counts = {};
    for (const [lat, lon, , mask] of data.torres) {
      const klass = classeDaTorre(mask);
      counts[klass.key] = (counts[klass.key] || 0) + 1;
      source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 4,
          color: corDaClasse(klass.color),
          outlineWidth: 0,
          scaleByDistance: TORRE_SCALE,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    _count = data.torres.length;
    _legend = conectividadeLegend(counts);
    source.show = _enabled;
    await _viewer.dataSources.add(source);
    _torresSource = source;
  }

  function groundPrimitivesSuportados() {
    try {
      return Boolean(_viewer?.scene?.groundPrimitives)
        && Cesium.GroundPrimitive.isSupported(_viewer.scene);
    } catch {
      return false;
    }
  }

  async function carregarCobertura() {
    if (_coberturaSource || _coberturaPrimitive) return;
    const resp = await fetch(COBERTURA_URL);
    if (!resp.ok) throw new Error(`cobertura HTTP ${resp.status}`);
    const geojson = await resp.json();
    _areaKm2 = Number(geojson.areaKm2) || null;
    // destroy() ou outro update podem ter rodado durante os awaits.
    if (!_viewer || _coberturaSource || _coberturaPrimitive) return;
    if (groundPrimitivesSuportados()) {
      const { primitive } = criarPrimitiveCobertura(geojson);
      if (!primitive) return;
      primitive.show = _enabled;
      _viewer.scene.groundPrimitives.add(primitive);
      _coberturaPrimitive = primitive;
      _coberturaPump = createReadyPump({
        isReady: () => !_coberturaPrimitive || _coberturaPrimitive.isDestroyed?.() || _coberturaPrimitive.ready,
        requestRender: () => governorRequestRender('datageo-conectividade:cobertura'),
      });
      return;
    }
    const source = await Cesium.GeoJsonDataSource.load(geojson, {
      clampToGround: true,
      fill: SEM_COBERTURA_FILL,
      stroke: SEM_COBERTURA_LINE,
      strokeWidth: 1,
    });
    source.name = 'datageo-conectividade-cobertura';
    source.show = _enabled;
    await _viewer.dataSources.add(source);
    _coberturaSource = source;
  }

  return {
    id: 'datageo-conectividade',
    name: 'Conectividade',
    category: 'Infraestrutura',
    icon: '📡',
    source: 'IDR-PR · ANATEL',
    // O levantamento e um acervo estatico: nao ha o que repolir de hora em hora.
    updateInterval: 24 * 3600_000,

    init(viewer) {
      _viewer = viewer;
      console.log('[Data:datageo-conectividade] Initialized');
    },

    enable() {
      _enabled = true;
      aplicarVisibilidade();
      governorRequestRender('datageo-conectividade');
    },

    disable() {
      _enabled = false;
      aplicarVisibilidade();
      governorRequestRender('datageo-conectividade');
    },

    async update() {
      try {
        await Promise.all([carregarTorres(), carregarCobertura()]);
        aplicarVisibilidade();
        _lastUpdate = Date.now();
        _lastError = null;
        governorRequestRender('datageo-conectividade');
        console.log(
          `[Data:datageo-conectividade] ${_count} torres; `
          + `${_areaKm2 ? Math.round(_areaKm2).toLocaleString('pt-BR') : '?'} km2 sem 3G+`,
        );
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-conectividade]', err);
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      pararPump();
      for (const source of [_torresSource, _coberturaSource]) {
        if (source) viewer?.dataSources?.remove(source, true);
      }
      if (_coberturaPrimitive) {
        const ground = (viewer ?? _viewer)?.scene?.groundPrimitives;
        try {
          if (ground?.contains?.(_coberturaPrimitive)) ground.remove(_coberturaPrimitive);
          else if (!_coberturaPrimitive.isDestroyed?.()) _coberturaPrimitive.destroy?.();
        } catch (err) {
          console.warn('[Data:datageo-conectividade] remover cobertura:', err);
        }
      }
      _torresSource = null;
      _coberturaSource = null;
      _coberturaPrimitive = null;
      _viewer = null;
      _legend = [];
    },

    getRowControls() {
      return { chips: [], legend: _legend };
    },

    getStats() {
      const partes = [];
      if (_areaKm2) partes.push(`${Math.round(_areaKm2).toLocaleString('pt-BR')} km² sem 3G+`);
      if (_vintage) partes.push(`levantamento ${_vintage}`);
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // A DATA do levantamento vai na linha do painel de propósito: cobertura
        // sem vintage é a informação mais fácil de ler errado desta camada.
        source: partes.length ? `IDR-PR · ANATEL · ${partes.join(' · ')}` : 'IDR-PR · ANATEL',
      };
    },
  };
})();
