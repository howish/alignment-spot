import { describe, expect, it } from 'vitest';
import { bodySample, sampleDay } from '../src/ephemeris';

const TAIPEI = { lat: 25.033, lon: 121.5654 };

describe('ephemeris sanity', () => {
  it('sun is nearly overhead at Taipei solar noon on the June solstice', () => {
    // 2026-06-21 ~12:00 TST (UTC+8); Taipei lat 25.03 vs declination 23.44
    const s = bodySample('sun', new Date('2026-06-21T04:05:00Z'), TAIPEI.lat, TAIPEI.lon, 10, true);
    expect(s.alt).toBeGreaterThan(86);
    expect(s.alt).toBeLessThan(90);
  });

  it('sun is below the horizon at local midnight', () => {
    const s = bodySample('sun', new Date('2026-06-21T16:00:00Z'), TAIPEI.lat, TAIPEI.lon, 10, true);
    expect(s.alt).toBeLessThan(-10);
  });

  it('apparent semi-diameters are in the physical range', () => {
    const sun = bodySample('sun', new Date('2026-06-10T04:00:00Z'), TAIPEI.lat, TAIPEI.lon, 10, true);
    expect(sun.semidia).toBeGreaterThan(0.255);
    expect(sun.semidia).toBeLessThan(0.275);
    const moon = bodySample('moon', new Date('2026-06-10T12:00:00Z'), TAIPEI.lat, TAIPEI.lon, 10, true);
    expect(moon.semidia).toBeGreaterThan(0.24);
    expect(moon.semidia).toBeLessThan(0.29);
  });

  it('refraction lifts a near-horizon body', () => {
    // shortly after Taipei sunrise on 2026-06-10 (~21:04 UTC Jun 9)
    const t = new Date('2026-06-09T21:30:00Z');
    const refracted = bodySample('sun', t, TAIPEI.lat, TAIPEI.lon, 10, true);
    const geometric = bodySample('sun', t, TAIPEI.lat, TAIPEI.lon, 10, false);
    expect(refracted.alt).toBeGreaterThan(geometric.alt);
    expect(refracted.alt - geometric.alt).toBeGreaterThan(0.03);
    expect(refracted.alt - geometric.alt).toBeLessThan(0.7);
  });

  it('sampleDay returns one sample per step', () => {
    const start = new Date('2026-06-10T00:00:00+08:00');
    const end = new Date('2026-06-11T00:00:00+08:00');
    const samples = sampleDay('sun', start, end, 10, TAIPEI.lat, TAIPEI.lon, 10, true);
    expect(samples.length).toBe(144);
    expect(samples.some((s) => s.alt > 0)).toBe(true);
    expect(samples.some((s) => s.alt < 0)).toBe(true);
  });
});
