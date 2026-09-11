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
  let _coberturaSource = null;
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
          color: Cesium.Color.fromCssColorString(klass.color).withAlpha(0.9),
          outlineWidth: 0,
          // 5,8 mil pontos viram uma mancha solida na escala estadual; encolher
          // com a distancia preserva a leitura de DENSIDADE, que e a informacao
          // util de longe, e devolve o ponto individual de perto.
          scaleByDistance: new Cesium.NearFarScalar(2.0e4, 1.6, 1.2e6, 0.45),
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

  async function carregarCobertura() {
    if (_coberturaSource) return;
    const resp = await fetch(COBERTURA_URL);
    if (!resp.ok) throw new Error(`cobertura HTTP ${resp.status}`);
    const geojson = await resp.json();
    _areaKm2 = Number(geojson.areaKm2) || null;
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
      for (const source of [_torresSource, _coberturaSource]) {
        if (source) viewer?.dataSources?.remove(source, true);
      }
      _torresSource = null;
      _coberturaSource = null;
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
