import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Cockpit AIR presentation (MapLibre).
 *
 * MIGRAÇÃO MAPLIBRE (2026-09): este arquivo fixava a política de MODELOS 3D do
 * cockpit no app Cesium (fila de GLB, teto de 60 modelos, raios de admissão,
 * troca billboard→modelo). No MapLibre não há modelo glTF — a aeronave é
 * sempre o ícone —, então esses testes saíram com o código. O que continua
 * valendo, e é testado aqui por comportamento nas duas camadas aéreas:
 *  - no cockpit, o tráfego fora da faixa próxima vira o pip de contato (sem
 *    rumo) e o de perto mantém a silhueta da classe;
 *  - a aeronave do próprio piloto (o alvo) não aparece na frota;
 *  - a saída do cockpit devolve as silhuetas.
 */
import flightsLayer, {
  _fleetFeaturesForTest as flightsFleet,
  _setTrackedFlightRefreshStateForTest,
  fleetFeatureProps,
} from './flights.js';
import militaryFlightsLayer, {
  _fleetFeaturesForTest as militaryFleet,
  _setTrackedMilitaryRefreshStateForTest,
  militaryFeatureProps,
} from './militaryFlights.js';

const LAYERS = [
  {
    name: 'flights',
    layer: flightsLayer,
    fleet: flightsFleet,
    props: fleetFeatureProps,
    seed: (icao24, tracked) => _setTrackedFlightRefreshStateForTest({
      icao24, tracked, position: { lon: 0.01, lat: 0.01, alt: 10_000 },
      meta: { callsign: 'T1', altitude: 10_000, klass: 'airliner', true_track: 90, rawLat: 0.01, rawLon: 0.01 },
    }),
  },
  {
    name: 'militaryFlights',
    layer: militaryFlightsLayer,
    fleet: militaryFleet,
    props: militaryFeatureProps,
    seed: (icao24, tracked) => _setTrackedMilitaryRefreshStateForTest({
      icao24, tracked, position: { lon: 0.01, lat: 0.01, alt: 10_000 },
      meta: { callsign: 'M1', altitudeFt: 33_000, klass: 'fastjet', track: 90, rawLat: 0.01, rawLon: 0.01 },
    }),
  },
];

function cockpitEvent(active, subjectId = null) {
  globalThis.window.dispatchEvent(new CustomEvent('gev:cockpit-mode-changed', {
    detail: { active, subjectId, layerId: null },
  }));
}

for (const fixture of LAYERS) {
  test(`${fixture.name}: far cockpit traffic becomes a rotation-free pip, near traffic keeps its silhouette`, () => {
    const far = fixture.props('abc001', { klass: 'airliner' }, { course: 123, cockpitDot: true });
    assert.match(far.img, /^dot-/);
    assert.equal(far.r, 0, 'pips carry no course');
    const near = fixture.props('abc001', { klass: 'airliner' }, { course: 123, cockpitDot: false });
    assert.match(near.img, /^airliner-/);
    assert.equal(near.r, 123, 'near silhouettes keep the projected course');
    assert.ok(near.s > far.s, 'the pip is smaller than the silhouette');
  });

  test(`${fixture.name}: cockpit lifecycle swaps the fleet presentation and hides the pilot's own airframe`, () => {
    const realWindow = globalThis.window;
    globalThis.window = new EventTarget();
    try {
      fixture.layer.init(null);
      fixture.seed('abc002', false);
      assert.match(fixture.fleet(Date.now()).features[0].properties.img, /^(airliner|fastjet)-/);

      // The fleet engine's camera sits 1000 km up: nothing is in the near band.
      cockpitEvent(true, 'ABC002');
      assert.match(fixture.fleet(Date.now()).features[0].properties.img, /^dot-/,
        'out-of-range contacts become pips in cockpit');

      fixture.seed('abc002', true);
      assert.equal(fixture.fleet(Date.now()).features.length, 0,
        'the tracked (pilot) aircraft is drawn only by its own marker, never in the fleet');

      cockpitEvent(false);
      fixture.seed('abc002', false);
      assert.match(fixture.fleet(Date.now()).features[0].properties.img, /^(airliner|fastjet)-/,
        'exiting cockpit restores the class silhouettes');
    } finally {
      cockpitEvent(false);
      fixture.layer.destroy();
      globalThis.window = realWindow;
    }
  });
}
