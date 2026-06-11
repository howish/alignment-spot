// Date handling anchored to the STRUCTURE's timezone, not the device's —
// planning a Japan shot from Taiwan must use Japan's local day.

import tzlookup from 'tz-lookup';

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function tzAt(lat: number, lon: number): string {
  try {
    return tzlookup(lat, lon);
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Epoch ms of local midnight starting the given calendar date in `timeZone`. */
export function zonedMidnightUtcMs(y: number, m: number, d: number, timeZone: string): number {
  let guess = Date.UTC(y, m - 1, d);
  // two iterations converge even across a DST transition
  for (let i = 0; i < 2; i++) {
    guess = Date.UTC(y, m - 1, d) - tzOffsetMs(guess, timeZone);
  }
  return guess;
}

/** [dayStart, dayEnd) of the calendar date `iso` (YYYY-MM-DD) in `timeZone`. */
export function zonedDayWindow(iso: string, timeZone: string): { startMs: number; endMs: number } {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)); // normalizes month/year rollover
  return {
    startMs: zonedMidnightUtcMs(y, m, d, timeZone),
    endMs: zonedMidnightUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  };
}

/** Calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function isoDateInTz(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  return parts; // en-CA formats as YYYY-MM-DD
}

/** Shift an ISO date by n days (calendar-safe). */
export function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}
