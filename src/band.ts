// Build map geometry (GeoJSON) from solver output. Pure — unit-tested.
// Two pieces: the trace line (primary spot path over time, split into
// clear/occluded runs) and the band (the swept disk-tolerance corridor).

import { destination, normalizeAz, type LatLon } from './geo';
import type { InstantSolution } from './solver';

type Position = [number, number]; // lon, lat

export interface BandGeometry {
  /** swept tolerance corridor, one polygon per contiguous run */
  band: GeoJSON.Feature<GeoJSON.Polygon>[];
  /** primary spot trajectory, split into clear / occluded runs */
  clearLines: GeoJSON.Feature<GeoJSON.LineString>[];
  occludedLines: GeoJSON.Feature<GeoJSON.LineString>[];
}

const pos = (p: LatLon): Position => [p.lon, p.lat];

export interface BranchGeometry {
  clear: GeoJSON.Feature<GeoJSON.LineString>[];
  occluded: GeoJSON.Feature<GeoJSON.LineString>[];
}

/**
 * Trace EVERY crossing (not just the nearest) over time as thin branch lines.
 * Branch identity across minutes is recovered by greedy nearest-distance
 * matching; at shallow body altitudes a far solution can sweep kilometers per
 * minute, so the tolerance is relative — anything beyond it starts a new run
 * rather than drawing a false connection.
 */
export function buildBranchGeometry(solutions: InstantSolution[]): BranchGeometry {
  interface Run {
    lastD: number;
    occluded: boolean;
    coords: Position[];
  }
  const clear: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  const occluded: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  let active: Run[] = [];

  const finalize = (run: Run) => {
    if (run.coords.length >= 2) {
      (run.occluded ? occluded : clear).push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: run.coords },
      });
    }
  };
  const finalizeAll = () => {
    active.forEach(finalize);
    active = [];
  };

  for (const s of solutions) {
    if (s.status !== 'ok' || s.all.length === 0) {
      finalizeAll();
      continue;
    }
    const matchTol = (a: number, b: number) => Math.max(1000, 0.25 * Math.min(a, b));
    const taken = new Set<Run>();
    const next: Run[] = [];
    for (const spot of s.all) {
      let best: Run | null = null;
      for (const run of active) {
        if (taken.has(run)) continue;
        const diff = Math.abs(spot.d - run.lastD);
        if (diff <= matchTol(spot.d, run.lastD) && (!best || diff < Math.abs(spot.d - best.lastD))) {
          best = run;
        }
      }
      const p = pos(spot);
      if (best) {
        taken.add(best);
        if (best.occluded !== spot.occluded) {
          const last = best.coords[best.coords.length - 1];
          finalize(best);
          best.coords = [last]; // shared vertex so the styled runs connect
          best.occluded = spot.occluded;
        }
        best.coords.push(p);
        best.lastD = spot.d;
        next.push(best);
      } else {
        next.push({ lastD: spot.d, occluded: spot.occluded, coords: [p] });
      }
    }
    for (const run of active) if (!taken.has(run)) finalize(run);
    active = next;
  }
  finalizeAll();
  return { clear, occluded };
}

export function buildBandGeometry(structure: LatLon, solutions: InstantSolution[]): BandGeometry {
  const band: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  const clearLines: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  const occludedLines: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  let near: Position[] = [];
  let far: Position[] = [];
  let run: Position[] = [];
  let runOccluded = false;

  const flushBand = () => {
    if (near.length >= 2) {
      const ring = [...near, ...far.slice().reverse()];
      ring.push(ring[0]);
      band.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    near = [];
    far = [];
  };
  const flushRun = () => {
    if (run.length >= 2) {
      (runOccluded ? occludedLines : clearLines).push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: run },
      });
    }
    run = [];
  };

  for (const s of solutions) {
    if (s.status !== 'ok' || !s.spot) {
      flushBand();
      flushRun();
      continue;
    }
    const backAz = normalizeAz(s.az + 180);
    if (s.tolerance) {
      near.push(pos(destination(structure, backAz, s.tolerance.dMin)));
      far.push(pos(destination(structure, backAz, s.tolerance.dMax)));
    } else {
      flushBand();
    }
    const p = pos(s.spot);
    if (run.length && s.spot.occluded !== runOccluded) {
      const last = run[run.length - 1];
      flushRun();
      run.push(last); // shared vertex so consecutive runs connect
    }
    runOccluded = s.spot.occluded;
    run.push(p);
  }
  flushBand();
  flushRun();
  return { band, clearLines, occludedLines };
}
