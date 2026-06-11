import { describe, expect, it } from 'vitest';
import { buildBandGeometry } from '../src/band';
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

const STRUCT = { lat: 24.0, lon: 121.0 };

describe('buildBandGeometry', () => {
  it('builds one closed polygon and one line for a contiguous run', () => {
    const g = buildBandGeometry(STRUCT, [ok(0, 270, 1000), ok(1, 271, 1010), ok(2, 272, 1020)]);
    expect(g.band.length).toBe(1);
    const ring = g.band[0].geometry.coordinates[0];
    expect(ring.length).toBe(7); // 3 near + 3 far + closing vertex
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(g.clearLines.length).toBe(1);
    expect(g.clearLines[0].geometry.coordinates.length).toBe(3);
    expect(g.occludedLines.length).toBe(0);
  });

  it('splits on gaps', () => {
    const g = buildBandGeometry(STRUCT, [ok(0, 270, 1000), ok(1, 271, 1010), gap(2), ok(3, 280, 900), ok(4, 281, 910)]);
    expect(g.band.length).toBe(2);
    expect(g.clearLines.length).toBe(2);
  });

  it('separates occluded runs and keeps them connected', () => {
    const g = buildBandGeometry(STRUCT, [
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

  it('a single isolated ok sample produces no degenerate geometry', () => {
    const g = buildBandGeometry(STRUCT, [gap(0), ok(1, 270, 1000), gap(2)]);
    expect(g.band.length).toBe(0);
    expect(g.clearLines.length).toBe(0);
    expect(g.occludedLines.length).toBe(0);
  });
});

import { buildBranchGeometry } from '../src/band';

function okMulti(t: number, ds: { d: number; occluded?: boolean }[]): InstantSolution {
  const spots = ds.map(({ d, occluded = false }) => ({ lat: 24.0, lon: 121.0 + d / 100000, d, occluded }));
  return {
    t,
    az: 270,
    bodyAlt: 5,
    semidia: 0.25,
    status: 'ok',
    spot: spots[0],
    all: spots,
    tolerance: null,
    approximate: false,
  };
}

describe('buildBranchGeometry', () => {
  it('traces parallel branches with per-branch occlusion styling', () => {
    const g = buildBranchGeometry([
      okMulti(0, [{ d: 1000 }, { d: 5000, occluded: true }]),
      okMulti(1, [{ d: 1010 }, { d: 5100, occluded: true }]),
      okMulti(2, [{ d: 1020 }, { d: 5200, occluded: true }]),
    ]);
    expect(g.clear.length).toBe(1);
    expect(g.clear[0].geometry.coordinates.length).toBe(3);
    expect(g.occluded.length).toBe(1);
    expect(g.occluded[0].geometry.coordinates.length).toBe(3);
  });

  it('starts a new run when a branch appears mid-sequence', () => {
    const g = buildBranchGeometry([
      okMulti(0, [{ d: 1000 }]),
      okMulti(1, [{ d: 1010 }, { d: 5000 }]),
      okMulti(2, [{ d: 1020 }, { d: 5050 }]),
    ]);
    expect(g.clear.length).toBe(2);
    const lengths = g.clear.map((l) => l.geometry.coordinates.length).sort();
    expect(lengths).toEqual([2, 3]);
  });

  it('breaks the line on a distance jump beyond tolerance', () => {
    const g = buildBranchGeometry([
      okMulti(0, [{ d: 5000 }]),
      okMulti(1, [{ d: 5050 }]),
      okMulti(2, [{ d: 12000 }]), // 7 km jump >> 25% tolerance: no false connection
      okMulti(3, [{ d: 12100 }]),
    ]);
    expect(g.clear.length).toBe(2);
    for (const line of g.clear) expect(line.geometry.coordinates.length).toBe(2);
  });
});
