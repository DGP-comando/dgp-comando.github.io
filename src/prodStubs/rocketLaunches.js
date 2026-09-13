// Production-build stand-in for src/data/rocketLaunches.js. See ./inertLayer.js.
import { createInertLayer } from './inertLayer.js';

export default createInertLayer('rocket-launches', 'Space Missions (30d)', {
  attachDataManager: () => {},
});