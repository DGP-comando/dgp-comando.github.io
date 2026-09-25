// src/data/datageoTerritorios.js
//
// Áreas protegidas e territórios em polígono.
//
// Classe Limites: assentamentos da reforma agrária (INCRA/SIPRA, 311 no PR).
// Classe Ambiente: unidades de conservação federais e estaduais (MMA/CNUC).
// GeoJSONs de scripts/build_limites_ambientais.py.
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
import { openFichaRegiao } from '../datageoFicha.js';
import { createEntityHoverTooltip } from './entityHoverTooltip.js';
// Rótulos, tooltips e centroide ficam num módulo sem Cesium (o protótipo
// MapLibre usa a mesma especificação).
import { centroidOf, fichaRegionalIdr, TERRITORIO_SPECS, tituloUc } from './territoriosSpec.js';

export { tituloUc };

function makeTerritorioLayer({
  id, name, icon, source, url, cssColor, labelOf, labelMaxDist, category = 'Limites',
  fillAlpha = 0.25, onClick = null, tooltipOf = null,
}) {
  let _dataSource = null;
  let _handler = null;
  let _tooltip = null;
  let _props = [];
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  const fill = Cesium.Color.fromCssColorString(cssColor).withAlpha(fillAlpha);
  const border = Cesium.Color.fromCssColorString(cssColor).withAlpha(0.75);
  // Imutaveis e iguais para todos os poligonos da camada: uma instancia so.
  const labelFill = Cesium.Color.fromCssColorString(cssColor);
  const labelCondition = new Cesium.DistanceDisplayCondition(0, labelMaxDist);

  return {
    id,
    name,
    category,
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
      _tooltip?.hide();
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      try {
        if (!_dataSource) {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const gj = await resp.json();
          _dataSource = new Cesium.CustomDataSource(id);
          // Materiais compartilhados: o batch de geometria clamped do Cesium
          // agrupa por material, e nada aqui os altera depois do load.
          const fillMaterial = new Cesium.ColorMaterialProperty(fill);
          const borderMaterial = new Cesium.ColorMaterialProperty(border);
          let n = 0;
          _props = [];
          for (const f of gj.features ?? []) {
            const geom = f.geometry;
            if (!geom) continue;
            const polys = geom.type === 'Polygon'
              ? [geom.coordinates]
              : geom.type === 'MultiPolygon' ? geom.coordinates : [];
            const props = f.properties ?? {};
            _props.push(props);
            let labeled = false;
            for (const rings of polys) {
              const outer = rings[0];
              if (!outer || outer.length < 4) continue;
              const positions = outer.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
              _dataSource.entities.add({
                // id para clique/hover: `${id}:<indice da feature>:<parte>`
                id: `${id}:${n}:${_dataSource.entities.values.length}`,
                properties: props,
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(
                    positions,
                    (rings.slice(1) || []).map((hole) =>
                      new Cesium.PolygonHierarchy(
                        hole.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
                      )),
                  ),
                  material: fillMaterial,
                  classificationType: Cesium.ClassificationType.TERRAIN,
                },
              });
              _dataSource.entities.add({
                polyline: {
                  positions: [...positions, positions[0]],
                  clampToGround: true,
                  width: 1.6,
                  material: borderMaterial,
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
                      fillColor: labelFill,
                      outlineColor: Cesium.Color.BLACK,
                      outlineWidth: 2,
                      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                      disableDepthTestDistance: Number.POSITIVE_INFINITY,
                      distanceDisplayCondition: labelCondition,
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
          if (tooltipOf && !_tooltip) {
            // drill: o polígono fica sob o preenchimento dos municípios, e o
            // hover do município cede a vez (drillHoverAt).
            _tooltip = createEntityHoverTooltip({
              viewer,
              idPrefix: `${id}:`,
              render: tooltipOf,
              isActive: () => Boolean(_dataSource?.show),
              drill: true,
            });
          }
          if (onClick && !_handler) {
            _handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
            _handler.setInputAction((click) => {
              if (!_dataSource?.show) return;
              // drillPick: o polígono do município fica por cima do da camada.
              const pickId = viewer.scene.drillPick(click.position, 8)
                .map((p) => p?.id?.id)
                .find((pid) => typeof pid === 'string' && pid.startsWith(`${id}:`));
              const props = pickId && _props[Number(pickId.split(':')[1])];
              // Depois dos handlers síncronos: com a camada ligada, o clique é
              // desta camada (o card dela sobrepõe a ficha do município).
              if (props) setTimeout(() => onClick(props), 0);
            }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
          }
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
      _handler?.destroy();
      _handler = null;
      _tooltip?.destroy();
      _tooltip = null;
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

export const datageoTerrasIndigenasLayer = makeTerritorioLayer(TERRITORIO_SPECS.terrasIndigenas);

export const datageoQuilombolasLayer = makeTerritorioLayer(TERRITORIO_SPECS.quilombolas);

export const datageoAssentamentosLayer = makeTerritorioLayer(TERRITORIO_SPECS.assentamentos);

export const datageoUcsFederaisLayer = makeTerritorioLayer(TERRITORIO_SPECS.ucsFederais);

export const datageoUcsEstaduaisLayer = makeTerritorioLayer(TERRITORIO_SPECS.ucsEstaduais);

export const datageoRegionaisIdrLayer = makeTerritorioLayer({
  ...TERRITORIO_SPECS.regionaisIdr,
  onClick: (p) => openFichaRegiao(fichaRegionalIdr(p)),
});

export const datageoAssociacoesLayer = makeTerritorioLayer(TERRITORIO_SPECS.associacoes);

export const DATAGEO_TERRITORIOS_LAYERS = [
  datageoTerrasIndigenasLayer,
  datageoQuilombolasLayer,
  datageoAssentamentosLayer,
  datageoUcsFederaisLayer,
  datageoUcsEstaduaisLayer,
  datageoRegionaisIdrLayer,
  datageoAssociacoesLayer,
];
