// Production-build stand-in for src/data/militaryFlights.js. See ./inertLayer.js.
import { createInertLayer } from './inertLayer.js';

export default createInertLayer('military', 'Military Flights', {
  getTrackedInfo: () => null,
  getNearby: () => [],
});