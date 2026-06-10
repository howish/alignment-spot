// Elevation sampling from AWS Terrain Tiles (terrarium encoding).
// Pure math helpers are exported separately so they can be unit-tested in
// node; the fetch/decode path needs a browser (OffscreenCanvas) context.

export const DEM_ZOOM = 12; // ~38 m/px at the equator; plenty for a 50 m march
export const TILE_SIZE = 256;
const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** terrarium RGB -> elevation in meters */
export function terrariumToElev(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** lon/lat -> continuous tile coordinates at zoom z (Web Mercator) */
export function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return { x, y };
}

/** Bilinear sample of a w×h grid at fractional pixel (px, py), clamped. */
export function bilinear(grid: Float32Array, w: number, h: number, px: number, py: number): number {
  const x = Math.min(Math.max(px, 0), w - 1.001);
  const y = Math.min(Math.max(py, 0), h - 1.001);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = (yy: number, xx: number) => grid[yy * w + xx];
  return (
    i(y0, x0) * (1 - fx) * (1 - fy) +
    i(y0, x0 + 1) * fx * (1 - fy) +
    i(y0 + 1, x0) * (1 - fx) * fy +
    i(y0 + 1, x0 + 1) * fx * fy
  );
}

export type ElevationSampler = (lat: number, lon: number) => Promise<number | null>;

/**
 * Tile-cached sampler. Failed tiles are remembered as null so a dead network
 * degrades to the flat-terrain fallback instead of hammering S3.
 */
/** decoded tiles kept in RAM; 64 × 256 KB ≈ 16 MB ceiling */
const MAX_CACHED_TILES = 64;

export function createTileSampler(fetchImpl: typeof fetch = fetch): ElevationSampler {
  const tiles = new Map<string, Promise<Float32Array | null>>();

  async function loadTile(z: number, x: number, y: number): Promise<Float32Array | null> {
    try {
      const res = await fetchImpl(TILE_URL(z, x, y));
      if (!res.ok) return null;
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      const grid = new Float32Array(TILE_SIZE * TILE_SIZE);
      for (let i = 0; i < grid.length; i++) {
        grid[i] = terrariumToElev(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      }
      return grid;
    } catch {
      return null;
    }
  }

  return async (lat, lon) => {
    const { x, y } = lonLatToTileXY(lon, lat, DEM_ZOOM);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const key = `${tx}/${ty}`;
    let tile = tiles.get(key);
    if (!tile) {
      tile = loadTile(DEM_ZOOM, tx, ty);
    } else {
      tiles.delete(key); // re-insert to refresh LRU recency
    }
    tiles.set(key, tile);
    if (tiles.size > MAX_CACHED_TILES) {
      tiles.delete(tiles.keys().next().value!);
    }
    const grid = await tile;
    if (!grid) return null;
    return bilinear(grid, TILE_SIZE, TILE_SIZE, (x - tx) * TILE_SIZE - 0.5, (y - ty) * TILE_SIZE - 0.5);
  };
}
