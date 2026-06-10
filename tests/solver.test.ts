import { describe, expect, it } from 'vitest';
import type { ElevationSampler } from '../src/dem';
import { bodySample, sampleDay, type BodySample } from '../src/ephemeris';
import { apparentAltitude, distanceM, normalizeAz } from '../src/geo';
import { DEFAULT_CONFIG, solveDay, solveInstant, type SolverConfig } from '../src/solver';

const STRUCT = { lat: 24.0, lon: 121.0, height: 100 };
const cfg: SolverConfig = { ...DEFAULT_CONFIG, structure: STRUCT };

const flat: ElevationSampler = async () => 0;
const noDem: ElevationSampler = async () => null;

const body = (alt: number, az = 270, semidia = 0.25): BodySample => ({
  t: 1750000000000,
  az,
  alt,
  semidia,
});

describe('solveInstant on flat terrain', () => {
  it('recovers a known distance (bottom-touch mode)', async () => {
    // Place the answer at exactly 1 km and ask the solver to find it back.
    const dTrue = 1000;
    const tipAlt = apparentAltitude(cfg.eyeHeight, STRUCT.height, dTrue);
    const sol = await solveInstant(cfg, body(tipAlt + 0.25), flat);
    expect(sol.status).toBe('ok');
    expect(sol.spot!.d).toBeCloseTo(dTrue, -1); // within ~5 m
    // spot must lie opposite the body: az 270 -> spot due east of structure
    expect(distanceM(STRUCT, sol.spot!)).toBeCloseTo(sol.spot!.d, 0);
    expect(sol.spot!.lon).toBeGreaterThan(STRUCT.lon);
  });

  it('center mode puts the spot farther than bottom-touch for the same body', async () => {
    const b = body(3);
    const bottom = await solveInstant(cfg, b, flat);
    const center = await solveInstant({ ...cfg, mode: 'center' }, b, flat);
    expect(bottom.status).toBe('ok');
    expect(center.status).toBe('ok');
    // center targets a higher tip altitude than bottom-touch(alt-semi) -> closer
    expect(center.spot!.d).toBeLessThan(bottom.spot!.d);
  });

  it('tolerance brackets the primary spot', async () => {
    const sol = await solveInstant(cfg, body(3), flat);
    expect(sol.tolerance).not.toBeNull();
    expect(sol.tolerance!.dMin).toBeLessThanOrEqual(sol.spot!.d + 1);
    expect(sol.tolerance!.dMax).toBeGreaterThanOrEqual(sol.spot!.d - 1);
  });

  it('rejects a body below the horizon', async () => {
    const sol = await solveInstant(cfg, body(-1), flat);
    expect(sol.status).toBe('body-too-low');
  });

  it('reports no solution when the body is too high (spot inside first step)', async () => {
    const sol = await solveInstant(cfg, body(80), flat);
    expect(sol.status).toBe('no-solution');
  });

  it('reports no solution when the spot would be beyond max range', async () => {
    // target tip altitude 0.05 deg is lower than the apparent altitude even at 30 km
    const sol = await solveInstant(cfg, body(0.3), flat);
    expect(sol.status).toBe('no-solution');
  });

  it('falls back to approximate flat terrain when DEM is unavailable', async () => {
    const sol = await solveInstant(cfg, body(3), noDem);
    expect(sol.status).toBe('ok');
    expect(sol.approximate).toBe(true);
  });
});

describe('spot direction (all quadrants)', () => {
  // A wrong sign here walks the user to the opposite side of the structure.
  it.each([
    { az: 0, check: (s: { lat: number; lon: number }) => s.lat < STRUCT.lat }, // body N -> stand S
    { az: 90, check: (s: { lat: number; lon: number }) => s.lon < STRUCT.lon }, // body E -> stand W
    { az: 180, check: (s: { lat: number; lon: number }) => s.lat > STRUCT.lat }, // body S -> stand N
    { az: 270, check: (s: { lat: number; lon: number }) => s.lon > STRUCT.lon }, // body W -> stand E
  ])('body at az $az puts the spot on the opposite side', async ({ az, check }) => {
    const sol = await solveInstant(cfg, body(5, az), flat);
    expect(sol.status).toBe('ok');
    expect(check(sol.spot!)).toBe(true);
  });
});

describe('terrain effects', () => {
  // A 95 m hill 200-400 m east of the structure, between it and the spot.
  const hill: ElevationSampler = async (lat, lon) => {
    const d = distanceM(STRUCT, { lat, lon });
    return d > 150 && d < 450 ? 95 : 0;
  };

  it('flags spots behind the hill as occluded', async () => {
    const flatSol = await solveInstant(cfg, body(5), flat);
    const hillSol = await solveInstant(cfg, body(5, 270), hill);
    expect(flatSol.spot!.occluded).toBe(false);
    expect(hillSol.status).toBe('ok');
    // nearest crossing climbs the hill slope itself — visible, not occluded
    expect(hillSol.spot!.d).toBeLessThan(450);
    expect(hillSol.spot!.occluded).toBe(false);
    // the far crossing (past the hill, near the flat-terrain distance) is blocked
    const far = hillSol.all.find((s) => s.d > 1000);
    expect(far).toBeDefined();
    expect(far!.occluded).toBe(true);
  });

  it('finds ascending crossings coming off a hill (3 crossings total)', async () => {
    // body alt 10.25 / semi 0.25 -> target tip altitude 10 deg.
    // f(d): +23 deg at 150 m, -2.7 on the hill (~300 m), +2.3 past it (~450 m),
    // 0 again at ~560 m -> descending, ASCENDING, descending. The middle one
    // is a legitimate standing spot that a descending-only scan misses.
    const sol = await solveInstant(cfg, body(10.25), hill);
    expect(sol.status).toBe('ok');
    expect(sol.all.length).toBe(3);
    const ascending = sol.all[1];
    expect(ascending.d).toBeGreaterThan(400);
    expect(ascending.d).toBeLessThan(500);
  });

  it('returns ok with null tolerance when only the disk edge is out of range', async () => {
    // center mode, body alt 0.3: the center crossing (~15 km) and upper-edge
    // crossing exist, but the lower edge (0.05 deg) never gets that low
    // within 30 km -> tolerance must degrade to null, not lie.
    const sol = await solveInstant({ ...cfg, mode: 'center' }, body(0.3), flat);
    expect(sol.status).toBe('ok');
    expect(sol.tolerance).toBeNull();
  });

  it('observer elevation shifts the spot', async () => {
    // Observer standing on a 50 m plateau sees the tip under a smaller angle,
    // so the same body altitude puts the spot closer than on flat ground.
    const plateau: ElevationSampler = async (lat, lon) =>
      distanceM(STRUCT, { lat, lon }) > 100 ? 50 : 0;
    const flatSol = await solveInstant(cfg, body(4), flat);
    const upSol = await solveInstant(cfg, body(4), plateau);
    expect(upSol.status).toBe('ok');
    expect(upSol.spot!.d).toBeLessThan(flatSol.spot!.d);
  });
});

describe('end-to-end with real ephemeris', () => {
  it('solves a real moon position and the result is self-consistent', async () => {
    // find a moment on 2026-06-10 (Taipei) where the moon sits at a usable altitude
    const samples = sampleDay('moon', new Date('2026-06-09T16:00:00Z'), new Date('2026-06-10T16:00:00Z'), 30, STRUCT.lat, STRUCT.lon, 0, true);
    const usable = samples.find((s) => s.alt > 2 && s.alt < 20);
    expect(usable).toBeDefined();
    const sol = await solveInstant(cfg, usable!, flat);
    expect(sol.status).toBe('ok');
    // invertibility: at the returned distance, the tip's apparent altitude
    // must equal the moon's lower limb altitude (bottom-touch mode)
    const tipAlt = apparentAltitude(cfg.eyeHeight, STRUCT.height, sol.spot!.d);
    expect(tipAlt).toBeCloseTo(usable!.alt - usable!.semidia, 2);
    // and the spot must sit on the back-azimuth ray
    expect(distanceM(STRUCT, sol.spot!)).toBeCloseTo(sol.spot!.d, 0);
  });

  it('moon semidiameter feeds the tolerance band width', async () => {
    const moon = bodySample('moon', new Date('2026-06-10T12:00:00Z'), STRUCT.lat, STRUCT.lon, 0, true);
    const fake: BodySample = { ...moon, alt: 5, az: 270 };
    const sol = await solveInstant(cfg, fake, flat);
    expect(sol.status).toBe('ok');
    expect(sol.tolerance!.dMax - sol.tolerance!.dMin).toBeGreaterThan(50);
  });
});

describe('solveDay', () => {
  it('preserves input order and reports monotonic progress', async () => {
    const samples: BodySample[] = [body(-2), body(3), body(-1), body(6), body(9)];
    const progress: number[] = [];
    const sols = await solveDay(cfg, samples, flat, (f) => progress.push(f));
    expect(sols.length).toBe(samples.length);
    sols.forEach((s, i) => expect(s.t).toBe(samples[i].t));
    expect(sols.map((s) => s.status)).toEqual(['body-too-low', 'ok', 'body-too-low', 'ok', 'ok']);
    expect(progress.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= progress[i - 1]))).toBe(true);
  });

  it('stops early when aborted', async () => {
    let calls = 0;
    const sols = await solveDay(cfg, [body(3), body(4), body(5)], flat, undefined, () => ++calls > 1);
    expect(sols.length).toBe(1);
  });
});

describe('refraction consistency', () => {
  it('refraction=false changes the spot distance near the horizon', async () => {
    const b = body(1.0);
    const on = await solveInstant(cfg, b, flat);
    const off = await solveInstant({ ...cfg, refraction: false }, b, flat);
    expect(on.status).toBe('ok');
    expect(off.status).toBe('ok');
    // without refraction the sightline drops faster -> different crossing
    expect(Math.abs(on.spot!.d - off.spot!.d)).toBeGreaterThan(10);
  });
});

describe('azimuth normalization in solver', () => {
  it('back azimuth wraps correctly', () => {
    expect(normalizeAz(350 + 180)).toBe(170);
    expect(normalizeAz(-90)).toBe(270);
  });
});
