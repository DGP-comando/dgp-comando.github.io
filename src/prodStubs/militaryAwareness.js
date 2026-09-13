// Production-build stand-in for src/data/militaryAwareness.js. See ./inertLayer.js.
import { createInertLayer } from './inertLayer.js';

/**
 * Pure summary helper, copied verbatim from src/data/militaryAwareness.js
 * (imported by src/voice/gevActions.js). Keep in sync if the real one changes.
 */
export function contactsWindowFromSnapshot(snapshot) {
  if (!snapshot?.subject) return null;
  const countFor = (cohortId) => {
    const cohort = Array.isArray(snapshot.cohorts)
      ? snapshot.cohorts.find((item) => item?.id === cohortId)
      : null;
    return Number.isFinite(cohort?.count) ? cohort.count : 'unknown';
  };
  const flights = countFor('flights');
  const military = countFor('military');
  return {
    centeredOn: snapshot.subject.label || snapshot.subject.id || null,
    radiusKm: Number.isFinite(snapshot.radiusM)
      ? Math.round(snapshot.radiusM / 1000)
      : null,
    aircraft: Number.isFinite(flights) && Number.isFinite(military)
      ? flights + military
      : 'unknown',
    flights,
    military,
    vessels: countFor('ais-live-vessels'),
  };
}

/**
 * Same shape as the real helper, but empty: the voice analyst that calls it
 * is dev-only, and the stubbed build has no military feed to scan.
 */
export function collectAircraftProximityWindow(position) {
  if (!position) return null;
  return { flights: [], military: [], aircraft: 0 };
}

export default createInertLayer('military-awareness', 'Military Awareness', {
  attachDataManager: () => {},
});