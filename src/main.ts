import { buildBandGeometry, buildBranchGeometry, mergeSolutions } from './band';
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
  /** alignment height in meters — the side bar's thumb, drives the solve */
  height: number;
  /** side bar range top — set by typing into the height label */
  barMax: number;
  kind: Kind;
  date: string; // YYYY-MM-DD local
  mode: Mode;
  eyeHeight: number;
  refraction: boolean;
  /** solver search range in meters */
  maxDistance: number;
  /** last selected time as minutes since structure-local midnight */
  timeOfDayMin: number | null;
  /** last map camera */
  camera: { lng: number; lat: number; zoom: number } | null;
}

const today = new Date();

function loadState(): AppState {
  const def: AppState = {
    structure: null,
    height: 100,
    barMax: 100,
    kind: 'sun',
    date: isoDate(today),
    mode: 'bottom-touch',
    eyeHeight: 1.6,
    refraction: true,
    maxDistance: 30000,
    timeOfDayMin: null,
    camera: null,
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
    // older states: height inside structure, or a separate adjHeight
    const legacyMax = Math.max(1, num(p.height, num(p.structure?.height, def.height)));
    const barMax = Math.max(1, num(p.barMax, legacyMax));
    const height = Math.min(barMax, Math.max(1, num(p.adjHeight, legacyMax)));
    return {
      structure,
      height,
      barMax,
      kind: p.kind === 'moon' ? 'moon' : 'sun',
      mode: p.mode === 'center' ? 'center' : 'bottom-touch',
      eyeHeight: num(p.eyeHeight, def.eyeHeight),
      refraction: typeof p.refraction === 'boolean' ? p.refraction : true,
      maxDistance: [30000, 50000, 100000].includes(p.maxDistance) ? p.maxDistance : def.maxDistance,
      // resume on the saved date unless it's already in the past
      date: typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.date >= isoDate(today) ? p.date : isoDate(today),
      timeOfDayMin:
        typeof p.timeOfDayMin === 'number' && p.timeOfDayMin >= 0 && p.timeOfDayMin < 1440 ? p.timeOfDayMin : null,
      camera:
        p.camera && Number.isFinite(p.camera.lng) && Number.isFinite(p.camera.lat) && Number.isFinite(p.camera.zoom)
          ? { lng: p.camera.lng, lat: p.camera.lat, zoom: Math.min(Math.max(p.camera.zoom, 1), 20) }
          : null,
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
let sliderIdx = 0;
/** finer-sampled splice for the zoomed viewport, and its time window */
let refined: { sols: InstantSolution[]; t0: number; t1: number } | null = null;
let refineReqId = -1;

worker.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'progress' && msg.id === reqId && msg.tag === 'base') {
    $('status').textContent = `${t('solving')} ${Math.round(msg.frac * 100)}%`;
  } else if (msg.type === 'result' && msg.tag === 'base' && msg.id === reqId) {
    solutions = msg.solutions;
    refined = null; // a new base invalidates any old splice
    onSolutions();
    scheduleRefine();
  } else if (msg.type === 'result' && msg.tag === 'refine' && msg.id === refineReqId) {
    refined = { sols: msg.solutions, t0: refinePendingT0, t1: refinePendingT1 };
    renderGeometry();
  }
};

/** The structure's timezone — the day window and all displayed times use it. */
const structureTz = () =>
  state.structure ? tzAt(state.structure.lat, state.structure.lon) : Intl.DateTimeFormat().resolvedOptions().timeZone;

function requestSolve(): void {
  if (!state.structure) return;
  if (!anchorMs) recomputeAnchorFromDate();
  const req: SolveRequest = {
    id: ++reqId,
    structure: { ...state.structure, height: state.height },
    maxDistance: state.maxDistance,
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

// --- viewport refinement ------------------------------------------------------
// Zoomed in, the 1-min vertices show as kinks; re-solve just the on-screen
// time window at a finer step and splice it into the rendered geometry.

const REFINE_MIN_ZOOM = 12;
let refinePendingT0 = 0;
let refinePendingT1 = 0;
let refineTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefine(): void {
  if (refineTimer) clearTimeout(refineTimer);
  refineTimer = setTimeout(requestRefine, 350);
}

function requestRefine(): void {
  if (!state.structure || !okIdx.length) return;
  if (mapH.map.getZoom() < REFINE_MIN_ZOOM) {
    if (refined) {
      refined = null;
      renderGeometry();
    }
    return;
  }
  const b = mapH.map.getBounds();
  const latPad = (b.getNorth() - b.getSouth()) * 0.2;
  const lonPad = (b.getEast() - b.getWest()) * 0.2;
  const inView = (lat: number, lon: number) =>
    lat > b.getSouth() - latPad && lat < b.getNorth() + latPad && lon > b.getWest() - lonPad && lon < b.getEast() + lonPad;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const i of okIdx) {
    const s = solutions[i];
    if (s.all.some((sp) => inView(sp.lat, sp.lon))) {
      t0 = Math.min(t0, s.t);
      t1 = Math.max(t1, s.t);
    }
  }
  if (!Number.isFinite(t0)) {
    if (refined) {
      refined = null;
      renderGeometry();
    }
    return;
  }
  t0 -= 60000;
  t1 += 60000;
  const spanMin = (t1 - t0) / 60000;
  // 10 s floor, scaled so a refine stays around a thousand samples
  const stepMin = Math.max(1 / 6, spanMin / 1200);
  refinePendingT0 = t0;
  refinePendingT1 = t1;
  refineReqId = ++reqId;
  const req: SolveRequest = {
    id: refineReqId,
    tag: 'refine',
    structure: { ...state.structure, height: state.height },
    maxDistance: state.maxDistance,
    kind: state.kind,
    dayStartMs: t0,
    dayEndMs: t1,
    stepMin,
    eyeHeight: state.eyeHeight,
    mode: state.mode,
    refraction: state.refraction,
  };
  worker.postMessage({ type: 'solve', req });
}

/** geometry from base solutions plus the refined splice, if any */
function renderGeometry(): void {
  if (!state.structure) return;
  const merged = refined ? mergeSolutions(solutions, refined.sols, refined.t0, refined.t1) : solutions;
  mapH.setOverlays(buildBandGeometry(state.structure, merged));
  mapH.setBranches(buildBranchGeometry(merged));
}

// --- map --------------------------------------------------------------------

const mapH = createMap(
  $('map'),
  (p) => {
  state.structure = p; // pinned height in the bar carries over
  saveState();
  mapH.setStructure(p);
    $('hint').textContent = t('movePin');
    syncAdjUI();
    recomputeAnchorFromDate(); // structure may sit in a different timezone
    requestSolve();
  },
  state.camera ? { center: [state.camera.lng, state.camera.lat], zoom: state.camera.zoom } : undefined,
);

// re-target the high-resolution splice as the user pans/zooms, and remember
// the camera so a reload resumes where the user left off
mapH.map.on('moveend', () => {
  scheduleRefine();
  const c = mapH.map.getCenter();
  state.camera = { lng: c.lng, lat: c.lat, zoom: mapH.map.getZoom() };
  saveState();
});

// test/debug handle (read-only usage; not part of the public surface)
(window as unknown as Record<string, unknown>).__alignspot = {
  map: mapH.map,
  zoom: () => mapH.map.getZoom(),
  okCount: () => okIdx.length,
};

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
  const sel = currentSelectedMs();
  if (sel === null && state.timeOfDayMin !== null) {
    anchorMs = startMs + state.timeOfDayMin * 60000; // resume the saved time of day
    return;
  }
  const ref = sel ?? Date.now();
  const refDayStart = zonedDayWindow(isoDateInTz(ref, tz), tz).startMs;
  anchorMs = startMs + (ref - refDayStart);
}

function onSolutions(): void {
  okIdx = solutions.flatMap((s, i) => (s.status === 'ok' ? [i] : []));
  const ok = okIdx;
  const slider = $('time-slider') as unknown as HTMLInputElement;
  if (ok.length === 0 || !state.structure) {
    mapH.setOverlays(null);
    mapH.setBranches(null);
    mapH.setSpot(null, false);
    mapH.setBranchSpots([]);
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
  renderGeometry();
  $('approx-badge').classList.toggle('hidden', !solutions.some((s) => s.approximate));
  renderInstant();
}

let rememberTimer: ReturnType<typeof setTimeout> | null = null;
/** persist the selected time of day (debounced; slider drags fire fast) */
function rememberTimeOfDay(tMs: number, tz: string): void {
  if (rememberTimer) clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => {
    const dayStart = zonedDayWindow(isoDateInTz(tMs, tz), tz).startMs;
    state.timeOfDayMin = Math.round((tMs - dayStart) / 60000) % 1440;
    saveState();
  }, 400);
}

function renderInstant(): void {
  const ok = okIdx;
  if (ok.length === 0 || !state.structure) return;
  const absIdx = ok[Math.min(sliderIdx, ok.length - 1)];
  const s = solutions[absIdx];
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
  rememberTimeOfDay(s.t, tz);
  $('status').textContent = '';
  mapH.setBranchSpots(s.all.slice(1).map((sp) => ({ lat: sp.lat, lon: sp.lon, occluded: sp.occluded })));
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

/** keep the side bar thumb + its riding label in sync with state */
function syncAdjUI(): void {
  const adjSlider = $('adj-slider') as unknown as HTMLInputElement;
  adjSlider.max = String(state.barMax);
  adjSlider.value = String(state.height);
  const label = $('height-value') as unknown as HTMLInputElement;
  if (document.activeElement !== label) label.value = String(Math.round(state.height));
  positionHeightLabel();
}

/** the label rides next to the thumb: same vertical coordinate */
function positionHeightLabel(): void {
  const slider = $('adj-slider');
  const wrap = $('height-label-wrap');
  const container = $('side-slider');
  const frac = Math.min(1, Math.max(0, state.height / state.barMax));
  const sliderTop = slider.offsetTop;
  const thumbH = 16; // range-thumb approximation
  const y = sliderTop + (1 - frac) * (slider.offsetHeight - thumbH) + thumbH / 2;
  wrap.style.top = `${y}px`;
  void container; // container is the offset parent
}

function applyStaticText(): void {
  $('hint').textContent = state.structure ? t('movePin') : t('tapToPlace');
  ($('search-input') as unknown as HTMLInputElement).placeholder = t('searchPlaceholder');
  $('height-value').title = t('structureHeight');
  $('sun-btn').textContent = `☀️ ${t('sun')}`;
  $('moon-btn').textContent = `🌙 ${t('moon')}`;
  $('nav-link').textContent = t('navigate');
  $('approx-badge').textContent = t('approxBadge');
  $('settings-title').textContent = t('settings');
  $('mode-label').textContent = t('alignMode');
  $('mode-bottom-label').textContent = t('modeBottom');
  $('mode-center-label').textContent = t('modeCenter');
  $('eye-label').textContent = t('eyeHeight');
  $('range-label').textContent = t('searchRange');
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

  wireSearch({
    input: $('search-input') as unknown as HTMLInputElement,
    results: $('search-results'),
    getBias: () => {
      const c = mapH.map.getCenter();
      return { lat: c.lat, lon: c.lng };
    },
    onPick: (hit) => mapH.map.flyTo({ center: [hit.lon, hit.lat], zoom: 15 }),
  });

  // side bar thumb = the height; the label rides along and re-solves debounced
  const adjSlider = $('adj-slider') as unknown as HTMLInputElement;
  let adjTimer: ReturnType<typeof setTimeout> | null = null;
  adjSlider.addEventListener('input', () => {
    state.height = Math.max(1, Number(adjSlider.value));
    saveState();
    const heightLabel = $('height-value') as unknown as HTMLInputElement;
    heightLabel.value = String(Math.round(state.height));
    positionHeightLabel();
    if (adjTimer) clearTimeout(adjTimer);
    adjTimer = setTimeout(requestSolve, 250);
  });

  // tapping the riding label turns it into an input; committing a number sets
  // both the height and the bar's range top (thumb jumps to that value)
  const heightLabel = $('height-value') as unknown as HTMLInputElement;
  heightLabel.addEventListener('focus', () => heightLabel.select());
  heightLabel.addEventListener('change', () => {
    const h = Number(heightLabel.value);
    if (!Number.isFinite(h) || h <= 0) {
      syncAdjUI();
      return;
    }
    state.height = h;
    state.barMax = h;
    saveState();
    syncAdjUI();
    requestSolve();
    heightLabel.blur();
  });
  heightLabel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') heightLabel.blur();
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
  const rangeSelect = $('range-select') as unknown as HTMLSelectElement;
  rangeSelect.value = String(state.maxDistance);
  rangeSelect.addEventListener('change', () => {
    state.maxDistance = Number(rangeSelect.value) || 30000;
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
  recomputeAnchorFromDate();
  pendingFocusT = anchorMs; // land the slider on the remembered time
  requestSolve();
}

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}
