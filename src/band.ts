// Build map geometry (GeoJSON) from a day of solver output. Pure — unit-tested.

import { destination, normalizeAz, type LatLon } from './geo';
import type { InstantSolution } from './solver';

type Position = [number, number]; // lon, lat

export interface BandGeometry {
  /** swept tolerance band, one polygon per contiguous ok-run */
  band: GeoJSON.Feature<GeoJSON.Polygon>[];
  /** primary spot trajectory, split into clear / occluded runs */
  clearLines: GeoJSON.Feature<GeoJSON.LineString>[];
  occludedLines: GeoJSON.Feature<GeoJSON.LineString>[];
}

const pos = (p: LatLon): Position => [p.lon, p.lat];

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
