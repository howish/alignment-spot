import { buildBandGeometry } from './band';
import { compass, type LatLon } from './geo';
import { getLang, LANGS, setLang, t } from './i18n';
import { createMap } from './map';
import type { InstantSolution } from './solver';
import { isoDate, shiftIsoDate, tzAt, zonedDayWindow } from './time';
import type { SolveRequest } from './worker';
import SolverWorker from './worker?worker';
import './style.css';

type Kind = 'sun' | 'moon';
type Mode = 'bottom-touch' | 'center';

interface AppState {
  structure: (LatLon & { height: number }) | null;
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
      p.structure &&
      Number.isFinite(p.structure.lat) &&
      Number.isFinite(p.structure.lon) &&
      Number.isFinite(p.structure.height) &&
      p.structure.height > 0
        ? { lat: p.structure.lat, lon: p.structure.lon, height: p.structure.height }
        : null;
    return {
      structure,
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
let sliderIdx = 0;

worker.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'progress' && msg.id === reqId) {
    $('status').textContent = `${t('solving')} ${Math.round(msg.frac * 100)}%`;
  } else if (msg.type === 'result' && msg.id === reqId) {
    solutions = msg.solutions;
    onSolutions();
  }
};

/** The structure's timezone — the day window and all displayed times use it. */
const structureTz = () =>
  state.structure ? tzAt(state.structure.lat, state.structure.lon) : Intl.DateTimeFormat().resolvedOptions().timeZone;

function requestSolve(): void {
  if (!state.structure) return;
  const { startMs, endMs } = zonedDayWindow(state.date, structureTz());
  const req: SolveRequest = {
    id: ++reqId,
    structure: state.structure,
    kind: state.kind,
    dayStartMs: startMs,
    dayEndMs: endMs,
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
  state.structure = { ...p, height: state.structure?.height ?? 100 };
  saveState();
  mapH.setStructure(p);
  $('height-sheet').classList.remove('hidden');
  ($('height-input') as unknown as HTMLInputElement).value = String(state.structure.height);
  $('hint').textContent = t('movePin');
  requestSolve();
});

// --- rendering --------------------------------------------------------------

let okIdx: number[] = [];

function onSolutions(): void {
  okIdx = solutions.flatMap((s, i) => (s.status === 'ok' ? [i] : []));
  const ok = okIdx;
  const slider = $('time-slider') as unknown as HTMLInputElement;
  if (ok.length === 0 || !state.structure) {
    mapH.setOverlays(null);
    mapH.setSpot(null, false);
    mapH.setSightline(null, null);
    slider.disabled = true;
    $('status').textContent = solutions.length ? t('noAlignment') : '';
    $('detail').classList.add('hidden');
    return;
  }
  slider.disabled = false;
  slider.min = '0';
  slider.max = String(ok.length - 1);
  // keep the slider position proportionally when the day changes
  if (sliderIdx > ok.length - 1) sliderIdx = Math.floor(ok.length / 2);
  slider.value = String(sliderIdx);
  mapH.setOverlays(buildBandGeometry(state.structure, solutions));
  $('approx-badge').classList.toggle('hidden', !solutions.some((s) => s.approximate));
  renderInstant();
}

function renderInstant(): void {
  const ok = okIdx;
  if (ok.length === 0 || !state.structure) return;
  const s = solutions[ok[Math.min(sliderIdx, ok.length - 1)]];
  const time = new Date(s.t).toLocaleTimeString(getLang(), {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: structureTz(),
  });
  $('time-label').textContent = time;
  $('status').textContent = '';
  if (s.spot) {
    mapH.setSpot(s.spot, s.spot.occluded);
    mapH.setSightline(state.structure, s.spot);
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

function applyStaticText(): void {
  $('hint').textContent = state.structure ? t('movePin') : t('tapToPlace');
  $('height-label').textContent = t('structureHeight');
  $('height-ok').textContent = t('ok');
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

  const dateInput = $('date-input') as unknown as HTMLInputElement;
  dateInput.value = state.date;
  dateInput.addEventListener('change', () => {
    state.date = dateInput.value || isoDate(today);
    saveState();
    requestSolve();
  });
  $('date-prev').addEventListener('click', () => shiftDate(-1));
  $('date-next').addEventListener('click', () => shiftDate(1));
  function shiftDate(days: number): void {
    state.date = shiftIsoDate(state.date, days);
    dateInput.value = state.date;
    saveState();
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

  const heightInput = $('height-input') as unknown as HTMLInputElement;
  $('height-ok').addEventListener('click', () => {
    const h = Number(heightInput.value);
    if (state.structure && h > 0) {
      state.structure.height = h;
      saveState();
      $('height-sheet').classList.add('hidden');
      requestSolve();
    }
  });

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
