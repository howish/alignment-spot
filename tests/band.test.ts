import { describe, expect, it } from 'vitest';
import { buildTraceGeometry } from '../src/band';
import type { InstantSolution } from '../src/solver';

function ok(t: number, az: number, d: number, occluded = false): InstantSolution {
  return {
    t,
    az,
    bodyAlt: 5,
    semidia: 0.25,
    status: 'ok',
    spot: { lat: 24.0, lon: 121.0 + d / 100000, d, occluded },
    all: [],
    tolerance: { dMin: d - 50, dMax: d + 50 },
    approximate: false,
  };
}

const gap = (t: number): InstantSolution => ({
  t,
  az: 0,
  bodyAlt: -5,
  semidia: 0.25,
  status: 'body-too-low',
  spot: null,
  all: [],
  tolerance: null,
  approximate: false,
});

describe('buildTraceGeometry', () => {
  it('builds one line for a contiguous run', () => {
    const g = buildTraceGeometry([ok(0, 270, 1000), ok(1, 271, 1010), ok(2, 272, 1020)]);
    expect(g.clearLines.length).toBe(1);
    expect(g.clearLines[0].geometry.coordinates.length).toBe(3);
    expect(g.occludedLines.length).toBe(0);
  });

  it('splits on gaps', () => {
    const g = buildTraceGeometry([ok(0, 270, 1000), ok(1, 271, 1010), gap(2), ok(3, 280, 900), ok(4, 281, 910)]);
    expect(g.clearLines.length).toBe(2);
  });

  it('separates occluded runs and keeps them connected', () => {
    const g = buildTraceGeometry([
      ok(0, 270, 1000),
      ok(1, 271, 1010),
      ok(2, 272, 1020, true),
      ok(3, 273, 1030, true),
      ok(4, 274, 1040),
    ]);
    expect(g.clearLines.length).toBe(2);
    expect(g.occludedLines.length).toBe(1);
    // shared vertices: occluded run starts where the clear run ended
    const clearEnd = g.clearLines[0].geometry.coordinates.at(-1);
    const occStart = g.occludedLines[0].geometry.coordinates[0];
    expect(occStart).toEqual(clearEnd);
  });

  it('a single isolated ok sample produces no degenerate line', () => {
    const g = buildTraceGeometry([gap(0), ok(1, 270, 1000), gap(2)]);
    expect(g.clearLines.length).toBe(0);
    expect(g.occludedLines.length).toBe(0);
  });
});
