// src/data/datageoRadios.js
//
// Rádios ao vivo do PR, no modelo do radio.garden: o ponto verde é o LUGAR
// (o município), o tamanho do ponto é quantas estações ele tem, e clicar no
// ponto abre o player já tocando a primeira. As setas zapeiam pela lista
// inteira do estado, município a município, como girar o dial; a troca de
// estação toca um chiado curto de estática até o áudio entrar.
//
// Dado estático (bucket privado, data/privado/radios-pr.json, scripts/build_radios.py): as
// rádios comunitárias outorgadas pela Anatel, as estações do radio.garden e
// do Radio Browser, com contato e endereço do estúdio. O áudio vai direto do
// servidor da emissora para um único <audio>, sempre depois de um clique:
// nada é proxiado, gravado ou redistribuído.
//
// Rádio sem stream HTTPS entra assim mesmo, "só no dial": a comunitária que
// fala com o produtor pode não transmitir pela internet, mas tem frequência,
// telefone e endereço. Município só com essas fica com o ponto cinza; as
// setas pulam essas estações, porque não há o que tocar.

import * as Cesium from 'cesium';
import { centroidByIbge } from './prCentroids.js';
import { createEntityHoverTooltip } from './entityHoverTooltip.js';
import { isLive, placeTooltipHtml } from './radioContact.js';
import { GREEN, createPlayer, dotSize } from './radioPlayer.js';
import { governorRequestRender } from '../renderGovernor.js';
import { dgFetchData } from './datageoClient.js';

// O player (DOM puro) e as funções puras moram em radioPlayer.js, sem Cesium,
// para o protótipo MapLibre usar o mesmo player.
export { dotSize, flattenStations, nextLiveIndex } from './radioPlayer.js';

const ID = 'datageo-radios';
const DATA_URL = '/privado/radios-pr.json';
const DOT_COLOR = Cesium.Color.fromCssColorString(GREEN);
const DIAL_COLOR = Cesium.Color.fromCssColorString('#94a3b8');

function createRadiosLayer() {
  let viewer = null;
  let dataSource = null;
  let handler = null;
  let tooltip = null;
  let player = null;
  let places = [];
  let lastUpdate = null;
  let lastError = null;
  let selected = null;

  const baseColor = (place) => (place.stations.some(isLive) ? DOT_COLOR : DIAL_COLOR);

  const highlight = (ibge) => {
    selected = ibge;
    for (const place of places) {
      const entity = dataSource?.entities.getById(`${ID}:${place.ibge}`);
      if (!entity) continue;
      const isSel = place.ibge === ibge;
      entity.point.color = isSel ? Cesium.Color.WHITE : baseColor(place);
      entity.point.outlineColor = isSel ? DOT_COLOR.withAlpha(0.6) : baseColor(place).withAlpha(0.3);
    }
    governorRequestRender(`${ID}:select`);
  };

  const build = () => {
    dataSource.entities.removeAll();
    for (const place of places) {
      const c = centroidByIbge(place.ibge);
      if (!c) continue;
      dataSource.entities.add({
        id: `${ID}:${place.ibge}`,
        position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
        point: {
          pixelSize: dotSize(place.stations.length),
          color: baseColor(place),
          outlineColor: baseColor(place).withAlpha(0.3),
          outlineWidth: 5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { ibge: place.ibge },
      });
    }
    if (selected) highlight(selected);
  };

  return {
    id: ID,
    name: 'Rádios ao vivo',
    category: 'Infraestrutura',
    icon: '📻',
    source: 'Anatel · radio.garden · Radio Browser',
    updateInterval: 24 * 3600_000,

    init(v) {
      viewer = v;
      dataSource = new Cesium.CustomDataSource(ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      player = createPlayer({ onSelectionChange: highlight });
      tooltip = createEntityHoverTooltip({
        viewer,
        idPrefix: `${ID}:`,
        render: (p) => {
          const place = places.find((pl) => pl.ibge === p.ibge);
          return place ? placeTooltipHtml(place) : '';
        },
        isActive: () => Boolean(dataSource?.show),
      });
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click) => {
        if (!dataSource?.show) return;
        const id = viewer.scene.pick(click.position)?.id?.id;
        if (typeof id === 'string' && id.startsWith(`${ID}:`)) player.openPlace(id.slice(ID.length + 1));
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      if (dataSource) dataSource.show = true;
    },

    disable() {
      if (dataSource) dataSource.show = false;
      tooltip?.hide();
      player?.close(); // camada desligada não segue tocando
    },

    async update() {
      if (!dataSource) return false;
      try {
        const resp = await dgFetchData(DATA_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        places = (await resp.json()).places ?? [];
      } catch (err) {
        lastError = err?.message || String(err);
        console.warn(`[Data:${ID}]`, err);
        return false;
      }
      if (!dataSource) return false; // destruída durante o fetch
      player.setPlaces(places);
      build();
      lastUpdate = Date.now();
      lastError = null;
      return true;
    },

    destroy(v) {
      handler?.destroy();
      tooltip?.destroy();
      player?.destroy();
      if (dataSource) v.dataSources.remove(dataSource, true);
      handler = tooltip = player = dataSource = null;
    },

    getStats() {
      const count = places.reduce((sum, p) => sum + p.stations.length, 0);
      return { count, lastUpdate, error: lastError };
    },
  };
}

export const datageoRadiosLayer = createRadiosLayer();
