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
import { escapeHtml as esc } from './vesselTooltip.js';

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

const fmtHa = (ha) => (ha ? ` · ${Math.round(ha).toLocaleString('pt-BR')} ha` : '');
const fmtInt = (v) => Math.round(Number(v)).toLocaleString('pt-BR');

/** Tooltip padrão: título, linhas "rótulo: valor" (vazias somem) e fonte. */
function tooltipHtml(titulo, linhas, fonte) {
  const corpo = linhas
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `<div><span class="vt-dim">${esc(k)}:</span> ${esc(v)}</div>`)
    .join('');
  return `<div class="vt-nome">${esc(titulo)}</div>${corpo}<div class="vt-fontes">${esc(fonte)}</div>`;
}
const areaHa = (ha) => (Number(ha) > 0 ? `${fmtInt(ha)} ha` : '');
const nomeTi = (p) => `${String(p.nome).startsWith('TI ') ? '' : 'TI '}${p.nome}`;

export const datageoTerrasIndigenasLayer = makeTerritorioLayer({
  id: 'datageo-terras-indigenas',
  name: 'Terras indígenas',
  icon: '🪶',
  source: 'FUNAI/CMR',
  url: '/data/terras-indigenas-pr.geojson',
  cssColor: '#fb923c',
  // O nome da FUNAI ja vem prefixado ("TI Marrecas") — nao duplicar.
  labelOf: (p) => `${nomeTi(p)}${fmtHa(p.area_ha)}`,
  labelMaxDist: 600_000,
  tooltipOf: (p) => tooltipHtml(nomeTi(p), [
    ['Etapa', p.etapa],
    ['Área', areaHa(p.area_ha)],
  ], 'FUNAI/CMR'),
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
  tooltipOf: (p) => tooltipHtml(`Território quilombola ${p.nome}`, [
    ['Município', p.municipio],
    ['Fase', p.fase],
  ], 'IBGE, Censo 2022'),
});

const fmtFamilias = (n) => (Number(n) > 0 ? ` · ${Math.round(n).toLocaleString('pt-BR')} famílias` : '');

export const datageoAssentamentosLayer = makeTerritorioLayer({
  id: 'datageo-assentamentos',
  name: 'Assentamentos (INCRA)',
  icon: '🌾',
  source: 'INCRA/SIPRA',
  url: '/data/assentamentos-incra-pr.geojson',
  cssColor: '#a3e635',
  // 311 projetos no PR: rótulo só perto para não virar tapete de texto.
  labelOf: (p) => `${p.nome}${fmtFamilias(p.familias)}`,
  tooltipOf: (p) => tooltipHtml(p.nome, [
    ['Município', p.municipio],
    ['Área', areaHa(p.area_ha)],
    ['Famílias', Number(p.familias) > 0 ? `${fmtInt(p.familias)} de ${fmtInt(p.capacidade)} de capacidade` : ''],
    ['Fase', p.fase],
    ['Criação', p.criacao],
    ['Obtenção', p.obtencao],
    ['Código SIPRA', p.codigo],
  ], 'INCRA/SIPRA'),
  labelMaxDist: 80_000,
});

/**
 * "RESERVA BIOLÓGICA DAS PEROBAS" -> "Reserva Biológica das Perobas": o CNUC
 * grava em caixa alta, e rótulo em caixa alta no globo pesa demais.
 */
export function tituloUc(nome) {
  const minusculas = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
  return String(nome ?? '')
    .toLocaleLowerCase('pt-BR')
    .split(/\s+/)
    .map((w, i) => (i > 0 && minusculas.has(w) ? w : w.charAt(0).toLocaleUpperCase('pt-BR') + w.slice(1)))
    .join(' ');
}

export const datageoUcsFederaisLayer = makeTerritorioLayer({
  id: 'datageo-ucs-federais',
  name: 'Unidades de conservação federais',
  icon: '🌳',
  source: 'MMA/CNUC · ICMBio',
  url: '/data/ucs-federais-pr.geojson',
  cssColor: '#34d399',
  category: 'Ambiente',
  labelOf: (p) => `${tituloUc(p.nome)}${fmtHa(p.area_ha)}`,
  labelMaxDist: 400_000,
});

export const datageoUcsEstaduaisLayer = makeTerritorioLayer({
  id: 'datageo-ucs-estaduais',
  name: 'Unidades de conservação estaduais',
  icon: '🌲',
  source: 'MMA/CNUC · IAT',
  url: '/data/ucs-estaduais-pr.geojson',
  cssColor: '#2dd4bf',
  category: 'Ambiente',
  labelOf: (p) => `${tituloUc(p.nome)}${fmtHa(p.area_ha)}`,
  labelMaxDist: 400_000,
});

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

export const datageoRegionaisIdrLayer = makeTerritorioLayer({
  id: 'datageo-regionais-idr',
  name: 'Regionais do IDR',
  icon: '🗺️',
  source: 'IDR-Paraná',
  url: '/data/regionais-idr-pr.geojson',
  cssColor: '#34d399',
  fillAlpha: 0.12,
  labelOf: (p) => `IDR ${p.regional}`,
  labelMaxDist: 1_800_000,
  tooltipOf: (p) => tooltipHtml(`Regional ${p.regional}`, [
    ['Municípios', fmtInt(p.municipios.length)],
    ['Ficha', 'clique para abrir a ficha regional'],
  ], 'IDR-Paraná'),
  onClick: (p) => openFichaRegiao({
    nome: `Regional ${p.regional}`,
    meta: `IDR-Paraná · ${plural(p.municipios.length, 'município', 'municípios')}`,
    ibges: p.municipios,
  }),
});

// Quase só contorno: 27 municípios estão em duas associações, e os polígonos
// se sobrepõem; preenchimento empilhado ficaria ilegível. O alfa mínimo existe
// para o polígono ser "pickado" pelo tooltip.
export const datageoAssociacoesLayer = makeTerritorioLayer({
  id: 'datageo-associacoes',
  name: 'Associações de municípios',
  icon: '🤝',
  source: 'SECID-PR',
  url: '/data/associacoes-pr.geojson',
  cssColor: '#f472b6',
  fillAlpha: 0.02,
  labelOf: (p) => p.sigla,
  labelMaxDist: 1_800_000,
  tooltipOf: (p) => tooltipHtml(p.sigla, [
    ['Nome', p.nome],
    ['Municípios', fmtInt(p.municipios.length)],
  ], 'SECID-PR'),
});

export const DATAGEO_TERRITORIOS_LAYERS = [
  datageoTerrasIndigenasLayer,
  datageoQuilombolasLayer,
  datageoAssentamentosLayer,
  datageoUcsFederaisLayer,
  datageoUcsEstaduaisLayer,
  datageoRegionaisIdrLayer,
  datageoAssociacoesLayer,
];
