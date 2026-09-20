/**
 * Open-Meteo access (https://open-meteo.com, free, no key, CORS enabled).
 *
 * Forecast pressure-level winds. Verified 2026-09-20 by direct requests:
 *   gfs_seamless  23 levels 1000..10 hPa (10 hPa ~ 31 km), hourly, 16-day horizon
 *   icon_seamless 19 levels 1000..30 hPa (30 hPa ~ 24 km)
 *   ecmwf_ifs025  14 levels 1000..10 hPa (coarse: 100, 50, 10 hPa in the stratosphere)
 * Each level gives wind speed/direction, geopotential height and temperature, so the
 * balloon's altitude coordinate and the density column both come from the model itself.
 * Requested coordinates are snapped by the server to the model's grid cell; we key columns by
 * the REQUESTED (regular) coordinates, which shifts each column by at most half a cell (<0.13 deg).
 *
 * Ensemble: ecmwf_ifs025 gives 51 members (control + member01..member50) on the ECMWF levels.
 */
import { GridWindField, type GridColumn, type GridColumnLevel } from "../physics/wind";
import { uvFromDirSpeed } from "../physics/geo";

/* ------------------------------------------------------------------ quota hygiene
 * Open-Meteo's free tier allows 600 calls/min, 5,000/hour, 10,000/day, and a request with many
 * locations, variables or days is weighted as several calls. Every fetch below goes through
 * `omFetch`, which counts requests, turns a 429 into a readable error, and the expensive results
 * (forecast grid, ensemble, elevation, archive months) are memoised for the life of the page so
 * re-running a prediction with a different balloon or parachute costs no API calls.
 */
export const apiStats = { requests: 0, cacheHits: 0, lastError: "" };

/**
 * Endpoint selection. Defaults are the free public servers. Set in .env:
 *   VITE_OPEN_METEO_API_KEY=...   -> paid customer API (customer-*.open-meteo.com, no hourly/daily cap)
 *   VITE_OPEN_METEO_BASE=http://localhost:8080   -> a self-hosted Open-Meteo instance (unlimited; all
 *       services on one host, so forecast/ensemble/archive/elevation share the base)
 */
const KEY = (import.meta.env.VITE_OPEN_METEO_API_KEY as string | undefined)?.trim() || "";
const SELF = (import.meta.env.VITE_OPEN_METEO_BASE as string | undefined)?.trim().replace(/\/$/, "") || "";
export const OM_HOSTS = {
  forecast: SELF ? `${SELF}/v1/forecast` : KEY ? "https://customer-api.open-meteo.com/v1/forecast" : "https://api.open-meteo.com/v1/forecast",
  ensemble: SELF ? `${SELF}/v1/ensemble` : KEY ? "https://customer-ensemble-api.open-meteo.com/v1/ensemble" : "https://ensemble-api.open-meteo.com/v1/ensemble",
  archive: SELF ? `${SELF}/v1/forecast` : KEY ? "https://customer-historical-forecast-api.open-meteo.com/v1/forecast" : "https://historical-forecast-api.open-meteo.com/v1/forecast",
  elevation: SELF ? `${SELF}/v1/elevation` : KEY ? "https://customer-api.open-meteo.com/v1/elevation" : "https://api.open-meteo.com/v1/elevation",
  geocoding: "https://geocoding-api.open-meteo.com/v1/search",
  mode: SELF ? "self-hosted" : KEY ? "customer API" : "free public API",
};
const withKey = (url: string) => (KEY && !SELF ? `${url}&apikey=${encodeURIComponent(KEY)}` : url);
export class QuotaError extends Error { constructor(msg: string) { super(msg); this.name = "QuotaError"; } }
async function omFetch(url: string, signal?: AbortSignal, what = "Open-Meteo"): Promise<any> {
  apiStats.requests++;
  const resp = await fetch(withKey(url), { signal });
  if (resp.status === 429) {
    let reason = "rate limit"; try { reason = (await resp.json()).reason ?? reason; } catch { /* ignore */ }
    apiStats.lastError = reason;
    throw new QuotaError(`${what}: ${reason} (free tier: 600 calls/min, 5,000/hour, 10,000/day; large requests count as several calls). Cached data from earlier runs is reused automatically; otherwise wait for the next hour.`);
  }
  if (!resp.ok) throw new Error(`${what} ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  return resp.json();
}
const memo = new Map<string, { at: number; value: any }>();
export async function cached<T>(key: string, ttlMs: number, make: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) { apiStats.cacheHits++; return hit.value as T; }
  const value = await make();
  memo.set(key, { at: Date.now(), value });
  return value;
}

export type ModelId = "gfs_seamless" | "icon_seamless" | "ecmwf_ifs025" | "nomads_gfs025";
export const MODEL_LEVELS: Record<ModelId, number[]> = {
  gfs_seamless: [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 40, 30, 20, 15, 10],
  icon_seamless: [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30],
  ecmwf_ifs025: [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50, 10],
  nomads_gfs025: [], // native GRIB levels come from the bridge (1000 .. 1 hPa)
};
export const MODEL_LABEL: Record<ModelId, string> = {
  nomads_gfs025: "NOAA GFS 0.25° native via local NOMADS bridge — 41 levels to 1 hPa ≈ 48 km, hourly, no quota",
  gfs_seamless: "NOAA GFS via Open-Meteo (0.25°, 23 levels to 10 hPa ≈ 31 km)",
  icon_seamless: "DWD ICON via Open-Meteo (19 levels to 30 hPa ≈ 24 km)",
  ecmwf_ifs025: "ECMWF IFS via Open-Meteo (0.25°, 14 levels to 10 hPa)",
};
const SURFACE_AGL = [10, 80, 120, 180]; // GFS/ICON provide these above-ground winds; ECMWF only 10 m (others come back null)

export interface FetchGridOptions {
  lat: number; lon: number; model: ModelId;
  /** launch time, UTC */
  launch: Date;
  /** hours of data before and after launch */
  hoursBefore?: number; hoursAfter?: number;
  /** grid half-span and spacing in degrees */
  halfSpanDeg?: number; stepDeg?: number;
  signal?: AbortSignal;
}
export interface GridFetchResult {
  field: GridWindField;
  /** epoch (ms) of field time zero */
  epochMs: number;
  /** requested coordinates */
  lats: number[]; lons: number[];
  /** launch-point column at the launch hour (for charts): ascending z */
  launchColumn: GridColumnLevel[];
  surfaceElevationM: number;
  generatedAtMs: number;
  model: ModelId;
}

function isoHour(d: Date): string { return d.toISOString().slice(0, 13) + ":00"; }

export async function fetchGridField(o: FetchGridOptions): Promise<GridFetchResult> {
  if (o.model === "nomads_gfs025") { const { fetchNomadsGrid } = await import("./nomads"); return fetchNomadsGrid(o); }
  const half = o.halfSpanDeg ?? 1.0, step = o.stepDeg ?? 0.5; // default 5×5 columns at 0.5°, ±110 km (the CUSF/Tawhiri resolution)
  const start0 = new Date(o.launch.getTime() - (o.hoursBefore ?? 1) * 3600e3), end0 = new Date(o.launch.getTime() + (o.hoursAfter ?? 8) * 3600e3);
  const key = `grid|${o.model}|${o.lat.toFixed(3)},${o.lon.toFixed(3)}|${half}/${step}|${isoHour(start0)}|${isoHour(end0)}`;
  return cached(key, 30 * 60e3, () => fetchGridFieldUncached(o, half, step));
}
async function fetchGridFieldUncached(o: FetchGridOptions, half: number, step: number): Promise<GridFetchResult> {
  const lats: number[] = [], lons: number[] = [];
  for (let a = -half; a <= half + 1e-9; a += step) lats.push(+(o.lat + a).toFixed(4));
  for (let b = -half; b <= half + 1e-9; b += step) lons.push(+(o.lon + b).toFixed(4));
  const qlat: number[] = [], qlon: number[] = [];
  for (const la of lats) for (const lo of lons) { qlat.push(la); qlon.push(lo); }
  const levels = MODEL_LEVELS[o.model];
  const vars: string[] = ["surface_pressure", "temperature_2m"];
  for (const h of SURFACE_AGL) vars.push(`wind_speed_${h}m`, `wind_direction_${h}m`);
  for (const p of levels) vars.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`, `temperature_${p}hPa`);
  const start = new Date(o.launch.getTime() - (o.hoursBefore ?? 1) * 3600e3);
  const end = new Date(o.launch.getTime() + (o.hoursAfter ?? 8) * 3600e3);
  const url = `${OM_HOSTS.forecast}?latitude=${qlat.join(",")}&longitude=${qlon.join(",")}&hourly=${vars.join(",")}&models=${o.model}&wind_speed_unit=ms&timezone=UTC&start_hour=${isoHour(start)}&end_hour=${isoHour(end)}`;
  const raw = await omFetch(url, o.signal, "Open-Meteo forecast");
  const arr: any[] = Array.isArray(raw) ? raw : [raw];
  if (arr[0]?.error) throw new Error(`Open-Meteo: ${arr[0].reason}`);
  const times: string[] = arr[0].hourly.time;
  const epochMs = Date.parse(times[0] + "Z");
  const timesS = times.map(t => (Date.parse(t + "Z") - epochMs) / 1000);
  const columns: GridColumn[] = arr.map((pt, k) => {
    const h = pt.hourly;
    const elev = pt.elevation ?? 0;
    const perTime: GridColumnLevel[][] = times.map((_, i) => {
      const lv: GridColumnLevel[] = [];
      const sp = h.surface_pressure?.[i]; const t2 = h.temperature_2m?.[i];
      // above-ground winds: altitude = model surface elevation + AGL; T, p from the surface (hydrostatic-ish)
      for (const agl of SURFACE_AGL) {
        const ws = h[`wind_speed_${agl}m`]?.[i], wd = h[`wind_direction_${agl}m`]?.[i];
        if (ws == null || wd == null) continue;
        const [u, v] = uvFromDirSpeed(wd, ws);
        const T = (t2 ?? 15) + 273.15 - 0.0065 * agl;
        const p = (sp ?? 1013) * 100 * Math.exp((-9.80665 * agl) / (287.053 * T));
        lv.push({ z: elev + agl, u, v, T, p });
      }
      for (const pl of levels) {
        const ws = h[`wind_speed_${pl}hPa`]?.[i], wd = h[`wind_direction_${pl}hPa`]?.[i], z = h[`geopotential_height_${pl}hPa`]?.[i], T = h[`temperature_${pl}hPa`]?.[i];
        if (ws == null || wd == null || z == null || T == null) continue;
        if (z < elev + 200) continue; // pressure level is underground or inside the surface layer we already covered
        const [u, v] = uvFromDirSpeed(wd, ws);
        lv.push({ z, u, v, T: T + 273.15, p: pl * 100 });
      }
      lv.sort((a, b) => a.z - b.z);
      return lv;
    });
    return { lat: qlat[k], lon: qlon[k], times: perTime };
  });
  const runLabel = `${MODEL_LABEL[o.model]}, data ${times[0]}Z..${times[times.length - 1]}Z`;
  const field = new GridWindField(timesS, columns, runLabel);
  const ci = columns.findIndex(c => Math.abs(c.lat - o.lat) < step / 2 + 1e-6 && Math.abs(c.lon - o.lon) < step / 2 + 1e-6);
  const li = timesS.findIndex(t => epochMs + t * 1000 >= o.launch.getTime());
  const centre = columns[ci >= 0 ? ci : 0];
  return { field, epochMs, lats, lons, launchColumn: centre.times[Math.max(0, li)], surfaceElevationM: arr[ci >= 0 ? ci : 0].elevation ?? 0, generatedAtMs: Date.now(), model: o.model };
}

/** ECMWF ensemble at one point and hour: returns perturbation profiles (member - control). */
export async function fetchEnsemblePerturbations(lat: number, lon: number, launch: Date, signal?: AbortSignal): Promise<{ z: number[]; du: number[]; dv: number[] }[]> {
  const hour = new Date(Math.round(launch.getTime() / 3600e3) * 3600e3);
  return cached(`ens|${lat.toFixed(3)},${lon.toFixed(3)}|${isoHour(hour)}`, 30 * 60e3, () => fetchEnsembleUncached(lat, lon, hour, signal));
}
async function fetchEnsembleUncached(lat: number, lon: number, hour: Date, signal?: AbortSignal): Promise<{ z: number[]; du: number[]; dv: number[] }[]> {
  const levels = MODEL_LEVELS.ecmwf_ifs025;
  const vars: string[] = [];
  for (const p of levels) vars.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`);
  const url = `${OM_HOSTS.ensemble}?latitude=${lat}&longitude=${lon}&hourly=${vars.join(",")}&models=ecmwf_ifs025&wind_speed_unit=ms&timezone=UTC&start_hour=${isoHour(hour)}&end_hour=${isoHour(hour)}`;
  const d = await omFetch(url, signal, "Open-Meteo ensemble");
  const h = d.hourly;
  const control = levels.map(p => ({ z: h[`geopotential_height_${p}hPa`]?.[0], ws: h[`wind_speed_${p}hPa`]?.[0], wd: h[`wind_direction_${p}hPa`]?.[0] }));
  const out: { z: number[]; du: number[]; dv: number[] }[] = [];
  for (let m = 1; m <= 50; m++) {
    const sfx = `_member${String(m).padStart(2, "0")}`;
    const z: number[] = [], du: number[] = [], dv: number[] = [];
    for (let i = 0; i < levels.length; i++) {
      const p = levels[i];
      const ws = h[`wind_speed_${p}hPa${sfx}`]?.[0], wd = h[`wind_direction_${p}hPa${sfx}`]?.[0];
      const c = control[i];
      if (ws == null || wd == null || c.ws == null || c.wd == null || c.z == null) continue;
      const [u1, v1] = uvFromDirSpeed(wd, ws), [u0, v0] = uvFromDirSpeed(c.wd, c.ws);
      z.push(c.z); du.push(u1 - u0); dv.push(v1 - v0);
    }
    if (z.length >= 5) out.push({ z, du, dv });
  }
  return out;
}

/**
 * Copernicus DEM GLO-90 elevation via Open-Meteo, up to 100 points per call. Successive chunks are
 * spaced 350 ms apart and a 429 (rate limit) is retried after a back-off, because a burst of
 * back-to-back 100-point calls was observed to be throttled.
 */
const elevMemo = new Map<string, number>();
export async function fetchElevations(points: [number, number][], signal?: AbortSignal): Promise<number[]> {
  const keyOf = (p: [number, number]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`; // ~110 m cells, the DEM is 90 m
  const out: number[] = new Array(points.length);
  const missing: number[] = [];
  points.forEach((p, i) => { const v = elevMemo.get(keyOf(p)); if (v !== undefined) { out[i] = v; apiStats.cacheHits++; } else missing.push(i); });
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < missing.length; i += 100) {
    const idx = missing.slice(i, i + 100);
    const url = `${OM_HOSTS.elevation}?latitude=${idx.map(k => points[k][0].toFixed(5)).join(",")}&longitude=${idx.map(k => points[k][1].toFixed(5)).join(",")}`;
    const d = await omFetch(url, signal, "Open-Meteo elevation");
    idx.forEach((k, j) => { out[k] = d.elevation[j]; elevMemo.set(keyOf(points[k]), d.elevation[j]); });
    if (i + 100 < missing.length) await sleep(350);
  }
  return out;
}

/* ------------------------------------------------------------------ geocoding */
export interface GeocodeHit { name: string; latitude: number; longitude: number; elevation: number; country_code: string; admin1?: string; admin2?: string; population?: number }
/** Open-Meteo geocoding (GeoNames-based, no key). */
export async function geocode(q: string, count = 8, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const url = `${OM_HOSTS.geocoding}?name=${encodeURIComponent(q)}&count=${count}&language=en&format=json`;
  const d = await omFetch(url, signal, "Open-Meteo geocoding");
  return (d.results ?? []) as GeocodeHit[];
}

/* ------------------------------------------------------------------ GFS archive at any point */
/**
 * Historical GFS columns at a point from Open-Meteo's historical-forecast archive (short-lead
 * forecasts archived daily since 2021-03; 23 levels 1000..10 hPa). One request per calendar month.
 * Returns profiles in the same shape as public/data/gfs_jejuri_profiles.json: u, v on a 250 m grid
 * (0.1 m/s ints) from 0 m AMSL plus the [z, T, p] column, for the requested UTC hours only.
 */
export interface ArchiveProfile { d: string; h: number; uv: [number, number][]; col: [number, number, number][] }
export async function fetchGfsArchiveProfiles(o: { lat: number; lon: number; months: number[]; years: number[]; hoursUtc: number[]; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): Promise<ArchiveProfile[]> {
  const levels = MODEL_LEVELS.gfs_seamless;
  const vars: string[] = [];
  for (const p of levels) vars.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`, `temperature_${p}hPa`);
  const jobs: [number, number][] = [];
  const today = new Date();
  for (const y of o.years) for (const mo of o.months) { if (y > today.getUTCFullYear() || (y === today.getUTCFullYear() && mo > today.getUTCMonth() + 1)) continue; if (y < 2021 || (y === 2021 && mo < 4)) continue; jobs.push([y, mo]); }
  const out: ArchiveProfile[] = [];
  let done = 0;
  o.onProgress?.(0, jobs.length);
  for (const [y, mo] of jobs) {
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const url = `${OM_HOSTS.archive}?latitude=${o.lat}&longitude=${o.lon}&start_date=${y}-${String(mo).padStart(2, "0")}-01&end_date=${y}-${String(mo).padStart(2, "0")}-${last}&hourly=${vars.join(",")}&models=gfs_seamless&wind_speed_unit=ms&timezone=UTC`;
    const d = await cached(`arch|${o.lat.toFixed(2)},${o.lon.toFixed(2)}|${y}-${mo}`, 24 * 3600e3, () => omFetch(url, o.signal, "Open-Meteo archive"));
    const h = d.hourly; const times: string[] = h.time;
    for (let i = 0; i < times.length; i++) {
      if (!o.hoursUtc.includes(+times[i].slice(11, 13))) continue;
      const lv: { z: number; u: number; v: number; T: number; p: number }[] = [];
      for (const pl of levels) {
        const z = h[`geopotential_height_${pl}hPa`]?.[i], ws = h[`wind_speed_${pl}hPa`]?.[i], wd = h[`wind_direction_${pl}hPa`]?.[i], T = h[`temperature_${pl}hPa`]?.[i];
        if (z == null || ws == null || wd == null || T == null) continue;
        const [u, v] = uvFromDirSpeed(wd, ws);
        lv.push({ z, u, v, T: T + 273.15, p: pl * 100 });
      }
      lv.sort((a, b) => a.z - b.z);
      if (lv.length < 15 || lv[lv.length - 1].z < 30000) continue;
      const uv: [number, number][] = [];
      let j = 0;
      for (let z = 0; z <= lv[lv.length - 1].z; z += 250) {
        let u: number, v: number;
        if (z <= lv[0].z) { u = lv[0].u; v = lv[0].v; }
        else { while (j < lv.length - 2 && lv[j + 1].z < z) j++; const a = lv[j], b = lv[j + 1]; const f = b.z > a.z ? (z - a.z) / (b.z - a.z) : 0; u = a.u + f * (b.u - a.u); v = a.v + f * (b.v - a.v); }
        uv.push([Math.round(u * 10), Math.round(v * 10)]);
      }
      out.push({ d: times[i].slice(0, 10), h: +times[i].slice(11, 13), uv, col: lv.map(l => [Math.round(l.z), Math.round(l.T * 10), Math.round(l.p)]) });
    }
    done++; o.onProgress?.(done, jobs.length);
  }
  return out;
}
