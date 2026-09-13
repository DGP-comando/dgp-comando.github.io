// Production-build stand-in for src/data/satellites.js. See ./inertLayer.js.
import { createInertLayer } from './inertLayer.js';

/** No TLE catalog exists without the CelesTrak proxy (real "no-tle" branch). */
export function getNextIssPass() {
  return { status: 'no-tle' };
}

export default createInertLayer('satellites', 'Satellites', {
  getTrackedInfo: () => null,
});