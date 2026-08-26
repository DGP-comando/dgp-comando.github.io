// src/data/datageoTerritorios.js
//
// Territórios tradicionais (classe Limites):
//   - Terras indígenas: FUNAI/CMR via seed do valor-de-terras (57
//     polígonos, todas as etapas de regularização).
//   - Territórios quilombolas: malha OFICIAL do Censo 2022 (IBGE, 2ª
//     apuração), 10 territórios delimitados no PR, com fase (PORTARIA/
//     RTID/DECRETO/TITULADO).
//
// GeoJSONs de scripts/build_territorios.py. Polígonos clamped com fill
// translúcido + borda por anel externo (mesma técnica da camada de
// municípios: GroundPrimitive não suporta outline) + label no centroide.

import * as Cesium from 'cesium';

function centroidOf(rings) {
  // centroide simples do anel externo (suficiente para ancorar label)
  const ring = rings[0] ?? [];
  let sx = 0;
  let sy = 0;
  for (const [lon, lat] of ring) {
    sx += lon;
    sy += lat;
  }
  return ring.length ? [sx / ring.length, sy / ring.length] : null;
}

function makeTerritorioLayer({ id, name, icon, source, url, cssColor, labelOf, labelMaxDist }) {
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  const fill = Cesium.Color.fromCssColorString(cssColor).withAlpha(0.25);
  const border = Cesium.Color.fromCssColorString(cssColor).withAlpha(0.75);

  return {
    id,
    name,
    category: 'Limites',
    icon,
    source,
    updateInterval: 24 * 3600_000,

    init() {
      console.log(`[Data:${id}] Initialized`);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      try {
        if (!_dataSource) {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const gj = await resp.json();
          _dataSource = new Cesium.CustomDataSource(id);
          let n = 0;
          for (const f of gj.features ?? []) {
            const geom = f.geometry;
            if (!geom) continue;
            const polys = geom.type === 'Polygon'
              ? [geom.coordinates]
              : geom.type === 'MultiPolygon' ? geom.coordinates : [];
            const props = f.properties ?? {};
            let labeled = false;
            for (const rings of polys) {
              const outer = rings[0];
              if (!outer || outer.length < 4) continue;
              const positions = outer.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
              _dataSource.entities.add({
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(
                    positions,
                    (rings.slice(1) || []).map((hole) =>
                      new Cesium.PolygonHierarchy(
                        hole.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
                      )),
                  ),
                  material: new Cesium.ColorMaterialProperty(fill),
                  classificationType: Cesium.ClassificationType.TERRAIN,
                },
              });
              _dataSource.entities.add({
                polyline: {
                  positions: [...positions, positions[0]],
                  clampToGround: true,
                  width: 1.6,
                  material: new Cesium.ColorMaterialProperty(border),
                },
              });
              if (!labeled) {
                const c = centroidOf(rings);
                if (c) {
                  _dataSource.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(c[0], c[1]),
                    label: {
                      text: labelOf(props),
                      font: '11px "JetBrains Mono", monospace',
                      fillColor: Cesium.Color.fromCssColorString(cssColor),
                      outlineColor: Cesium.Color.BLACK,
                      outlineWidth: 2,
                      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                      disableDepthTestDistance: Number.POSITIVE_INFINITY,
                      distanceDisplayCondition:
                        new Cesium.DistanceDisplayCondition(0, labelMaxDist),
                    },
                  });
                  labeled = true;
                }
              }
            }
            n += 1;
          }
          _count = n;
          _dataSource.show = _enabled;
          await viewer.dataSources.add(_dataSource);
        }
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:${id}] ${_count} territorios`);
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn(`[Data:${id}]`, err);
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}

const fmtHa = (ha) => (ha ? ` · ${Math.round(ha).toLocaleString('pt-BR')} ha` : '');

export const datageoTerrasIndigenasLayer = makeTerritorioLayer({
  id: 'datageo-terras-indigenas',
  name: 'Terras indígenas',
  icon: '🪶',
  source: 'FUNAI/CMR',
  url: '/data/terras-indigenas-pr.geojson',
  cssColor: '#fb923c',
  // O nome da FUNAI ja vem prefixado ("TI Marrecas") — nao duplicar.
  labelOf: (p) => `${String(p.nome).startsWith('TI ') ? '' : 'TI '}${p.nome}${fmtHa(p.area_ha)}`,
  labelMaxDist: 600_000,
});

export const datageoQuilombolasLayer = makeTerritorioLayer({
  id: 'datageo-quilombolas',
  name: 'Territórios quilombolas',
  icon: '🏘️',
  source: 'IBGE Censo 2022',
  url: '/data/quilombolas-pr.geojson',
  cssColor: '#c084fc',
  labelOf: (p) => `TQ ${p.nome}${p.fase ? ` (${p.fase})` : ''}`,
  labelMaxDist: 1_600_000,
});

export const DATAGEO_TERRITORIOS_LAYERS = [
  datageoTerrasIndigenasLayer,
  datageoQuilombolasLayer,
];
