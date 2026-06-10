// Web Worker: owns the DEM tile cache and runs the day solver off the main
// thread. Protocol: {type:'solve', req} in; {type:'progress'|'result'} out.

import { createTileSampler } from './dem';
import { sampleDay, type BodyKind } from './ephemeris';
import { DEFAULT_CONFIG, solveDay, type AlignMode, type InstantSolution } from './solver';

export interface SolveRequest {
  id: number;
  structure: { lat: number; lon: number; height: number };
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
  };
  const solutions = await solveDay(
    cfg,
    samples,
    dem,
    (frac) => {
      if (currentId === req.id) self.postMessage({ type: 'progress', id: req.id, frac });
    },
    () => currentId !== req.id, // bail out as soon as a newer request lands
  );
  // A newer request may have started while this one was solving; stale
  // results are dropped here rather than flickering the UI.
  if (currentId === req.id) {
    self.postMessage({ type: 'result', id: req.id, solutions } satisfies SolveResult & { type: string });
  }
};
