// Place search via Photon (komoot) — key-free OSM geocoder with CORS.
// Results are biased toward the current map center.

export interface SearchHit {
  name: string;
  detail: string;
  lat: number;
  lon: number;
}

const ENDPOINT = 'https://photon.komoot.io/api/';

export async function searchPlaces(q: string, bias: { lat: number; lon: number }): Promise<SearchHit[]> {
  const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&limit=5&lat=${bias.lat.toFixed(3)}&lon=${bias.lon.toFixed(3)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const hits: SearchHit[] = [];
  for (const f of data.features ?? []) {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = p.name ?? p.street ?? '';
    if (!name) continue;
    const detail = [p.city ?? p.county, p.state, p.country].filter(Boolean).join(', ');
    hits.push({ name, detail, lat, lon });
  }
  return hits;
}

/** Wire the search box: debounced query -> dropdown -> flyTo on pick. */
export function wireSearch(opts: {
  input: HTMLInputElement;
  results: HTMLElement;
  getBias: () => { lat: number; lon: number };
  onPick: (hit: SearchHit) => void;
}): void {
  const { input, results, getBias, onPick } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  const hide = () => {
    results.classList.add('hidden');
    results.replaceChildren();
  };

  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      hide();
      return;
    }
    timer = setTimeout(async () => {
      const mySeq = ++seq;
      const hits = await searchPlaces(q, getBias());
      if (mySeq !== seq) return; // a newer query superseded this one
      results.replaceChildren();
      if (!hits.length) {
        hide();
        return;
      }
      for (const hit of hits) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'search-hit';
        el.innerHTML = `<b></b><small></small>`;
        (el.firstChild as HTMLElement).textContent = hit.name;
        (el.lastChild as HTMLElement).textContent = hit.detail;
        el.addEventListener('click', () => {
          input.value = hit.name;
          hide();
          onPick(hit);
        });
        results.appendChild(el);
      }
      results.classList.remove('hidden');
    }, 350);
  });

  input.addEventListener('blur', () => setTimeout(hide, 250)); // let clicks land first
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) input.dispatchEvent(new Event('input'));
  });
}
