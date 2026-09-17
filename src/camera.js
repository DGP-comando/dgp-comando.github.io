import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 * Phase 1 default: fly to Austin, TX on load.
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Set camera to Austin on load with a cinematic fly-in.
 */
/**
 * Enquadramento canonico da Sala de Situacao: o Parana inteiro em quadro,
 * NORTE PARA CIMA e vista ORTOGONAL (pitch -90). E para onde o voo de
 * abertura chega e para onde o botao de reset volta — o mesmo quadro, para
 * que "visao geral do estado" signifique sempre a mesma coisa.
 */
export const PARANA_OVERVIEW = Object.freeze({
  lon: -51.6,
  lat: -24.7,
  heightM: 900_000,
  durationS: 3.5,
});

/**
 * Voa ate o enquadramento estadual. `endTransform` volta a identidade para
 * soltar qualquer referencial preso a uma entidade rastreada, senao o voo
 * chega torto.
 * @param {Cesium.Viewer} viewer
 * @param {{duration?: number, complete?: Function, cancel?: Function}} [options]
 * @returns {{latitude: number, longitude: number, heightM: number}}
 */
export function flyToParanaOverview(viewer, options = {}) {
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      PARANA_OVERVIEW.lon, PARANA_OVERVIEW.lat, PARANA_OVERVIEW.heightM,
    ),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
    duration: Number.isFinite(options.duration) && options.duration > 0
      ? options.duration
      : PARANA_OVERVIEW.durationS,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    endTransform: Cesium.Matrix4.IDENTITY,
    complete: options.complete,
    cancel: options.cancel,
  });
  return {
    latitude: PARANA_OVERVIEW.lat,
    longitude: PARANA_OVERVIEW.lon,
    heightM: PARANA_OVERVIEW.heightM,
  };
}

/**
 * Voo de abertura da Sala de Situacao: o Parana inteiro em quadro (visao
 * estadual ~900 km), nao um mergulho urbano — o operador escolhe onde descer.
 */
export function flyToParana(viewer) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      PARANA_OVERVIEW.lon, PARANA_OVERVIEW.lat, 4_000_000,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });
  setTimeout(() => flyToParanaOverview(viewer), 400);
}

export function flyToAustin(viewer) {
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 25000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  setTimeout(() => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 600),
      orientation: {
        heading: Cesium.Math.toRadians(15),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
}
