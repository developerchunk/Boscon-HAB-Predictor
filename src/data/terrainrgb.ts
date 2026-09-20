/**
 * Point elevations from Mapbox Terrain-RGB tiles, decoded in the browser:
 *   elevation = -10000 + 0.1 * (R*65536 + G*256 + B)   (mapbox.mapbox-terrain-dem-v1, v4 pngraw, 256 px, z <= 14)
 * Verified against surveyed heights in scripts/check_terrain_rgb.py (pad 744.2 m vs 744.4 m).
 * Tiles are cached per (z, x, y) for the page's life; a z14 tile covers ~2.4 km at 18° N at ~9 m/px.
 * Used as the landing-terrain lookup so the flight never waits on the Open-Meteo elevation quota.
 */
const TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined)?.trim();
const tileCache = new Map<string, Promise<Uint8ClampedArray>>();
const T = 256;

function loadTile(z: number, x: number, y: number): Promise<Uint8ClampedArray> {
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image(); img.crossOrigin = "anonymous";
      img.onload = () => { const c = document.createElement("canvas"); c.width = T; c.height = T; const ctx = c.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(img, 0, 0); resolve(ctx.getImageData(0, 0, T, T).data); };
      img.onerror = () => reject(new Error(`terrain tile ${key} failed`));
      img.src = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${z}/${x}/${y}.pngraw?access_token=${TOKEN}`;
    });
    tileCache.set(key, p);
    p.catch(() => tileCache.delete(key));
  }
  return p;
}

export const terrainRgbAvailable = () => !!TOKEN && TOKEN.startsWith("pk.");

/** Elevations (m) for points [lat, lon] at zoom 14 (~9 m per pixel here). Throws if no public token. */
export async function elevationsFromTerrainRgb(points: [number, number][], z = 14): Promise<number[]> {
  if (!terrainRgbAvailable()) throw new Error("no Mapbox public token");
  const N = 2 ** z;
  return Promise.all(points.map(async ([lat, lon]) => {
    const xf = ((lon + 180) / 360) * N;
    const yf = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * N;
    const x = Math.floor(xf), y = Math.floor(yf);
    const data = await loadTile(z, x, y);
    const px = Math.min(T - 1, Math.floor((xf - x) * T)), py = Math.min(T - 1, Math.floor((yf - y) * T));
    const k = (py * T + px) * 4;
    return -10000 + 0.1 * (data[k] * 65536 + data[k + 1] * 256 + data[k + 2]);
  }));
}
