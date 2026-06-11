// Web Worker: owns the DEM tile cache and runs the day solver off the main
// thread. Protocol: {type:'solve', req} in; {type:'progress'|'result'} out.

import { createTileSampler } from './dem';
import { sampleDay, type BodyKind } from './ephemeris';
import { DEFAULT_CONFIG, solveDayHeights, type AlignMode, type InstantSolution } from './solver';

export interface SolveRequest {
  id: number;
  /** 'base' (default) or 'refine' — echoed back so the UI can route results */
  tag?: 'base' | 'refine';
  structure: { lat: number; lon: number; height: number };
  /** search range in meters (solver maxDistance); default 30 km */
  maxDistance?: number;
  kind: BodyKind;
  dayStartMs: number;
  dayEndMs: number;
  stepMin: number;
  eyeHeight: number;
  mode: AlignMode;
  refraction: boolean;
}

export interface SolveResult {
  id: number;
  solutions: InstantSolution[];
}

const dem = createTileSampler();
let currentId = 0;

self.onmessage = async (ev: MessageEvent<{ type: 'solve'; req: SolveRequest }>) => {
  if (ev.data.type !== 'solve') return;
  const req = ev.data.req;
  currentId = req.id;

  const structElev = (await dem(req.structure.lat, req.structure.lon)) ?? 0;
  const samples = sampleDay(
    req.kind,
    new Date(req.dayStartMs),
    new Date(req.dayEndMs),
    req.stepMin,
    req.structure.lat,
    req.structure.lon,
    structElev,
    req.refraction,
  );

  const cfg = {
    ...DEFAULT_CONFIG,
    structure: req.structure,
    eyeHeight: req.eyeHeight,
    mode: req.mode,
    refraction: req.refraction,
    ...(req.maxDistance ? { maxDistance: req.maxDistance } : {}),
  };
  const aborted = () => currentId !== req.id; // bail as soon as a newer request lands
  const layers = await solveDayHeights(
    cfg,
    [req.structure.height],
    samples,
    dem,
    (frac) => {
      if (!aborted()) self.postMessage({ type: 'progress', id: req.id, tag: req.tag ?? 'base', frac });
    },
    aborted,
  );
  const solutions = layers[0];
  // A newer request may have started while this one was solving; stale
  // results are dropped here rather than flickering the UI.
  if (!aborted()) {
    self.postMessage({
      type: 'result',
      id: req.id,
      tag: req.tag ?? 'base',
      solutions,
    } satisfies SolveResult & { type: string; tag: string });
  }
};
