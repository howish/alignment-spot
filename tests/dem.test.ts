import { describe, expect, it } from 'vitest';
import { bilinear, lonLatToTileXY, terrariumToElev } from '../src/dem';

describe('terrarium decoding', () => {
  it('decodes the zero-elevation reference pixel', () => {
    expect(terrariumToElev(128, 0, 0)).toBe(0);
  });
  it('decodes fractional meters from blue channel', () => {
    expect(terrariumToElev(128, 100, 128)).toBeCloseTo(100.5, 6);
  });
  it('black pixel is the -32768 sentinel floor', () => {
    expect(terrariumToElev(0, 0, 0)).toBe(-32768);
  });
});

describe('tile math', () => {
  it('maps lon/lat 0,0 to the center of the tile grid', () => {
    const { x, y } = lonLatToTileXY(0, 0, 12);
    expect(x).toBeCloseTo(2048, 6);
    expect(y).toBeCloseTo(2048, 6);
  });
  it('Taipei lands in the expected z12 tile', () => {
    const { x, y } = lonLatToTileXY(121.5654, 25.033, 12);
    expect(Math.floor(x)).toBe(3431);
    expect(Math.floor(y)).toBe(1753);
  });
});

describe('bilinear', () => {
  const grid = new Float32Array([0, 10, 20, 30]); // 2x2
  it('interpolates the center', () => {
    expect(bilinear(grid, 2, 2, 0.5, 0.5)).toBeCloseTo(15, 6);
  });
  it('returns corners exactly', () => {
    expect(bilinear(grid, 2, 2, 0, 0)).toBeCloseTo(0, 6);
  });
  it('clamps out-of-range coordinates', () => {
    expect(bilinear(grid, 2, 2, -5, -5)).toBeCloseTo(0, 6);
    expect(bilinear(grid, 2, 2, 10, 10)).toBeCloseTo(30, 1);
  });
});
