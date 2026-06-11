// Build trace-line geometry (GeoJSON) from solver output. Pure — unit-tested.
// The trace is the primary spot's path over time, split into clear / occluded
// runs so the renderer can gray out stretches with no sightline.

import type { InstantSolution } from './solver';

type Position = [number, number]; // lon, lat

export interface TraceGeometry {
  clearLines: GeoJSON.Feature<GeoJSON.LineString>[];
  occludedLines: GeoJSON.Feature<GeoJSON.LineString>[];
}

export function buildTraceGeometry(solutions: InstantSolution[]): TraceGeometry {
  const clearLines: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  const occludedLines: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  let run: Position[] = [];
  let runOccluded = false;

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
      flushRun();
      continue;
    }
    const p: Position = [s.spot.lon, s.spot.lat];
    if (run.length && s.spot.occluded !== runOccluded) {
      const last = run[run.length - 1];
      flushRun();
      run.push(last); // shared vertex so consecutive runs connect
    }
    runOccluded = s.spot.occluded;
    run.push(p);
  }
  flushRun();
  return { clearLines, occludedLines };
}
