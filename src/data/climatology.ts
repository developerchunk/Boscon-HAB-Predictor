/**
 * Historical wind profiles for climatology:
 *   /data/igra_profiles.json  measured radiosondes (NOAA IGRA v2), Pune 2016-, Mumbai & Nagpur 2022-, Goa, Hyderabad
 *   /data/gfs_jejuri_profiles.json  daily 05/06 UTC GFS columns at the Jejuri pad, 2022-01 .. 2026
 * Both are on a 250 m altitude grid from 0 m AMSL, u/v in 0.1 m/s.
 */
import { ProfileWindField } from "../physics/wind";
import { Column } from "../physics/atmosphere";

export interface StoredProfile { s?: string; d: string; h: number; uv: [number, number][]; col?: [number, number, number][] }
export interface IgraStation { name: string; lat: number; lon: number; elev_m: number; year_from: number; n_profiles: number; per_year: Record<string, number> }
export interface IgraBundle { meta: { grid_step_m: number; source: string }; stations: Record<string, IgraStation>; profiles: StoredProfile[] }
export interface GfsBundle { meta: { grid_step_m: number; source: string; hours_utc: number[] }; profiles: StoredProfile[] }

let igraCache: Promise<IgraBundle> | null = null;
let gfsCache: Promise<GfsBundle> | null = null;
export function loadIgra(): Promise<IgraBundle> {
  if (!igraCache) igraCache = fetch(`${import.meta.env.BASE_URL}data/igra_profiles.json`).then(r => { if (!r.ok) throw new Error("igra_profiles.json missing"); return r.json(); });
  return igraCache;
}
export function loadGfs(): Promise<GfsBundle> {
  if (!gfsCache) gfsCache = fetch(`${import.meta.env.BASE_URL}data/gfs_jejuri_profiles.json`).then(r => { if (!r.ok) throw new Error("gfs_jejuri_profiles.json missing"); return r.json(); });
  return gfsCache;
}

export function profileToField(p: StoredProfile, stepM: number, label: string): ProfileWindField {
  const z = p.uv.map((_, i) => i * stepM);
  const u = p.uv.map(x => x[0] / 10), v = p.uv.map(x => x[1] / 10);
  let col: Column | undefined;
  if (p.col && p.col.length >= 3) col = new Column(p.col.map(c => ({ z: c[0], T: c[1] / 10, p: c[2] })));
  return new ProfileWindField(z, u, v, label, col);
}

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthOf = (p: StoredProfile) => +p.d.slice(5, 7);
export const yearOf = (p: StoredProfile) => +p.d.slice(0, 4);

/** Speed/direction statistics at a set of altitudes for a set of profiles. */
export interface LevelStat { z: number; n: number; meanU: number; meanV: number; meanSpeed: number; p50Speed: number; p95Speed: number; maxSpeed: number; /** direction the mean wind blows FROM, deg */ meanFromDeg: number; /** fraction of profiles with eastward u */ fracEast: number }
export function levelStats(profiles: StoredProfile[], stepM: number, altitudes: number[]): LevelStat[] {
  return altitudes.map(z => {
    const i = Math.round(z / stepM);
    const us: number[] = [], vs: number[] = [], sp: number[] = [];
    for (const p of profiles) { const x = p.uv[i]; if (!x) continue; const u = x[0] / 10, v = x[1] / 10; us.push(u); vs.push(v); sp.push(Math.hypot(u, v)); }
    const n = us.length;
    if (!n) return { z, n: 0, meanU: 0, meanV: 0, meanSpeed: 0, p50Speed: 0, p95Speed: 0, maxSpeed: 0, meanFromDeg: 0, fracEast: 0 };
    const mu = us.reduce((a, b) => a + b, 0) / n, mv = vs.reduce((a, b) => a + b, 0) / n;
    const s = [...sp].sort((a, b) => a - b);
    const q = (f: number) => s[Math.min(n - 1, Math.floor(f * (n - 1)))];
    return { z, n, meanU: mu, meanV: mv, meanSpeed: sp.reduce((a, b) => a + b, 0) / n, p50Speed: q(0.5), p95Speed: q(0.95), maxSpeed: s[n - 1], meanFromDeg: (Math.atan2(-mu, -mv) * 180 / Math.PI + 360) % 360, fracEast: us.filter(u => u > 0).length / n };
  });
}
