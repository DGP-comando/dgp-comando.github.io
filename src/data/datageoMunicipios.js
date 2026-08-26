// src/data/datageoMunicipios.js
//
// Camada de municipios do PR: 399 poligonos (municipios-pr.geojson) com
// HOVER TOOLTIP mostrando prefeito atual (com partido), variacao do VBP de
// lavouras entre os dois ultimos anos da PAM e a lavoura de maior valor.
//
// Os dados do tooltip vem de public/data/municipios-info.json, gerado por
// scripts/build_municipios_info.py (TSE resultados 2024 + IBGE/SIDRA PAM
// t5457 v215). Regenerar o JSON quando sair nova PAM ou houver troca de
// prefeito (cassacao/suplementar).
//
// Interacao: poligonos clamped no terreno com fill quase invisivel (so para
// picking); MOUSE_MOVE com throttle destaca o municipio sob o cursor e
// posiciona um tooltip DOM junto ao mouse. O handler e proprio da camada e
// ignora entidades de outras fontes, entao nao conflita com o picking
// nativo do GEV (avioes, focos etc.).

import * as Cesium from 'cesium';
import { openFicha } from '../datageoFicha.js';

const GEOJSON_URL = '/data/municipios-pr.geojson';
const INFO_URL = '/data/municipios-info.json';

const IDLE_COLOR = Cesium.Color.CYAN.withAlpha(0.03);
// Contorno permanente "queimado" sobre o satelite. Poligono clamped nao
// suporta outline no Cesium (limitacao de GroundPrimitive), entao as bordas
// sao polylines clamped geradas do anel externo de cada municipio no load.
const BORDER_COLOR = Cesium.Color.CYAN.withAlpha(0.32);
const BORDER_WIDTH = 1.4;
const HOVER_COLOR = Cesium.Color.CYAN.withAlpha(0.22);
const HOVER_THROTTLE_MS = 40;

function injectStyles() {
  if (document.getElementById('datageo-muni-tooltip-style')) return;
  const style = document.createElement('style');
  style.id = 'datageo-muni-tooltip-style';
  style.textContent = `
    #datageo-muni-tooltip {
      position: fixed;
      display: none;
      max-width: 300px;
      padding: 10px 12px;
      background: rgba(3, 10, 18, 0.92);
      border: 1px solid rgba(34, 211, 238, 0.35);
      border-radius: 6px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      line-height: 1.5;
      color: #cbd5e1;
      z-index: 90;
      pointer-events: none;
      white-space: nowrap;
    }
    #datageo-muni-tooltip .mt-nome {
      color: #22d3ee;
      font-weight: 700;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    #datageo-muni-tooltip .mt-up { color: #22c55e; }
    #datageo-muni-tooltip .mt-down { color: #ef4444; }
    #datageo-muni-tooltip .mt-dim { color: #64748b; }
    #datageo-muni-tooltip .mt-fontes {
      margin-top: 6px;
      color: #475569;
      font-size: 9px;
      letter-spacing: 0.04em;
    }
  `;
  document.head.appendChild(style);
}

const fmtBRL = (reais) => {
  if (reais >= 1e9) return `R$ ${(reais / 1e9).toFixed(1).replace('.', ',')} bi`;
  if (reais >= 1e6) return `R$ ${(reais / 1e6).toFixed(1).replace('.', ',')} mi`;
  return `R$ ${Math.round(reais).toLocaleString('pt-BR')}`;
};

function tooltipHtml(nome, info) {
  const lines = [`<div class="mt-nome">${nome}</div>`];

  if (info?.prefeito) {
    lines.push(`Prefeito: ${info.prefeito} <span class="mt-dim">(${info.partido})</span>`);
  } else {
    lines.push('Prefeito: <span class="mt-dim">—</span>');
  }

  if (info?.vbp) {
    const { anoA, anoB, valB, deltaPct } = info.vbp;
    const up = deltaPct >= 0;
    const arrow = up ? '▲' : '▼';
    const cls = up ? 'mt-up' : 'mt-down';
    const pct = `${up ? '+' : ''}${String(deltaPct).replace('.', ',')}%`;
    lines.push(
      `VBP ${anoA.slice(2)}→${anoB.slice(2)}: ` +
        `<span class="${cls}">${arrow} ${pct}</span> ` +
        `<span class="mt-dim">(${fmtBRL(valB)})</span>`,
    );
  } else {
    lines.push('VBP: <span class="mt-dim">sem dado</span>');
  }

  if (info?.cadeia) {
    lines.push(`Cadeia líder: ${info.cadeia}`);
  }

  lines.push(
    '<div class="mt-fontes">Clique para abrir a ficha completa<br/>TSE 2024 · VBP SEAB/DERAL 24-25</div>',
  );
  return lines.join('<br/>').replace('<br/><div class="mt-fontes">', '<div class="mt-fontes">');
}

export function createDatageoMunicipiosLayer() {
  let _dataSource = null;
  let _info = null;
  let _handler = null;
  let _tooltip = null;
  let _enabled = false;
  let _hovered = null;
  let _lastMove = 0;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  function clearHover() {
    if (_hovered) {
      _hovered.polygon.material = new Cesium.ColorMaterialProperty(IDLE_COLOR);
      _hovered = null;
    }
    if (_tooltip) _tooltip.style.display = 'none';
  }

  function onMouseMove(viewer, movement) {
    if (!_enabled || !_dataSource) return;
    const now = performance.now();
    if (now - _lastMove < HOVER_THROTTLE_MS) return;
    _lastMove = now;

    const picked = viewer.scene.pick(movement.endPosition);
    const entity = picked?.id;
    const fromThisSource = entity && entity.entityCollection?.owner === _dataSource;
    // Sobre a linha da divisa o pick devolve a borda, nao o poligono:
    // manter o hover corrente em vez de piscar o tooltip.
    if (fromThisSource && !entity.polygon) return;
    const isOurs = fromThisSource && entity.polygon;

    if (!isOurs) {
      clearHover();
      return;
    }

    if (entity !== _hovered) {
      clearHover();
      _hovered = entity;
      entity.polygon.material = new Cesium.ColorMaterialProperty(HOVER_COLOR);
      const nowJ = Cesium.JulianDate.now();
      const ibge = entity.properties?.CD_MUN?.getValue(nowJ) ?? '';
      const nome = entity.properties?.NM_MUN?.getValue(nowJ) ?? '';
      _tooltip.innerHTML = tooltipHtml(nome, _info?.municipios?.[String(ibge)]);
      viewer.scene.requestRender();
    }

    _tooltip.style.display = 'block';
    _tooltip.style.left = `${movement.endPosition.x + 16}px`;
    _tooltip.style.top = `${movement.endPosition.y + 12}px`;
  }

  return {
    id: 'datageo-municipios',
    name: 'Municípios do Paraná',
    category: 'Limites',
    icon: '🏛️',
    source: 'TSE · IBGE/PAM · DataGeo PR',
    updateInterval: 6 * 3600_000,

    init(viewer) {
      injectStyles();
      _tooltip = document.createElement('div');
      _tooltip.id = 'datageo-muni-tooltip';
      document.body.appendChild(_tooltip);

      _handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      _handler.setInputAction(
        (movement) => onMouseMove(viewer, movement),
        Cesium.ScreenSpaceEventType.MOUSE_MOVE,
      );
      // Clique no poligono abre a ficha municipal detalhada (datageoFicha).
      _handler.setInputAction((click) => {
        if (!_enabled || !_dataSource) return;
        const picked = viewer.scene.pick(click.position);
        const entity = picked?.id;
        if (!entity || entity.entityCollection?.owner !== _dataSource || !entity.polygon) return;
        const nowJ = Cesium.JulianDate.now();
        const ibge = String(entity.properties?.CD_MUN?.getValue(nowJ) ?? '');
        const nome = entity.properties?.NM_MUN?.getValue(nowJ) ?? '';
        if (!ibge) return;
        openFicha({ ibge, nome, info: _info?.municipios?.[ibge] });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      console.log('[Data:datageo-municipios] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      clearHover();
    },

    async update(viewer) {
      try {
        if (!_info) {
          const resp = await fetch(INFO_URL);
          if (resp.ok) _info = await resp.json();
        }
        if (!_dataSource) {
          _dataSource = await Cesium.GeoJsonDataSource.load(GEOJSON_URL, {
            clampToGround: true,
            fill: IDLE_COLOR,
            stroke: Cesium.Color.CYAN.withAlpha(0.12),
            strokeWidth: 1,
          });
          // Bordas permanentes: uma polyline clamped por anel externo. O id
          // com prefixo "muni-border:" e o que o hover usa para ignora-las.
          const nowJ = Cesium.JulianDate.now();
          const polygons = _dataSource.entities.values.filter((e) => e.polygon);
          for (const entity of polygons) {
            const hierarchy = entity.polygon.hierarchy?.getValue(nowJ);
            if (!hierarchy?.positions?.length) continue;
            _dataSource.entities.add({
              id: `muni-border:${entity.id}`,
              polyline: {
                positions: [...hierarchy.positions, hierarchy.positions[0]],
                clampToGround: true,
                width: BORDER_WIDTH,
                material: new Cesium.ColorMaterialProperty(BORDER_COLOR),
              },
            });
          }
          _dataSource.show = _enabled;
          await viewer.dataSources.add(_dataSource);
        }
        _count = _dataSource.entities.values.filter((e) => e.polygon).length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:datageo-municipios] ${_count} poligonos prontos`);
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-municipios]', err);
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      clearHover();
      if (_handler) {
        _handler.destroy();
        _handler = null;
      }
      if (_tooltip) {
        _tooltip.remove();
        _tooltip = null;
      }
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

export const datageoMunicipiosLayer = createDatageoMunicipiosLayer();
