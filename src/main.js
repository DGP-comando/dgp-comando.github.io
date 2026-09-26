import { StyleManager } from './ui.js';
import { flyToParana } from './camera.js';
import { DataLayerManager } from './data/manager.js';
import flightsLayer from './data/flights.js';
import militaryFlightsLayer from './data/militaryFlights.js';
import satellitesLayer from './data/satellites.js';
import rocketLaunchesLayer from './data/rocketLaunches.js';
import trafficLayer from './data/traffic.js';
import cctvLayer from './data/cctv.js';
import radioLayer from './data/radio.js';
import bikeshareLayer from './data/bikeshare.js';
import aisLiveVesselsLayer from './data/aisLiveVessels.js';
import militaryInstallationsLayer from './data/militaryInstallations.js';
import militaryAwarenessLayer from './data/militaryAwareness.js';
import { createEngine } from './maplibre/engine.js';
import { createLayerHost } from './maplibre/layerHost.js';
import { toManagerModule } from './maplibre/managerAdapter.js';
import { LAYERS as MAPLIBRE_LAYERS } from './maplibre/layers/index.js';
import { initDatageoTicker } from './datageoTicker.js';
import { initDatageoBriefing } from './datageoBriefing.js';
import { initDatageoAreaWatch } from './datageoAreaWatch.js';
import { initDatageoShortcuts, openLayersPanel, openLocationSearch } from './datageoShortcuts.js';
import {
  fetchActiveIncidents,
  fetchCemadenAlerts,
  fetchFiresPayload,
} from './data/datageoClient.js';
import { LAYER_STATE_REGISTRY } from './data/layerState.js';
import { registerDataCredits } from './data/dataCredits.js';
import { SceneDirector } from './scenes/director.js';
import { MapStackController } from './mapStackController.js';
import { initAnnotations } from './annotations/index.js';
import { initLogoGaze } from './logoGaze.js';
import { initCockpitCloudEffects } from './cockpitCloudEffects.js';
import { installScopeMask } from './scopeMask.js';
import { initFirstRunExperience } from './firstRunExperience.js';
import { requireLogin } from './datageoLogin.js';

initLogoGaze();

/**
 * Extract a human-readable error message from any thrown value.
 * Handles Error objects, strings, and plain objects with message/error fields.
 * @param {*} error — caught exception value
 * @returns {string} best-effort error description
 */
function describeError(error) {
  if (!error) return 'Unknown initialization error';
  if (error instanceof Error) {
    if (error.message && error.message.trim()) return error.message.trim();
    return error.name || 'Initialization error';
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object') {
    const maybeMessage = String(error.message || error.error || '').trim();
    if (maybeMessage) return maybeMessage;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // ignore serialization error
    }
  }
  return String(error);
}

/**
 * DATAGEO PR — ponto de entrada.
 *
 * O mapa é o MapLibre GL (src/maplibre/engine.js), que substituiu o CesiumJS.
 * `engine` ocupa o lugar do antigo `viewer` para todos os módulos: interface
 * (ui.js), link compartilhável, HUD, overlays e camadas.
 */
async function init() {
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');

  try {
    loaderStatus.textContent = 'Configurando o mapa...';

    const engine = createEngine({
      container: 'cesiumContainer',
      basemap: 'esri',
      // Só a captura de tela da voz (dev) lê o buffer do canvas.
      preserveDrawingBuffer: import.meta.env.DEV,
    });
    await engine.ready;

    // Créditos por camada no lightbox "Data attribution" (DATA_SOURCES.md).
    registerDataCredits(engine);

    loaderStatus.textContent = 'Inicializando sistemas...';

    const mapStackController = new MapStackController(engine, {
      onChange: (state) => {
        window.dispatchEvent(new CustomEvent('gev:map-stack-changed', { detail: state }));
      },
      onError: (message) => console.warn('[MapStack]', message),
    });

    // Interface (estilos, HUD, locais, link compartilhável).
    const styleManager = new StyleManager(engine, { mapStackController });
    const cockpitCloudEffects = initCockpitCloudEffects(engine);

    if (!styleManager.hasShareState) {
      loaderStatus.textContent = 'Voando para o Paraná...';
      flyToParana(engine);
    } else {
      loaderStatus.textContent = 'Restaurando a vista compartilhada...';
    }

    // Initialize data layer manager
    const dataManager = new DataLayerManager(engine, {
      allowQaRegistration: import.meta.env.DEV,
    });
    // Camadas GEV cujo backend e um proxy do DEV-SERVER Vite (OpenSky,
    // adsb.lol, CelesTrak, TomTom, CCTV, Radio Browser, GBFS, AISStream,
    // Overpass...). No deploy estatico (Pages) esses endpoints nao existem:
    // registrar essas camadas so produziria linhas mortas no painel — mesmo
    // principio do seletor de basemaps, que exibe apenas o disponivel.
    // Em dev todas continuam registradas.
    const PROXY_DEPENDENT_LAYER_IDS = new Set([
      // 'flights' SAI da lista: em producao a camada le aviation_traffic
      // do Supabase (etl-aviacao/adsb.lol) — trafego aereo fica disponivel.
      'military',
      'satellites',
      'rocket-launches',
      'traffic',
      'cctv',
      'radio',
      'bikeshare',
      'ais-live-vessels',
      'military-installations',
      'military-awareness',
    ]);
    const layerAvailableInBuild = (id) =>
      import.meta.env.DEV || !PROXY_DEPENDENT_LAYER_IDS.has(id);

    // Ordem de registro = ordem do painel Data Layers: as camadas DataGeo
    // (o produto) vem PRIMEIRO; as do GEV original viram contexto no fim.
    // Camadas desenhadas pelo MapLibre (contrato em src/maplibre/kit.js) entram
    // no manager pelo adaptador, com um único anfitrião de hover/clique.
    const layerHost = createLayerHost(engine);
    layerHost.onPanelRefresh = () => dataManager._refreshTogglePanel();
    const maplibreModules = new Map(MAPLIBRE_LAYERS.map((def) => [def.id, toManagerModule(def, layerHost)]));
    for (const def of MAPLIBRE_LAYERS) {
      if (def.id.startsWith('datageo-')) dataManager.register(maplibreModules.get(def.id));
    }
    if (layerAvailableInBuild('flights')) dataManager.register(flightsLayer);
    if (layerAvailableInBuild('military')) dataManager.register(militaryFlightsLayer);
    dataManager.register(maplibreModules.get('earthquakes'));
    if (layerAvailableInBuild('satellites')) dataManager.register(satellitesLayer);
    if (layerAvailableInBuild('rocket-launches')) {
      dataManager.register(rocketLaunchesLayer);
      rocketLaunchesLayer.attachDataManager(dataManager);
    }
    if (layerAvailableInBuild('traffic')) dataManager.register(trafficLayer);
    if (layerAvailableInBuild('cctv')) dataManager.register(cctvLayer);
    if (layerAvailableInBuild('radio')) dataManager.register(radioLayer);
    if (layerAvailableInBuild('bikeshare')) dataManager.register(bikeshareLayer);
    if (layerAvailableInBuild('ais-live-vessels')) dataManager.register(aisLiveVesselsLayer);
    if (layerAvailableInBuild('military-installations')) {
      dataManager.register(militaryInstallationsLayer);
    }
    if (layerAvailableInBuild('military-awareness')) {
      dataManager.register(militaryAwarenessLayer);
      militaryAwarenessLayer.attachDataManager(dataManager);
    }
    for (const id of ['local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'local-firms']) {
      dataManager.register(maplibreModules.get(id));
    }
    // Chrome DataGeo: ticker de noticias + briefing situacional diario
    initDatageoTicker();
    initDatageoBriefing();
    // Vigilancia de municipios (tripwire: focos/CEMADEN/incidentes novos) e
    // atalhos de teclado DataGeo; o botao VIGIAR da ficha fala por window.
    const areaWatch = initDatageoAreaWatch({
      fetchers: {
        fires: () => fetchFiresPayload().then((payload) => payload.fires),
        cemaden: fetchCemadenAlerts,
        incidents: fetchActiveIncidents,
      },
    });
    window.__dgpAreaWatch = areaWatch;
    initDatageoShortcuts({
      actions: {
        resetCamera: () => flyToParana(engine),
        toggleWatch: () => areaWatch.toggle(),
      },
    });
    // Restoration starts only after the complete production registry is sealed.
    // O registry filtrado espelha exatamente as camadas registradas acima
    // (finalizeRegistrations exige correspondencia 1:1).
    dataManager.finalizeRegistrations(
      LAYER_STATE_REGISTRY.filter((entry) => layerAvailableInBuild(entry.id)),
    );
    if (import.meta.env.DEV) {
      // Dev-only handles for QA scripts and console-driven camera work.
      window.__gevViewer = engine;
      window.__gevEngine = engine;
      window.__gevLayerHost = layerHost;
      window.__gevDataManager = dataManager;
      window.__gevMapStack = mapStackController;
      window.__gevQaRegisterLayer = (targetManager, layerModule) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.registerForQa(layerModule);
      };
      window.__gevQaUnregisterLayer = (targetManager, layerId) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.unregisterForQa(layerId);
      };
    }
    dataManager.buildTogglePanel(document.getElementById('data-toggles'));
    styleManager.attachDataManager(dataManager);

    // Initialize deterministic scene playback for social clip capture
    const sceneDirector = new SceneDirector(engine, styleManager, dataManager);

    // Initialize the voice "whiteboard" annotation engine (world-space renderer)
    const annotations = initAnnotations({ engine });

    // Keep startup chrome truthful: a share is not restored until camera,
    // visual/map/panel lanes, and every requested layer have terminated.
    void Promise.all([
      styleManager.initialRestorePromise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]).finally(() => {
      loadingScreen.classList.add('hidden');
      // Reveal only after the loading cover has yielded. transitionend can be
      // absent under reduced motion, so a bounded fallback makes this reliable.
      let firstRunRevealed = false;
      const revealFirstRun = () => {
        if (firstRunRevealed) return;
        firstRunRevealed = true;
        // O tutorial não liga camadas: seus dois botões de ação apenas abrem o
        // painel de camadas e a busca, pelos mesmos caminhos dos atalhos L e B.
        initFirstRunExperience({
          styleManager,
          actions: { openLayers: openLayersPanel, openSearch: openLocationSearch },
        });
      };
      loadingScreen.addEventListener('transitionend', revealFirstRun, { once: true });
      setTimeout(revealFirstRun, 900);
    });

    // Máscara circular (scope) — src/scopeMask.js.
    installScopeMask(engine);

    // Aba escondida: o MapLibre só redesenha quando algo muda; aqui só se
    // suspendem as nuvens do cockpit e se repinta o painel na volta.
    const syncVisibilitySuspension = () => {
      const hidden = document.hidden;
      cockpitCloudEffects?.setSuspended?.(hidden);
      if (!hidden && dataManager._panelRefreshPendingOnVisible) {
        dataManager._panelRefreshPendingOnVisible = false;
        dataManager._refreshTogglePanel();
      }
    };
    document.addEventListener('visibilitychange', syncVisibilitySuspension);
    syncVisibilitySuspension();

    window.__godsEyeView = {
      engine,
      viewer: engine,
      styleManager,
      dataManager,
      sceneDirector,
      mapStackController,
      annotations,
      cockpitCloudEffects,
      layerHost,
      requestRender: () => engine.requestRender(),
    };
    // Voz depende do proxy OpenAI do dev-server; no deploy estatico o dock
    // ficaria morto (era o widget "VOICE STANDBY" que aparecia no celular).
    // Import dinamico dentro do ramo DEV: no build de producao o Rollup
    // descarta o ramo inteiro e o modulo de voz (gevRealtime + gevActions)
    // nao entra no bundle.
    if (import.meta.env.DEV) {
      const { initGevVoiceCommands } = await import('./voice/gevRealtime.js');
      window.__godsEyeView.voiceCommands = initGevVoiceCommands({ engine, viewer: engine, styleManager, dataManager, sceneDirector, annotations });
    }

    // Paineis cujas camadas/backends nao existem no build estatico: remover o
    // DOM inteiro (CCTV, contexto militar, radio) em vez de deixar acordeoes
    // mortos — mesmo principio do PROXY_DEPENDENT_LAYER_IDS.
    if (!import.meta.env.DEV) {
      for (const id of ['cctv-panel', 'global-context-panel', 'radio-panel']) {
        document.getElementById(id)?.remove();
      }
    }

  } catch (error) {
    console.error("God's Eye View initialization failed:", error);
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
  }
}

requireLogin().then(init);
