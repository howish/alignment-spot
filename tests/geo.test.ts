import { describe, expect, it } from 'vitest';
import { apparentAltitude, compass, destination, distanceM, EFFECTIVE_RADIUS } from '../src/geo';

describe('geo', () => {
  it('destination/distance round-trip', () => {
    const start = { lat: 25.0, lon: 121.5 };
    const p = destination(start, 73, 12345);
    expect(distanceM(start, p)).toBeCloseTo(12345, 0);
  });

  it('destination north moves latitude only', () => {
    const p = destination({ lat: 0, lon: 0 }, 0, 111195); // ~1 deg of latitude
    expect(p.lat).toBeCloseTo(1, 3);
    expect(p.lon).toBeCloseTo(0, 6);
  });

  it('apparentAltitude matches plain atan at short range', () => {
    // 100 m tower seen from 1 km: curvature drop is ~7 cm, negligible
    const alt = apparentAltitude(1.6, 100, 1000);
    expect(alt).toBeCloseTo((Math.atan(98.4 / 1000) * 180) / Math.PI, 2);
  });

  it('apparentAltitude includes curvature at long range', () => {
    const noCurve = (Math.atan(98.4 / 30000) * 180) / Math.PI;
    const withCurve = apparentAltitude(1.6, 100, 30000);
    const dropDeg = (Math.atan(30000 / (2 * EFFECTIVE_RADIUS)) * 180) / Math.PI;
    expect(withCurve).toBeLessThan(noCurve);
    expect(noCurve - withCurve).toBeCloseTo(dropDeg, 1);
  });

  it('compass names', () => {
    expect(compass(0)).toBe('N');
    expect(compass(359)).toBe('N');
    expect(compass(225)).toBe('SW');
  });

  it('compass handles negatives and sector boundaries', () => {
    expect(compass(-1)).toBe('N');
    expect(compass(-90)).toBe('W');
    expect(compass(348.7)).toBe('NNW');
    expect(compass(348.8)).toBe('N');
  });

  it('refraction k=0 lowers the apparent altitude at long range', () => {
    const withK = apparentAltitude(1.6, 100, 20000);
    const noK = apparentAltitude(1.6, 100, 20000, 0);
    expect(noK).toBeLessThan(withK); // more curvature drop without refraction
  });
});
