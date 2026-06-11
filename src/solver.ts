// The align-spot solver. Pure async functions; elevation access is injected
// so tests can run against synthetic terrain.

import type { ElevationSampler } from './dem';
import type { BodySample } from './ephemeris';
import { apparentAltitude, destination, normalizeAz, REFRACTION_K, type LatLon } from './geo';

export type AlignMode = 'bottom-touch' | 'center';

export interface SolverConfig {
  structure: LatLon & { height: number };
  eyeHeight: number;
  mode: AlignMode;
  /** meters; spots beyond this are reported as out of range */
  maxDistance: number;
  /** coarse march step, meters */
  step: number;
  /** ignore body positions at or below this altitude (deg) */
  minBodyAlt: number;
  /** apply terrestrial refraction to the tip sightline (must match the
   *  ephemeris refraction setting, or the comparison is asymmetric) */
  refraction: boolean;
}

export const DEFAULT_CONFIG: Omit<SolverConfig, 'structure'> = {
  eyeHeight: 1.6,
  mode: 'bottom-touch',
  maxDistance: 30000,
  step: 50,
  minBodyAlt: 0.1,
  refraction: true,
};

export interface Spot extends LatLon {
  /** distance from structure, meters */
  d: number;
  /** terrain blocks the sightline from here to the structure tip */
  occluded: boolean;
}

export interface InstantSolution {
  t: number;
  az: number;
  bodyAlt: number;
  semidia: number;
  status: 'ok' | 'body-too-low' | 'no-solution';
  /** nearest crossing; null unless status === 'ok' */
  spot: Spot | null;
  /** every crossing (hilly terrain can produce several) */
  all: Spot[];
  /** distance range where any part of the disk overlaps the tip */
  tolerance: { dMin: number; dMax: number } | null;
  /** true when DEM was unavailable and flat terrain was assumed */
  approximate: boolean;
}

interface Profile {
  /** distance of each sample from the structure, meters */
  d: number[];
  /** ground elevation at each sample (0 when DEM missing) */
  elev: number[];
  approximate: boolean;
}

/** beyond this, coarse DEM tiles are plenty and keep long rays cheap */
const FAR_DEM_DISTANCE = 25000;

async function marchProfile(
  cfg: SolverConfig,
  backAz: number,
  dem: ElevationSampler,
): Promise<Profile> {
  const d: number[] = [];
  const elev: number[] = [];
  let approximate = false;
  for (let dist = 0; dist <= cfg.maxDistance; dist += cfg.step) {
    const p = dist === 0 ? cfg.structure : destination(cfg.structure, backAz, dist);
    const e = await dem(p.lat, p.lon, dist > FAR_DEM_DISTANCE);
    if (e === null) approximate = true;
    d.push(dist);
    elev.push(e ?? 0);
  }
  return { d, elev, approximate };
}

const curvK = (cfg: SolverConfig) => (cfg.refraction ? REFRACTION_K : 0);

/**
 * Distances along the profile where the structure tip's apparent altitude
 * equals targetAlt — both descending and ascending crossings, since valleys
 * make the apparent altitude non-monotonic. Linear interpolation between
 * profile samples — the 50 m grid matches the DEM resolution, so refining
 * further would be noise.
 */
function findCrossings(profile: Profile, baseElev: number, cfg: SolverConfig, targetAlt: number): number[] {
  const tipH = baseElev + cfg.structure.height;
  const k = curvK(cfg);
  const out: number[] = [];
  let prev: number | null = null;
  for (let i = 1; i < profile.d.length; i++) {
    const obsH = profile.elev[i] + cfg.eyeHeight;
    const f = apparentAltitude(obsH, tipH, profile.d[i], k) - targetAlt;
    if (prev !== null && ((prev > 0 && f <= 0) || (prev < 0 && f >= 0))) {
      const frac = Math.abs(prev) / Math.abs(prev - f);
      out.push(profile.d[i - 1] + frac * (profile.d[i] - profile.d[i - 1]));
    }
    prev = f;
  }
  return out;
}

/** True if terrain between the observer (at distance d) and the tip blocks the sightline. */
function isOccluded(profile: Profile, baseElev: number, cfg: SolverConfig, d: number): boolean {
  const tipH = baseElev + cfg.structure.height;
  const k = curvK(cfg);
  const iObs = Math.min(Math.round(d / cfg.step), profile.d.length - 1);
  const obsH = profile.elev[iObs] + cfg.eyeHeight;
  const tipAlt = apparentAltitude(obsH, tipH, d, k);
  for (let i = 1; i < iObs; i++) {
    const s = d - profile.d[i]; // distance from observer to intermediate point
    if (s <= 0) break;
    if (apparentAltitude(obsH, profile.elev[i], s, k) > tipAlt) return true;
  }
  return false;
}

const tooLow = (body: BodySample): InstantSolution => ({
  t: body.t,
  az: body.az,
  bodyAlt: body.alt,
  semidia: body.semidia,
  status: 'body-too-low',
  spot: null,
  all: [],
  tolerance: null,
  approximate: false,
});

/** Solve one instant against an already-marched terrain profile. */
function solveFromProfile(cfg: SolverConfig, body: BodySample, backAz: number, profile: Profile): InstantSolution {
  const base: Omit<InstantSolution, 'status' | 'spot' | 'all' | 'tolerance' | 'approximate'> = {
    t: body.t,
    az: body.az,
    bodyAlt: body.alt,
    semidia: body.semidia,
  };
  const baseElev = profile.elev[0];

  // Where the disk's reference point sits on the tip…
  const targetAlt = cfg.mode === 'bottom-touch' ? body.alt - body.semidia : body.alt;
  // …and the full range where any part of the disk still touches the tip.
  const crossings = findCrossings(profile, baseElev, cfg, targetAlt);
  if (crossings.length === 0) {
    return { ...base, status: 'no-solution', spot: null, all: [], tolerance: null, approximate: profile.approximate };
  }

  const toSpot = (d: number): Spot => ({
    ...destination(cfg.structure, backAz, d),
    d,
    occluded: isOccluded(profile, baseElev, cfg, d),
  });
  const all = crossings.map(toSpot);

  // Pair the disk-edge crossings that belong to the primary spot's hump —
  // on hilly profiles each target altitude can cross several times and
  // taking the first of each would mix unrelated humps.
  const primaryD = all[0].d;
  const nearestTo = (arr: number[], ref: number): number | null =>
    arr.length ? arr.reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a)) : null;
  const hi = nearestTo(findCrossings(profile, baseElev, cfg, body.alt + body.semidia), primaryD);
  const lo = nearestTo(findCrossings(profile, baseElev, cfg, body.alt - body.semidia), primaryD);
  const tolerance =
    hi !== null && lo !== null ? { dMin: Math.min(hi, lo), dMax: Math.max(hi, lo) } : null;

  return {
    ...base,
    status: 'ok',
    spot: all[0],
    all,
    tolerance,
    approximate: profile.approximate,
  };
}

export async function solveInstant(
  cfg: SolverConfig,
  body: BodySample,
  dem: ElevationSampler,
): Promise<InstantSolution> {
  return (await solveInstantHeights(cfg, [cfg.structure.height], body, dem))[0];
}

/**
 * Solve one instant for several structure heights at once. The terrain march
 * along the back-azimuth is height-independent, so the (DEM-bound) profile is
 * built once and reused — N heights cost barely more than one.
 */
export async function solveInstantHeights(
  cfg: SolverConfig,
  heights: number[],
  body: BodySample,
  dem: ElevationSampler,
): Promise<InstantSolution[]> {
  if (body.alt <= cfg.minBodyAlt) return heights.map(() => tooLow(body));
  const backAz = normalizeAz(body.az + 180);
  const profile = await marchProfile(cfg, backAz, dem);
  return heights.map((h) =>
    solveFromProfile({ ...cfg, structure: { ...cfg.structure, height: h } }, body, backAz, profile),
  );
}

/**
 * Solve a full day of samples for one or more heights; onProgress(0..1)
 * fires between instants. Output: one array per height, each matching the
 * input sample order. `shouldAbort` lets a superseded request stop wasting
 * tile fetches; the partial result is returned (caller drops it).
 */
export async function solveDayHeights(
  cfg: SolverConfig,
  heights: number[],
  samples: BodySample[],
  dem: ElevationSampler,
  onProgress?: (frac: number) => void,
  shouldAbort?: () => boolean,
): Promise<InstantSolution[][]> {
  const out: InstantSolution[][] = heights.map(() => []);
  for (let i = 0; i < samples.length; i++) {
    if (shouldAbort?.()) break;
    const sols = await solveInstantHeights(cfg, heights, samples[i], dem);
    sols.forEach((s, h) => out[h].push(s));
    if (onProgress && i % 20 === 0) onProgress(i / samples.length);
  }
  return out;
}

export async function solveDay(
  cfg: SolverConfig,
  samples: BodySample[],
  dem: ElevationSampler,
  onProgress?: (frac: number) => void,
  shouldAbort?: () => boolean,
): Promise<InstantSolution[]> {
  return (await solveDayHeights(cfg, [cfg.structure.height], samples, dem, onProgress, shouldAbort))[0];
}
