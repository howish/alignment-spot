import { buildTraceGeometry } from './band';
import { compass, type LatLon } from './geo';
import { getLang, LANGS, setLang, t } from './i18n';
import { createMap } from './map';
import type { InstantSolution } from './solver';
import { wireSearch } from './search';
import { isoDate, isoDateInTz, shiftIsoDate, tzAt, zonedDayWindow } from './time';
import type { SolveRequest } from './worker';
import SolverWorker from './worker?worker';
import './style.css';

type Kind = 'sun' | 'moon';
type Mode = 'bottom-touch' | 'center';

interface AppState {
  structure: LatLon | null;
  /** target height in meters — pinned in the bottom bar, survives pin moves */
  height: number;
  /** side-bar alignment height (0..height); null = follow the typed height */
  adjHeight: number | null;
  kind: Kind;
  date: string; // YYYY-MM-DD local
  mode: Mode;
  eyeHeight: number;
  refraction: boolean;
}

const today = new Date();

function loadState(): AppState {
  const def: AppState = {
    structure: null,
    height: 100,
    adjHeight: null,
    kind: 'sun',
    date: isoDate(today),
    mode: 'bottom-touch',
    eyeHeight: 1.6,
    refraction: true,
  };
  try {
    const raw = localStorage.getItem('state');
    if (!raw) return def;
    const p = JSON.parse(raw);
    // stale/foreign localStorage must not leak invalid values into the solver
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const structure =
      p.structure && Number.isFinite(p.structure.lat) && Number.isFinite(p.structure.lon)
        ? { lat: p.structure.lat, lon: p.structure.lon }
        : null;
    // height moved to its own field; old states carried it inside structure
    const height = Math.max(1, num(p.height, num(p.structure?.height, def.height)));
    const adjHeight =
      typeof p.adjHeight === 'number' && Number.isFinite(p.adjHeight) && p.adjHeight >= 0 && p.adjHeight < height
        ? p.adjHeight
        : null;
    return {
      structure,
      height,
      adjHeight,
      kind: p.kind === 'moon' ? 'moon' : 'sun',
      date: isoDate(today),
      mode: p.mode === 'center' ? 'center' : 'bottom-touch',
      eyeHeight: num(p.eyeHeight, def.eyeHeight),
      refraction: typeof p.refraction === 'boolean' ? p.refraction : true,
    };
  } catch {
    return def;
  }
}

const state = loadState();
const saveState = () => localStorage.setItem('state', JSON.stringify(state));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --- worker -----------------------------------------------------------------

const worker = new SolverWorker();
let reqId = 0;
let solutions: InstantSolution[] = [];
let adjustedSolutions: InstantSolution[] | null = null;
let sliderIdx = 0;

worker.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'progress' && msg.id === reqId) {
    $('status').textContent = `${t('solving')} ${Math.round(msg.frac * 100)}%`;
  } else if (msg.type === 'result' && msg.id === reqId) {
    solutions = msg.solutions;
    adjustedSolutions = msg.adjusted;
    onSolutions();
  }
};

/** effective side-bar height, or null when it just follows the typed value */
function effectiveAdjHeight(): number | null {
  if (state.adjHeight === null) return null;
  const clamped = Math.min(Math.max(state.adjHeight, 0), state.height);
  return Math.abs(clamped - state.height) < 0.5 ? null : clamped;
}

/** The structure's timezone — the day window and all displayed times use it. */
const structureTz = () =>
  state.structure ? tzAt(state.structure.lat, state.structure.lon) : Intl.DateTimeFormat().resolvedOptions().timeZone;

function requestSolve(): void {
  if (!state.structure) return;
  if (!anchorMs) recomputeAnchorFromDate();
  const adj = effectiveAdjHeight();
  const req: SolveRequest = {
    id: ++reqId,
    structure: { ...state.structure, height: state.height },
    ...(adj !== null ? { adjustedHeight: adj } : {}),
    kind: state.kind,
    dayStartMs: anchorMs - WINDOW_HALF,
    dayEndMs: anchorMs + WINDOW_HALF,
    stepMin: 1,
    eyeHeight: state.eyeHeight,
    mode: state.mode,
    refraction: state.refraction,
  };
  $('status').textContent = t('solving');
  worker.postMessage({ type: 'solve', req });
}

// --- map --------------------------------------------------------------------

const mapH = createMap($('map'), (p) => {
  state.structure = p; // pinned height in the bar carries over
  saveState();
  mapH.setStructure(p);
  $('hint').textContent = t('movePin');
  syncAdjUI();
  recomputeAnchorFromDate(); // structure may sit in a different timezone
  requestSolve();
});

// --- rendering --------------------------------------------------------------

let okIdx: number[] = [];

// Solve window: a continuous interval centered on the anchor time, NOT a
// calendar day — the moon's arc regularly spans midnight and must stay whole.
const WINDOW_HALF = 12 * 3600000;
let anchorMs = 0;
/** after a re-anchor solve, restore the slider to this instant */
let pendingFocusT: number | null = null;

/** the instant currently under the slider thumb, if any */
function currentSelectedMs(): number | null {
  if (!okIdx.length || !solutions.length) return null;
  return solutions[okIdx[Math.min(sliderIdx, okIdx.length - 1)]].t;
}

/**
 * Anchor = chosen date + the currently-selected time of day ("now" before any
 * selection). Centering on a time of day rather than noon keeps a moonrise-
 * to-moonset arc whole across midnight.
 */
function recomputeAnchorFromDate(): void {
  const tz = structureTz();
  const { startMs } = zonedDayWindow(state.date, tz);
  const ref = currentSelectedMs() ?? Date.now();
  const refDayStart = zonedDayWindow(isoDateInTz(ref, tz), tz).startMs;
  anchorMs = startMs + (ref - refDayStart);
}

function onSolutions(): void {
  okIdx = solutions.flatMap((s, i) => (s.status === 'ok' ? [i] : []));
  const ok = okIdx;
  const slider = $('time-slider') as unknown as HTMLInputElement;
  if (ok.length === 0 || !state.structure) {
    mapH.setOverlays(null);
    mapH.setAdjusted(null);
    mapH.setSpot(null, false);
    mapH.setAdjustedSpot(null);
    slider.disabled = true;
    $('status').textContent = solutions.length ? t('noAlignment') : '';
    $('detail').classList.add('hidden');
    return;
  }
  slider.disabled = false;
  slider.min = '0';
  slider.max = String(ok.length - 1);
  if (pendingFocusT !== null) {
    // re-anchor solve: keep the user's selected instant under the thumb
    const target = pendingFocusT;
    pendingFocusT = null;
    let best = 0;
    ok.forEach((abs, i) => {
      if (Math.abs(solutions[abs].t - target) < Math.abs(solutions[ok[best]].t - target)) best = i;
    });
    sliderIdx = best;
  } else if (sliderIdx > ok.length - 1) {
    sliderIdx = Math.floor(ok.length / 2);
  }
  slider.value = String(sliderIdx);
  mapH.setOverlays(buildTraceGeometry(solutions));
  mapH.setAdjusted(adjustedSolutions ? buildTraceGeometry(adjustedSolutions) : null);
  $('approx-badge').classList.toggle('hidden', !solutions.some((s) => s.approximate));
  renderInstant();
}

function renderInstant(): void {
  const ok = okIdx;
  if (ok.length === 0 || !state.structure) return;
  const absIdx = ok[Math.min(sliderIdx, ok.length - 1)];
  const s = solutions[absIdx];
  // adjusted pass shares the sample grid, so the same index is the same instant
  const adj = adjustedSolutions?.[absIdx];
  mapH.setAdjustedSpot(adj?.status === 'ok' && adj.spot ? adj.spot : null);
  const tz = structureTz();
  let time = new Date(s.t).toLocaleTimeString(getLang(), {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  });
  // the window crosses midnight; flag samples on a neighboring calendar date
  const dayDiff = isoDateInTz(s.t, tz) === state.date ? 0 : isoDateInTz(s.t, tz) > state.date ? 1 : -1;
  if (dayDiff !== 0) time += dayDiff > 0 ? ' (+1)' : ' (−1)';
  $('time-label').textContent = time;
  $('status').textContent = '';
  if (s.spot) {
    mapH.setSpot(s.spot, s.spot.occluded);
    const km = (s.spot.d / 1000).toFixed(s.spot.d < 2000 ? 2 : 1);
    const azBody = Math.round(s.az);
    $('detail').classList.remove('hidden');
    $('detail-text').innerHTML =
      `<b>${time}</b> · ${t('distance')} ${km} km · ` +
      `${t('azimuth')} ${azBody}° (${compass(s.az)}) · ${t('bodyAlt')} ${s.bodyAlt.toFixed(1)}°` +
      (s.spot.occluded ? ` · <span class="warn">${t('occludedNote')}</span>` : '');
    ($('nav-link') as unknown as HTMLAnchorElement).href =
      `https://www.google.com/maps/dir/?api=1&destination=${s.spot.lat.toFixed(6)},${s.spot.lon.toFixed(6)}`;
  }
}

// --- UI wiring ----------------------------------------------------------------

/** keep the side bar (max-height bubble + thumb) in sync with state */
function syncAdjUI(): void {
  const adjSlider = $('adj-slider') as unknown as HTMLInputElement;
  adjSlider.max = String(state.height);
  if (state.adjHeight !== null && state.adjHeight >= state.height) state.adjHeight = null;
  adjSlider.value = String(state.adjHeight ?? state.height);
  const maxInput = $('max-height-input') as unknown as HTMLInputElement;
  if (document.activeElement !== maxInput) maxInput.value = String(state.height);
}

function applyStaticText(): void {
  $('hint').textContent = state.structure ? t('movePin') : t('tapToPlace');
  ($('search-input') as unknown as HTMLInputElement).placeholder = t('searchPlaceholder');
  $('max-height-input').title = t('structureHeight');
  $('sun-btn').textContent = `☀️ ${t('sun')}`;
  $('moon-btn').textContent = `🌙 ${t('moon')}`;
  $('nav-link').textContent = t('navigate');
  $('approx-badge').textContent = t('approxBadge');
  $('settings-title').textContent = t('settings');
  $('mode-label').textContent = t('alignMode');
  $('mode-bottom-label').textContent = t('modeBottom');
  $('mode-center-label').textContent = t('modeCenter');
  $('eye-label').textContent = t('eyeHeight');
  $('refraction-label').textContent = t('refraction');
  $('lang-label').textContent = t('language');
  document.title = t('appName');
}

function wire(): void {
  const slider = $('time-slider') as unknown as HTMLInputElement;
  slider.addEventListener('input', () => {
    sliderIdx = Number(slider.value);
    renderInstant();
  });
  // on release near a window edge, recenter the window on the selected time
  slider.addEventListener('change', () => {
    const ok = okIdx;
    if (!ok.length) return;
    const t = solutions[ok[Math.min(sliderIdx, ok.length - 1)]].t;
    const nearEdge = Math.min(t - (anchorMs - WINDOW_HALF), anchorMs + WINDOW_HALF - t) < 90 * 60000;
    if (!nearEdge) return;
    anchorMs = t;
    state.date = isoDateInTz(t, structureTz());
    ($('date-input') as unknown as HTMLInputElement).value = state.date;
    saveState();
    pendingFocusT = t;
    requestSolve();
  });

  const dateInput = $('date-input') as unknown as HTMLInputElement;
  dateInput.value = state.date;
  dateInput.addEventListener('change', () => {
    state.date = dateInput.value || isoDate(today);
    saveState();
    recomputeAnchorFromDate();
    pendingFocusT = anchorMs; // land on the same time of day
    requestSolve();
  });
  $('date-prev').addEventListener('click', () => shiftDate(-1));
  $('date-next').addEventListener('click', () => shiftDate(1));
  function shiftDate(days: number): void {
    state.date = shiftIsoDate(state.date, days);
    dateInput.value = state.date;
    saveState();
    recomputeAnchorFromDate();
    pendingFocusT = anchorMs; // land on the same time of day
    requestSolve();
  }

  const sunBtn = $('sun-btn');
  const moonBtn = $('moon-btn');
  const syncKind = () => {
    sunBtn.classList.toggle('active', state.kind === 'sun');
    moonBtn.classList.toggle('active', state.kind === 'moon');
    mapH.setBodyKind(state.kind);
  };
  sunBtn.addEventListener('click', () => {
    state.kind = 'sun';
    saveState();
    syncKind();
    requestSolve();
  });
  moonBtn.addEventListener('click', () => {
    state.kind = 'moon';
    saveState();
    syncKind();
    requestSolve();
  });
  syncKind();

  // max height lives in the side bar's bubble: type to set the solid curve
  const maxInput = $('max-height-input') as unknown as HTMLInputElement;
  maxInput.value = String(state.height);
  let heightTimer: ReturnType<typeof setTimeout> | null = null;
  maxInput.addEventListener('input', () => {
    const h = Number(maxInput.value);
    if (!Number.isFinite(h) || h <= 0) return;
    state.height = h;
    saveState();
    syncAdjUI(); // thumb range follows the max
    if (heightTimer) clearTimeout(heightTimer);
    heightTimer = setTimeout(requestSolve, 400);
  });

  wireSearch({
    input: $('search-input') as unknown as HTMLInputElement,
    results: $('search-results'),
    getBias: () => {
      const c = mapH.map.getCenter();
      return { lat: c.lat, lon: c.lng };
    },
    onPick: (hit) => mapH.map.flyTo({ center: [hit.lon, hit.lat], zoom: 15 }),
  });

  // vertical side bar: align with a lower point on the structure (dashed line)
  const adjSlider = $('adj-slider') as unknown as HTMLInputElement;
  let adjTimer: ReturnType<typeof setTimeout> | null = null;
  adjSlider.addEventListener('input', () => {
    const v = Number(adjSlider.value);
    state.adjHeight = v >= state.height ? null : Math.max(0, v);
    saveState();
    if (adjTimer) clearTimeout(adjTimer);
    adjTimer = setTimeout(requestSolve, 250);
  });
  syncAdjUI();

  // settings
  $('settings-btn').addEventListener('click', () => $('settings-modal').classList.remove('hidden'));
  $('settings-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
  const modeBottom = $('mode-bottom') as unknown as HTMLInputElement;
  const modeCenter = $('mode-center') as unknown as HTMLInputElement;
  (state.mode === 'bottom-touch' ? modeBottom : modeCenter).checked = true;
  for (const el of [modeBottom, modeCenter]) {
    el.addEventListener('change', () => {
      state.mode = modeBottom.checked ? 'bottom-touch' : 'center';
      saveState();
      requestSolve();
    });
  }
  const eyeInput = $('eye-input') as unknown as HTMLInputElement;
  eyeInput.value = String(state.eyeHeight);
  eyeInput.addEventListener('change', () => {
    state.eyeHeight = Number(eyeInput.value) || 1.6;
    saveState();
    requestSolve();
  });
  const refractionInput = $('refraction-input') as unknown as HTMLInputElement;
  refractionInput.checked = state.refraction;
  refractionInput.addEventListener('change', () => {
    state.refraction = refractionInput.checked;
    saveState();
    requestSolve();
  });
  const langSelect = $('lang-select') as unknown as HTMLSelectElement;
  for (const { value, label } of LANGS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    langSelect.appendChild(opt);
  }
  langSelect.value = getLang();
  langSelect.addEventListener('change', () => {
    setLang(langSelect.value as never);
    applyStaticText();
    renderInstant();
  });
}

applyStaticText();
wire();
if (state.structure) {
  mapH.setStructure(state.structure);
  requestSolve();
}

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}
