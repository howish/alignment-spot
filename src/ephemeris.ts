// Thin wrapper over astronomy-engine: topocentric azimuth/altitude and
// apparent semi-diameter for the sun and moon.

import { Body, Equator, Horizon, Observer } from 'astronomy-engine';
import { normalizeAz } from './geo';

export type BodyKind = 'sun' | 'moon';

export interface BodySample {
  /** epoch ms */
  t: number;
  /** topocentric azimuth, deg from north */
  az: number;
  /** topocentric altitude, deg; refracted if requested */
  alt: number;
  /** apparent angular semi-diameter, deg */
  semidia: number;
}

const SUN_RADIUS_KM = 695700;
const MOON_RADIUS_KM = 1737.4;
const AU_KM = 149597870.7;

export function bodySample(
  kind: BodyKind,
  date: Date,
  lat: number,
  lon: number,
  elevM: number,
  refraction: boolean,
): BodySample {
  const observer = new Observer(lat, lon, elevM);
  const body = kind === 'sun' ? Body.Sun : Body.Moon;
  // ofdate=true + observer => topocentric place (includes lunar parallax)
  const eq = Equator(body, date, observer, true, true);
  const hor = Horizon(date, observer, eq.ra, eq.dec, refraction ? 'normal' : undefined);
  const distKm = eq.dist * AU_KM;
  const radiusKm = kind === 'sun' ? SUN_RADIUS_KM : MOON_RADIUS_KM;
  const semidia = (Math.asin(radiusKm / distKm) * 180) / Math.PI;
  return { t: date.getTime(), az: normalizeAz(hor.azimuth), alt: hor.altitude, semidia };
}

/**
 * Sample the body each `stepMin` minutes across [dayStart, dayEnd).
 * Returns every sample (including below-horizon ones — the solver filters).
 */
export function sampleDay(
  kind: BodyKind,
  dayStart: Date,
  dayEnd: Date,
  stepMin: number,
  lat: number,
  lon: number,
  elevM: number,
  refraction: boolean,
): BodySample[] {
  const out: BodySample[] = [];
  for (let t = dayStart.getTime(); t < dayEnd.getTime(); t += stepMin * 60000) {
    out.push(bodySample(kind, new Date(t), lat, lon, elevM, refraction));
  }
  return out;
}
