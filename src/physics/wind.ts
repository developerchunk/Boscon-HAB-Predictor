/**
 * Wind fields. A WindField answers "what is (u, v) at (lat, lon, altitude, time)?"
 * and optionally provides the thermodynamic column so density is consistent with the winds.
 *
 * Interpolation follows what Tawhiri does (interpolate.pyx): linear in time, bilinear
 * in lat/lon, linear in altitude between the two bracketing levels. Above the top level
 * the top wind is HELD (Tawhiri extrapolates; holding is safer and we flag it).
 */
import { Column, type Atmosphere, isa } from "./atmosphere";

export interface WindSample { u: number; v: number; /** true when altitude was above the data top */ clipped: boolean }

export interface WindField {
  /** u east, v north in m/s at geometric altitude z (m), time t (seconds since field epoch) */
  wind(lat: number, lon: number, z: number, t: number): WindSample;
  /** density/temperature column at (lat, lon, t); ISA if the source has no thermodynamics */
  atmosphere(lat: number, lon: number, t: number): Atmosphere;
  /** highest altitude with real data, m */
  topAltitude: number;
  /** a label for the UI ("GFS 0.25° run 2026-09-20 06Z", "Pune radiosonde 2025-11-03 00Z") */
  label: string;
}

/** One vertical profile on a fixed altitude grid, no spatial or temporal variation. */
export class ProfileWindField implements WindField {
  readonly topAltitude: number;
  readonly z: number[]; readonly u: number[]; readonly v: number[]; readonly label: string;
  private readonly column?: Column;
  constructor(z: number[], u: number[], v: number[], label: string, column?: Column) {
    this.z = z; this.u = u; this.v = v; this.label = label; this.column = column;
    this.topAltitude = z[z.length - 1];
  }
  wind(_lat: number, _lon: number, z: number, _t: number): WindSample {
    const n = this.z.length;
    if (z <= this.z[0]) return { u: this.u[0], v: this.v[0], clipped: false };
    if (z >= this.z[n - 1]) return { u: this.u[n - 1], v: this.v[n - 1], clipped: z > this.z[n - 1] + 1 };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.z[m] <= z) lo = m; else hi = m; }
    const f = (z - this.z[lo]) / (this.z[hi] - this.z[lo]);
    return { u: this.u[lo] + f * (this.u[hi] - this.u[lo]), v: this.v[lo] + f * (this.v[hi] - this.v[lo]), clipped: false };
  }
  atmosphere(): Atmosphere { return this.column ?? { state: isa }; }
}

/**
 * A 4-D gridded field built from point time-series (what Open-Meteo returns): a regular
 * lat/lon grid of columns, each with hourly levels of (u, v, geopotential height, T, p).
 */
export interface GridColumnLevel { z: number; u: number; v: number; T: number; p: number }
export interface GridColumn { lat: number; lon: number; /** per time index, levels ascending in z */ times: GridColumnLevel[][] }

export class GridWindField implements WindField {
  readonly topAltitude: number;
  readonly timesS: number[]; readonly label: string;
  private readonly lats: number[]; private readonly lons: number[];
  private readonly cols: GridColumn[][]; // [iLat][iLon]
  private readonly columnsCache = new Map<string, Column>();
  constructor(timesS: number[], columns: GridColumn[], label: string) {
    this.timesS = timesS; this.label = label;
    this.lats = [...new Set(columns.map(c => c.lat))].sort((a, b) => a - b);
    this.lons = [...new Set(columns.map(c => c.lon))].sort((a, b) => a - b);
    this.cols = this.lats.map(la => this.lons.map(lo => {
      const c = columns.find(x => x.lat === la && x.lon === lo);
      if (!c) throw new Error(`grid hole at ${la},${lo}`);
      return c;
    }));
    let top = Infinity;
    for (const row of this.cols) for (const c of row) for (const lv of c.times) top = Math.min(top, lv[lv.length - 1].z);
    this.topAltitude = top;
  }
  private bracket(arr: number[], x: number): [number, number, number] {
    const n = arr.length;
    if (n === 1 || x <= arr[0]) return [0, 0, 0];
    if (x >= arr[n - 1]) return [n - 1, n - 1, 0];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m; else hi = m; }
    return [lo, hi, (x - arr[lo]) / (arr[hi] - arr[lo])];
  }
  private levelInterp(levels: GridColumnLevel[], z: number): [number, number, boolean] {
    const n = levels.length;
    if (z <= levels[0].z) return [levels[0].u, levels[0].v, false];
    if (z >= levels[n - 1].z) return [levels[n - 1].u, levels[n - 1].v, z > levels[n - 1].z + 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (levels[m].z <= z) lo = m; else hi = m; }
    const f = (z - levels[lo].z) / (levels[hi].z - levels[lo].z);
    return [levels[lo].u + f * (levels[hi].u - levels[lo].u), levels[lo].v + f * (levels[hi].v - levels[lo].v), false];
  }
  wind(lat: number, lon: number, z: number, t: number): WindSample {
    const [ia, ib, fa] = this.bracket(this.lats, lat);
    const [ja, jb, fb] = this.bracket(this.lons, lon);
    const [ta, tb, ft] = this.bracket(this.timesS, t);
    let u = 0, v = 0, clipped = false;
    const corners: [number, number, number][] = [[ia, ja, (1 - fa) * (1 - fb)], [ia, jb, (1 - fa) * fb], [ib, ja, fa * (1 - fb)], [ib, jb, fa * fb]];
    for (const [i, j, w] of corners) {
      if (w === 0) continue;
      const col = this.cols[i][j];
      const [u0, v0, c0] = this.levelInterp(col.times[ta], z);
      const [u1, v1, c1] = this.levelInterp(col.times[tb], z);
      u += w * ((1 - ft) * u0 + ft * u1); v += w * ((1 - ft) * v0 + ft * v1);
      clipped = clipped || c0 || c1;
    }
    return { u, v, clipped };
  }
  atmosphere(lat: number, lon: number, t: number): Atmosphere {
    // nearest grid column, nearest hour: density varies by <1% across the grid, not worth interpolating
    const i = this.nearest(this.lats, lat), j = this.nearest(this.lons, lon), k = this.nearest(this.timesS, t);
    const key = `${i},${j},${k}`;
    let c = this.columnsCache.get(key);
    if (!c) { c = new Column(this.cols[i][j].times[k].map(l => ({ z: l.z, T: l.T, p: l.p }))); this.columnsCache.set(key, c); }
    return c;
  }
  private nearest(arr: number[], x: number): number {
    let best = 0;
    for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - x) < Math.abs(arr[best] - x)) best = i;
    return best;
  }
}

/** Adds a perturbation profile (e.g. an ensemble member minus control) to a base field. */
export class PerturbedWindField implements WindField {
  readonly topAltitude: number;
  readonly label: string;
  private readonly base: WindField; private readonly dz: number[]; private readonly du: number[]; private readonly dv: number[];
  constructor(base: WindField, dz: number[], du: number[], dv: number[], label?: string) {
    this.base = base; this.dz = dz; this.du = du; this.dv = dv;
    this.topAltitude = base.topAltitude; this.label = label ?? base.label + " + perturbation";
  }
  wind(lat: number, lon: number, z: number, t: number): WindSample {
    const b = this.base.wind(lat, lon, z, t);
    const n = this.dz.length;
    let du: number, dv: number;
    if (z <= this.dz[0]) { du = this.du[0]; dv = this.dv[0]; }
    else if (z >= this.dz[n - 1]) { du = this.du[n - 1]; dv = this.dv[n - 1]; }
    else {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.dz[m] <= z) lo = m; else hi = m; }
      const f = (z - this.dz[lo]) / (this.dz[hi] - this.dz[lo]);
      du = this.du[lo] + f * (this.du[hi] - this.du[lo]); dv = this.dv[lo] + f * (this.dv[hi] - this.dv[lo]);
    }
    return { u: b.u + du, v: b.v + dv, clipped: b.clipped };
  }
  atmosphere(lat: number, lon: number, t: number): Atmosphere { return this.base.atmosphere(lat, lon, t); }
}
