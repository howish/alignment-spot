// Spherical-earth helpers. Distances are meters, angles degrees unless noted.

export const EARTH_RADIUS = 6371000;
// Standard refraction coefficient for terrestrial sightlines; the effective
// earth radius trick folds atmospheric bending of the line of sight into a
// larger sphere.
export const REFRACTION_K = 0.13;
export const EFFECTIVE_RADIUS = EARTH_RADIUS / (1 - REFRACTION_K);

export interface LatLon {
  lat: number;
  lon: number;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Destination point given start, initial bearing (deg) and distance (m). */
export function destination(start: LatLon, bearingDeg: number, distance: number): LatLon {
  const δ = distance / EARTH_RADIUS;
  const θ = bearingDeg * D2R;
  const φ1 = start.lat * D2R;
  const λ1 = start.lon * D2R;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2);
  return { lat: φ2 * R2D, lon: ((λ2 * R2D + 540) % 360) - 180 };
}

/** Great-circle distance in meters. */
export function distanceM(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * D2R;
  const φ2 = b.lat * D2R;
  const Δφ = (b.lat - a.lat) * D2R;
  const Δλ = (b.lon - a.lon) * D2R;
  const h =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

/**
 * Apparent altitude (deg) of a point at height `targetH` above the ellipsoid,
 * seen from an observer at height `obsH`, horizontal distance `d` meters away.
 * Includes earth curvature, plus terrestrial refraction when `k` > 0 — pass
 * k=0 to stay consistent with an unrefracted body altitude.
 */
export function apparentAltitude(obsH: number, targetH: number, d: number, k = REFRACTION_K): number {
  if (d <= 0) return targetH > obsH ? 90 : -90;
  const drop = (d * d) / (2 * (EARTH_RADIUS / (1 - k)));
  return Math.atan2(targetH - obsH - drop, d) * R2D;
}

export function normalizeAz(az: number): number {
  return ((az % 360) + 360) % 360;
}

export function compass(az: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(normalizeAz(az) / 22.5) % 16];
}
