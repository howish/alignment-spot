import { describe, expect, it } from 'vitest';
import { isoDate, isoDateInTz, shiftIsoDate, tzAt, zonedDayWindow, zonedMidnightUtcMs } from '../src/time';

describe('isoDate', () => {
  it('zero-pads', () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('shiftIsoDate', () => {
  it('rolls over month and year boundaries', () => {
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftIsoDate('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftIsoDate('2024-02-28', 1)).toBe('2024-02-29'); // leap year
  });
});

describe('tzAt', () => {
  it('resolves Taiwan and Japan', () => {
    expect(tzAt(25.03, 121.56)).toBe('Asia/Taipei');
    expect(tzAt(35.68, 139.76)).toBe('Asia/Tokyo');
  });
});

describe('isoDateInTz', () => {
  it('reports the calendar date in the given zone', () => {
    // 2026-06-10T20:00Z = 2026-06-11 04:00 in Taipei
    const ms = Date.UTC(2026, 5, 10, 20);
    expect(isoDateInTz(ms, 'Asia/Taipei')).toBe('2026-06-11');
    expect(isoDateInTz(ms, 'UTC')).toBe('2026-06-10');
  });
});

describe('zoned day window', () => {
  it('Taipei local midnight is 16:00 UTC the previous day', () => {
    expect(zonedMidnightUtcMs(2026, 6, 10, 'Asia/Taipei')).toBe(Date.UTC(2026, 5, 9, 16));
  });

  it('a Taipei day window is exactly 24h (no DST)', () => {
    const { startMs, endMs } = zonedDayWindow('2026-06-10', 'Asia/Taipei');
    expect(endMs - startMs).toBe(86400000);
    expect(startMs).toBe(Date.UTC(2026, 5, 9, 16));
  });

  it('a US DST spring-forward day is 23h', () => {
    const { startMs, endMs } = zonedDayWindow('2026-03-08', 'America/New_York');
    expect(endMs - startMs).toBe(23 * 3600000);
  });

  it('year rollover via zonedDayWindow end', () => {
    const { endMs } = zonedDayWindow('2026-12-31', 'Asia/Taipei');
    expect(endMs).toBe(Date.UTC(2026, 11, 31, 16));
  });
});
