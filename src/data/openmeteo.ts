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

export type ModelId = "gfs_seamless" | "icon_seamless" | "ecmwf_ifs025";
export const MODEL_LEVELS: Record<ModelId, number[]> = {
  gfs_seamless: [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 40, 30, 20, 15, 10],
  icon_seamless: [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30],
  ecmwf_ifs025: [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50, 10],
};
export const MODEL_LABEL: Record<ModelId, string> = {
  gfs_seamless: "NOAA GFS (0.25°, 23 levels to 10 hPa ≈ 31 km)",
  icon_seamless: "DWD ICON (19 levels to 30 hPa ≈ 24 km)",
  ecmwf_ifs025: "ECMWF IFS (0.25°, 14 levels to 10 hPa)",
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
  const half = o.halfSpanDeg ?? 1.0, step = o.stepDeg ?? 0.5;
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
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${qlat.join(",")}&longitude=${qlon.join(",")}&hourly=${vars.join(",")}&models=${o.model}&wind_speed_unit=ms&timezone=UTC&start_hour=${isoHour(start)}&end_hour=${isoHour(end)}`;
  const resp = await fetch(url, { signal: o.signal });
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const raw = await resp.json();
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
  const levels = MODEL_LEVELS.ecmwf_ifs025;
  const vars: string[] = [];
  for (const p of levels) vars.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`);
  const hour = new Date(Math.round(launch.getTime() / 3600e3) * 3600e3);
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}&hourly=${vars.join(",")}&models=ecmwf_ifs025&wind_speed_unit=ms&timezone=UTC&start_hour=${isoHour(hour)}&end_hour=${isoHour(hour)}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`Open-Meteo ensemble ${resp.status}`);
  const d = await resp.json();
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

/** Copernicus DEM GLO-90 elevation via Open-Meteo, up to 100 points per call. */
export async function fetchElevations(points: [number, number][], signal?: AbortSignal): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map(p => p[0].toFixed(5)).join(",")}&longitude=${chunk.map(p => p[1].toFixed(5)).join(",")}`;
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`elevation ${resp.status}`);
    const d = await resp.json();
    out.push(...(d.elevation as number[]));
  }
  return out;
}

/* ------------------------------------------------------------------ geocoding */
export interface GeocodeHit { name: string; latitude: number; longitude: number; elevation: number; country_code: string; admin1?: string; admin2?: string; population?: number }
/** Open-Meteo geocoding (GeoNames-based, no key). */
export async function geocode(q: string, count = 8, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=${count}&language=en&format=json`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`geocoding ${resp.status}`);
  const d = await resp.json();
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
    const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${o.lat}&longitude=${o.lon}&start_date=${y}-${String(mo).padStart(2, "0")}-01&end_date=${y}-${String(mo).padStart(2, "0")}-${last}&hourly=${vars.join(",")}&models=gfs_seamless&wind_speed_unit=ms&timezone=UTC`;
    const resp = await fetch(url, { signal: o.signal });
    if (!resp.ok) throw new Error(`Open-Meteo archive ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const d = await resp.json();
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
