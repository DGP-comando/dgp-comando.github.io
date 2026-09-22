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
// ignora picks de outras fontes, entao nao conflita com o picking
// nativo do GEV (avioes, focos etc.).
//
// Performance (camada sempre ligada): os 399 poligonos sao UM GroundPrimitive
// com um GeometryInstance por municipio (id `datageo-muni:<n>`), e as bordas
// sao UM GroundPolylinePrimitive sem picking. O hover troca so o atributo de
// cor da instancia (getGeometryInstanceAttributes), em vez de trocar o
// material de uma entidade, o que forcava o Cesium a refazer o lote inteiro
// de poligonos clamped a cada municipio sobrevoado. O pick do hover nao roda
// com a camera em movimento nem sem o mouse ter mudado de posicao. Sem suporte
// a ground primitives, cai no caminho antigo de entidades (visual identico).

import * as Cesium from 'cesium';
import { openFicha } from '../datageoFicha.js';
import { governorRequestRender } from '../renderGovernor.js';
import { createReadyPump } from './entityDiff.js';
import { drillHoverAt } from './entityHoverTooltip.js';

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

/**
 * Poligonos (anel externo + buracos) de uma geometria GeoJSON Polygon ou
 * MultiPolygon, descartando aneis externos inutilizaveis. Puro.
 * @param {object|null|undefined} geometry
 * @returns {Array<Array<Array<[number, number]>>>}
 */
export function municipioPolygons(geometry) {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return (polys ?? []).filter((rings) => Array.isArray(rings?.[0]) && rings[0].length >= 3);
}

const INSTANCE_PREFIX = 'datageo-muni:';

function ringToCartesians(ring) {
  const flat = new Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    flat[i * 2] = ring[i][0];
    flat[i * 2 + 1] = ring[i][1];
  }
  return Cesium.Cartesian3.fromDegreesArray(flat);
}

export function createDatageoMunicipiosLayer() {
  // 'primitives' (padrao) ou 'entities' (fallback sem ground primitives).
  let _mode = null;
  let _viewer = null;
  // Incrementa a cada destroy; cargas assincronas comparam para abortar.
  let _generation = 0;
  // Caminho em lote.
  let _collection = null;
  let _fillPrimitive = null;
  let _borderPrimitive = null;
  let _pump = null;
  // instance id -> { ibge, nome }
  let _instances = new Map();
  // Caminho de entidades.
  let _dataSource = null;
  let _info = null;
  let _infoPromise = null;
  // IBGE -> { nome, boundingSphere, rectangle }. Enquadramento real de cada
  // municipio, montado uma vez no load do GeoJSON para a busca por nome nao
  // precisar varrer 399 entidades a cada tecla. A esfera enquadra a camera; o
  // retangulo responde "este ponto esta dentro do municipio?", que e o que as
  // camadas com teto de altura usam para se manter visiveis no municipio em
  // foco. Ver getMunicipioFocus.
  let _focus = new Map();
  let _handler = null;
  let _tooltip = null;
  let _enabled = false;
  // Hover corrente: { key, ibge, nome, entity? } ou null.
  let _hovered = null;
  let _lastMove = 0;
  let _pointer = null; // ultima posicao do mouse (Cartesian2)
  let _pickedPointer = null; // posicao do ultimo pick efetivo
  let _trailingPick = null;
  let _cameraMoving = false;
  let _removeMoveStart = null;
  let _removeMoveEnd = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  /**
   * Carrega municipios-info.json no maximo uma vez, mesmo com chamadas
   * concorrentes. Vive fora de update() porque a BUSCA por nome precisa do
   * prefeito/VBP para montar a ficha, e ela pode ser usada antes do primeiro
   * update — ou com a camada desligada pelo operador.
   * @returns {Promise<object|null>}
   */
  function loadInfo() {
    if (_info) return Promise.resolve(_info);
    if (!_infoPromise) {
      _infoPromise = fetch(INFO_URL)
        .then((resp) => (resp.ok ? resp.json() : null))
        .catch((err) => {
          console.warn('[Data:datageo-municipios] info indisponivel:', err);
          return null;
        })
        .then((json) => {
          if (json) _info = json;
          _infoPromise = null;
          return _info;
        });
    }
    return _infoPromise;
  }

  function isLoaded() {
    return _mode === 'primitives' ? Boolean(_fillPrimitive) : Boolean(_dataSource);
  }

  function requestFrame(reason) {
    governorRequestRender(`datageo-municipios:${reason}`);
  }

  function setShow(show) {
    if (_dataSource) _dataSource.show = show;
    if (_collection && !_collection.isDestroyed?.()) _collection.show = show;
    if (show && _mode === 'primitives') _pump?.start();
    else _pump?.stop();
  }

  /**
   * Municipio sob um resultado de scene.pick, independente do caminho.
   * @returns {{key: *, ibge: string, nome: string, entity?: object}|'border'|null}
   */
  function municipioFromPick(picked) {
    if (!picked) return null;
    if (_mode === 'primitives') {
      const key = picked.id;
      if (picked.primitive !== _fillPrimitive || typeof key !== 'string') return null;
      const meta = _instances.get(key);
      return meta ? { key, ibge: meta.ibge, nome: meta.nome } : null;
    }
    const entity = picked.id;
    const fromThisSource = entity && _dataSource && entity.entityCollection?.owner === _dataSource;
    if (!fromThisSource) return null;
    // Sobre a linha da divisa o pick devolve a borda, nao o poligono.
    if (!entity.polygon) return 'border';
    const nowJ = Cesium.JulianDate.now();
    return {
      key: entity,
      entity,
      ibge: String(entity.properties?.CD_MUN?.getValue(nowJ) ?? ''),
      nome: entity.properties?.NM_MUN?.getValue(nowJ) ?? '',
    };
  }

  function paintHover(target, on) {
    if (!target) return;
    const color = on ? HOVER_COLOR : IDLE_COLOR;
    if (target.entity) {
      if (target.entity.polygon) target.entity.polygon.material = new Cesium.ColorMaterialProperty(color);
      return;
    }
    if (!_fillPrimitive || _fillPrimitive.isDestroyed?.() || !_fillPrimitive.ready) return;
    try {
      const attributes = _fillPrimitive.getGeometryInstanceAttributes(target.key);
      if (attributes) {
        attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(color, attributes.color);
      }
    } catch (err) {
      console.warn('[Data:datageo-municipios] hover:', err);
    }
  }

  function clearHover() {
    if (_hovered) {
      paintHover(_hovered, false);
      _hovered = null;
      requestFrame('hover');
    }
    if (_tooltip) _tooltip.style.display = 'none';
  }

  function positionTooltip(position) {
    if (!_tooltip || !position) return;
    _tooltip.style.display = 'block';
    _tooltip.style.left = `${position.x + 16}px`;
    _tooltip.style.top = `${position.y + 12}px`;
  }

  function runHoverPick(viewer) {
    if (!_enabled || !isLoaded() || !_pointer || _cameraMoving) return;
    // Mouse parado e camera parada: o que esta sob o cursor nao mudou.
    if (_pickedPointer && Cesium.Cartesian2.equals(_pickedPointer, _pointer)) return;
    _lastMove = performance.now();
    _pickedPointer = Cesium.Cartesian2.clone(_pointer, _pickedPointer ?? new Cesium.Cartesian2());

    const target = municipioFromPick(viewer.scene.pick(_pointer));
    // Sobre a divisa (so no caminho de entidades): manter o hover corrente em
    // vez de piscar o tooltip.
    if (target === 'border') return;
    // Sobre uma linha com hover próprio (drill), o tooltip é dela.
    if (!target || drillHoverAt(viewer.scene, _pointer)) {
      clearHover();
      return;
    }
    if (!_hovered || target.key !== _hovered.key) {
      clearHover();
      _hovered = target;
      paintHover(target, true);
      _tooltip.innerHTML = tooltipHtml(target.nome, _info?.municipios?.[String(target.ibge)]);
      requestFrame('hover');
    }
    positionTooltip(_pointer);
  }

  function scheduleHoverPick(viewer) {
    if (_cameraMoving) return; // moveEnd refaz o pick
    const wait = HOVER_THROTTLE_MS - (performance.now() - _lastMove);
    if (wait <= 0) {
      runHoverPick(viewer);
      return;
    }
    // Pick "de cauda": o ultimo movimento dentro da janela de throttle tambem
    // e resolvido, senao o hover ficaria preso na posicao anterior.
    if (!_trailingPick) {
      _trailingPick = setTimeout(() => {
        _trailingPick = null;
        runHoverPick(viewer);
      }, wait);
    }
  }

  function onMouseMove(viewer, movement) {
    if (!_enabled || !isLoaded()) return;
    const position = movement?.endPosition;
    if (!position) return;
    _pointer = Cesium.Cartesian2.clone(position, _pointer ?? new Cesium.Cartesian2());
    // Tooltip acompanha o mouse sem esperar o pick (so DOM, barato).
    if (_hovered) positionTooltip(_pointer);
    scheduleHoverPick(viewer);
  }

  function watchCamera(viewer) {
    const camera = viewer?.camera;
    if (!camera?.moveStart || !camera?.moveEnd) return;
    _removeMoveStart = camera.moveStart.addEventListener(() => {
      _cameraMoving = true;
    });
    _removeMoveEnd = camera.moveEnd.addEventListener(() => {
      _cameraMoving = false;
      // O mundo sob o cursor mudou: o proximo pick nao pode ser pulado.
      _pickedPointer = null;
      if (_pointer) scheduleHoverPick(viewer);
    });
  }

  function unwatchCamera() {
    _removeMoveStart?.();
    _removeMoveEnd?.();
    _removeMoveStart = null;
    _removeMoveEnd = null;
    _cameraMoving = false;
  }

  function groundPrimitivesSupported(viewer) {
    try {
      return Boolean(viewer?.scene?.groundPrimitives)
        && Cesium.GroundPrimitive.isSupported(viewer.scene)
        && Cesium.GroundPolylinePrimitive.isSupported(viewer.scene);
    } catch {
      return false;
    }
  }

  function addFocus(focus, ibge, nome, positions) {
    // Indice de enquadramento. Um municipio com ilhas (Paranagua,
    // Guaraquecuba) chega como varias entidades com o MESMO CD_MUN:
    // unir as esferas e o que faz "ir para o municipio" enquadrar o
    // municipio inteiro, e nao so o primeiro anel do arquivo.
    if (!ibge) return;
    const sphere = Cesium.BoundingSphere.fromPoints(positions);
    const rect = Cesium.Rectangle.fromCartesianArray(positions);
    const previous = focus.get(ibge);
    focus.set(ibge, previous
      ? {
        nome: previous.nome,
        boundingSphere: Cesium.BoundingSphere.union(
          previous.boundingSphere,
          sphere,
          new Cesium.BoundingSphere(),
        ),
        rectangle: Cesium.Rectangle.union(previous.rectangle, rect, new Cesium.Rectangle()),
      }
      : { nome, boundingSphere: sphere, rectangle: rect });
  }

  async function loadAsPrimitives(viewer) {
    const generation = _generation;
    const resp = await fetch(GEOJSON_URL);
    if (!resp.ok) throw new Error(`municipios HTTP ${resp.status}`);
    const geojson = await resp.json();
    // destroy() durante o fetch: nao pendurar primitive orfa na cena.
    if (generation !== _generation || isLoaded()) return;
    if (!viewer?.scene?.groundPrimitives) throw new Error('viewer indisponivel');

    const fills = [];
    const borders = [];
    const instances = new Map();
    const focus = new Map();
    for (const feature of geojson.features ?? []) {
      const props = feature?.properties ?? {};
      const ibge = String(props.CD_MUN ?? '');
      const nome = String(props.NM_MUN ?? '');
      for (const rings of municipioPolygons(feature?.geometry)) {
        const outer = ringToCartesians(rings[0]);
        const holes = rings.slice(1)
          .filter((hole) => Array.isArray(hole) && hole.length >= 3)
          .map((hole) => new Cesium.PolygonHierarchy(ringToCartesians(hole)));
        const key = `${INSTANCE_PREFIX}${fills.length}`;
        instances.set(key, { ibge, nome });
        // Mesmo poligono do GeoJsonDataSource: arcos RHUMB, fill plano.
        fills.push(new Cesium.GeometryInstance({
          id: key,
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(outer, holes),
            arcType: Cesium.ArcType.RHUMB,
            vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(IDLE_COLOR),
          },
        }));
        // Borda permanente do anel externo, fechada (como a polyline de
        // entidade anterior, arco padrao GEODESIC).
        borders.push(new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: [...outer, outer[0]],
            width: BORDER_WIDTH,
          }),
        }));
        addFocus(focus, ibge, nome, outer);
      }
    }

    const collection = new Cesium.PrimitiveCollection();
    collection.show = _enabled;
    const fill = fills.length
      ? new Cesium.GroundPrimitive({
        geometryInstances: fills,
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
      })
      : null;
    const border = borders.length
      ? new Cesium.GroundPolylinePrimitive({
        geometryInstances: borders,
        appearance: new Cesium.PolylineMaterialAppearance({
          material: Cesium.Material.fromType('Color', { color: BORDER_COLOR }),
        }),
        classificationType: Cesium.ClassificationType.BOTH,
        // Sem pick na borda: o cursor sobre a divisa enxerga o poligono.
        allowPicking: false,
        asynchronous: true,
      })
      : null;
    if (!fill) throw new Error('municipios-pr.geojson sem poligonos');
    collection.add(fill);
    if (border) collection.add(border);
    viewer.scene.groundPrimitives.add(collection);

    _collection = collection;
    _fillPrimitive = fill;
    _borderPrimitive = border;
    _instances = instances;
    _focus = focus;
    _count = fills.length;
    _pump = createReadyPump({
      isReady: () => [_fillPrimitive, _borderPrimitive]
        .every((p) => !p || p.isDestroyed?.() || p.ready),
      requestRender: () => requestFrame('ground-ready'),
    });
  }

  async function loadAsEntities(viewer) {
    const dataSource = await Cesium.GeoJsonDataSource.load(GEOJSON_URL, {
      clampToGround: true,
      fill: IDLE_COLOR,
      stroke: Cesium.Color.CYAN.withAlpha(0.12),
      strokeWidth: 1,
    });
    // Bordas permanentes: uma polyline clamped por anel externo. O id
    // com prefixo "muni-border:" e o que o hover usa para ignora-las.
    const nowJ = Cesium.JulianDate.now();
    const polygons = dataSource.entities.values.filter((e) => e.polygon);
    const focus = new Map();
    for (const entity of polygons) {
      const hierarchy = entity.polygon.hierarchy?.getValue(nowJ);
      if (!hierarchy?.positions?.length) continue;
      dataSource.entities.add({
        id: `muni-border:${entity.id}`,
        polyline: {
          positions: [...hierarchy.positions, hierarchy.positions[0]],
          clampToGround: true,
          width: BORDER_WIDTH,
          material: new Cesium.ColorMaterialProperty(BORDER_COLOR),
        },
      });
      addFocus(
        focus,
        String(entity.properties?.CD_MUN?.getValue(nowJ) ?? ''),
        String(entity.properties?.NM_MUN?.getValue(nowJ) ?? ''),
        hierarchy.positions,
      );
    }
    _focus = focus;
    dataSource.show = _enabled;
    await viewer.dataSources.add(dataSource);
    _dataSource = dataSource;
    _count = polygons.length;
  }

  return {
    id: 'datageo-municipios',
    name: 'Municípios do Paraná',
    category: 'Limites',
    icon: '🏛️',
    source: 'TSE · IBGE/PAM · DataGeo PR',
    updateInterval: 6 * 3600_000,

    init(viewer) {
      _viewer = viewer;
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
        if (!_enabled || !isLoaded()) return;
        const target = municipioFromPick(viewer.scene.pick(click.position));
        if (!target || target === 'border' || !target.ibge) return;
        openFicha({ ibge: target.ibge, nome: target.nome, info: _info?.municipios?.[target.ibge] });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      watchCamera(viewer);
      console.log('[Data:datageo-municipios] Initialized');
    },

    enable() {
      _enabled = true;
      setShow(true);
    },

    disable() {
      _enabled = false;
      setShow(false);
      clearHover();
      if (_trailingPick) {
        clearTimeout(_trailingPick);
        _trailingPick = null;
      }
      _pickedPointer = null;
    },

    /**
     * Entrada de municipios-info.json (prefeito, VBP, cadeias) do municipio.
     * Carrega o arquivo sob demanda, independente da camada estar ligada.
     * @param {string|number} ibge
     * @returns {Promise<object|null>}
     */
    async getMunicipioInfo(ibge) {
      const info = await loadInfo();
      return info?.municipios?.[String(ibge ?? '')] ?? null;
    },

    /**
     * Enquadramento do municipio: a BoundingSphere que cobre TODOS os aneis do
     * poligono (ilhas do litoral incluidas), para a camera cair exatamente
     * sobre a divisa em vez de num raio fixo em torno do centroide. Devolve
     * null enquanto o GeoJSON nao carregou — quem chama cai no centroide.
     * @param {string|number} ibge
     * @returns {{ibge: string, nome: string, boundingSphere: Cesium.BoundingSphere,
     *   rectangle: Cesium.Rectangle}|null}
     */
    getMunicipioFocus(ibge) {
      const code = String(ibge ?? '');
      const found = code ? _focus.get(code) : null;
      return found
        ? {
          ibge: code,
          nome: found.nome,
          boundingSphere: found.boundingSphere,
          rectangle: found.rectangle,
        }
        : null;
    },

    /**
     * Abre a ficha municipal sem depender de um clique no mapa — e o que a
     * busca por nome usa. O nome vem do GeoJSON quando ja carregou, senao do
     * chamador (a tabela de centroides), para a ficha nunca abrir sem titulo.
     * @param {{ibge: string|number, nome?: string}} target
     * @returns {Promise<boolean>} se a ficha foi aberta
     */
    async openMunicipioFicha({ ibge, nome = '' } = {}) {
      const code = String(ibge ?? '');
      if (!code) return false;
      const info = await this.getMunicipioInfo(code);
      openFicha({ ibge: code, nome: _focus.get(code)?.nome || nome, info });
      return true;
    },

    async update(viewer) {
      try {
        await loadInfo();
        if (!isLoaded()) {
          const mode = groundPrimitivesSupported(viewer) ? 'primitives' : 'entities';
          _mode = mode;
          if (mode === 'primitives') await loadAsPrimitives(viewer);
          else await loadAsEntities(viewer);
          setShow(_enabled);
        }
        _lastUpdate = Date.now();
        _lastError = null;
        requestFrame('update');
        console.log(`[Data:datageo-municipios] ${_count} poligonos prontos (${_mode})`);
        return true;
      } catch (err) {
        _lastError = err?.message || String(err);
        console.warn('[Data:datageo-municipios]', err);
        return false;
      }
    },

    destroy(viewer) {
      _generation += 1;
      _enabled = false;
      clearHover();
      _pump?.stop();
      _pump = null;
      if (_trailingPick) {
        clearTimeout(_trailingPick);
        _trailingPick = null;
      }
      unwatchCamera();
      _pointer = null;
      _pickedPointer = null;
      if (_handler) {
        _handler.destroy();
        _handler = null;
      }
      if (_tooltip) {
        _tooltip.remove();
        _tooltip = null;
      }
      if (_collection && !_collection.isDestroyed?.()) {
        const ground = (viewer ?? _viewer)?.scene?.groundPrimitives;
        try {
          if (ground?.contains?.(_collection)) ground.remove(_collection);
          else _collection.destroy();
        } catch (err) {
          console.warn('[Data:datageo-municipios] remover primitives:', err);
        }
      }
      _collection = null;
      _fillPrimitive = null;
      _borderPrimitive = null;
      _instances = new Map();
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _mode = null;
      _viewer = null;
      _focus = new Map();
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
}

export const datageoMunicipiosLayer = createDatageoMunicipiosLayer();
