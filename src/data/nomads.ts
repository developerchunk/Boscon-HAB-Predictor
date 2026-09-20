/**
 * Native GFS 0.25° columns from the local NOMADS bridge (scripts/gfs_nomads_bridge.py):
 * every model grid point within ±half degrees of the pad, hourly, all 41 pressure levels
 * (1000 hPa .. 1 hPa kept, i.e. to ~48 km) plus the 10/80/100 m winds, decoded from NOAA's own
 * GRIB2 files. No API key, no quota beyond NOAA's per-IP courtesy limit, and no interpolation
 * before the data reaches the integrator.
 */
import { GridWindField, type GridColumn, type GridColumnLevel } from "../physics/wind";
import { cached, type FetchGridOptions, type GridFetchResult } from "./openmeteo";

export const NOMADS_BRIDGE = ((import.meta.env.VITE_NOMADS_BRIDGE as string | undefined)?.trim() || "http://localhost:8787").replace(/\/$/, "");
export const NOMADS_MODEL_ID = "nomads_gfs025" as const;

export async function bridgeOnline(timeoutMs = 1500): Promise<boolean> {
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${NOMADS_BRIDGE}/health`, { signal: ac.signal }); clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

const isoHour = (d: Date) => d.toISOString().slice(0, 13) + ":00Z";

export async function fetchNomadsGrid(o: FetchGridOptions): Promise<GridFetchResult> {
  const half = o.halfSpanDeg ?? 1.0;
  const start = new Date(o.launch.getTime() - (o.hoursBefore ?? 1) * 3600e3), end = new Date(o.launch.getTime() + (o.hoursAfter ?? 8) * 3600e3);
  const key = `nomads|${o.lat.toFixed(3)},${o.lon.toFixed(3)}|${half}|${isoHour(start)}|${isoHour(end)}`;
  return cached(key, 30 * 60e3, async () => {
    const url = `${NOMADS_BRIDGE}/gfs?lat=${o.lat}&lon=${o.lon}&start=${isoHour(start)}&end=${isoHour(end)}&half=${half}`;
    let resp: Response;
    try { resp = await fetch(url, { signal: o.signal }); }
    catch (e: any) { if (e?.name === "AbortError") throw e; throw new Error(`The NOMADS bridge at ${NOMADS_BRIDGE} is not running. Start it with "npm run bridge" (needs the .venv-grib virtualenv with eccodes; see README), or choose an Open-Meteo model.`); }
    const d = await resp.json();
    if (!resp.ok || d.error) throw new Error(`NOMADS bridge: ${d.error ?? resp.status}`);
    const times: string[] = d.times;
    const epochMs = Date.parse(times[0] + "Z");
    const timesS = times.map(t => (Date.parse(t + "Z") - epochMs) / 1000);
    const columns: GridColumn[] = d.columns.map((c: any) => ({ lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4), times: c.times.map((lv: any[]) => lv.map(q => ({ z: q.z, u: q.u, v: q.v, T: q.T, p: q.p }) as GridColumnLevel).sort((a: GridColumnLevel, b: GridColumnLevel) => a.z - b.z)) }));
    const field = new GridWindField(timesS, columns, `${d.source}, data ${times[0]}Z..${times[times.length - 1]}Z`);
    let ci = 0, best = Infinity;
    columns.forEach((c, i) => { const dd = Math.hypot(c.lat - o.lat, (c.lon - o.lon) * Math.cos((o.lat * Math.PI) / 180)); if (dd < best) { best = dd; ci = i; } });
    const li = Math.max(0, timesS.findIndex(t => epochMs + t * 1000 >= o.launch.getTime()));
    return { field, epochMs, lats: [...new Set(columns.map(c => c.lat))].sort((a, b) => a - b), lons: [...new Set(columns.map(c => c.lon))].sort((a, b) => a - b), launchColumn: columns[ci].times[li], surfaceElevationM: d.columns[ci].elevation ?? 0, generatedAtMs: Date.now(), model: NOMADS_MODEL_ID };
  });
}
