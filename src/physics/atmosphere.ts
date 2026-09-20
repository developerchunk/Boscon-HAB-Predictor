/**
 * US Standard Atmosphere 1976 (USSA76), 0 to 86 km, plus helpers.
 *
 * Source: NOAA/NASA/USAF, "U.S. Standard Atmosphere, 1976", NASA-TM-X-74335.
 * Layer bases are in GEOPOTENTIAL metres; callers pass GEOMETRIC altitude
 * (what a GPS reports) and we convert with H = r0*Z/(r0+Z), r0 = 6356.766 km.
 *
 * Verified against USSA76 Table I in atmosphere.test.ts (11 km: 22632 Pa,
 * 20 km: 5474.9 Pa, 32 km: 868.02 Pa, 47 km: 110.91 Pa).
 */
import { G0, M_AIR, R_STAR, R_AIR, R_EARTH_GEOPOT, SUTHERLAND_BETA, SUTHERLAND_S } from "./constants";

export interface AtmoState {
  /** temperature, K */
  T: number;
  /** pressure, Pa */
  p: number;
  /** density, kg/m^3 */
  rho: number;
}

// USSA76 Table 4: base geopotential height (m), base temperature (K), lapse rate (K/m).
const LAYERS: { Hb: number; Tb: number; L: number; pb: number }[] = [
  { Hb: 0, Tb: 288.15, L: -0.0065, pb: 101325 },
  { Hb: 11000, Tb: 216.65, L: 0, pb: 0 },
  { Hb: 20000, Tb: 216.65, L: 0.001, pb: 0 },
  { Hb: 32000, Tb: 228.65, L: 0.0028, pb: 0 },
  { Hb: 47000, Tb: 270.65, L: 0, pb: 0 },
  { Hb: 51000, Tb: 270.65, L: -0.0028, pb: 0 },
  { Hb: 71000, Tb: 214.65, L: -0.002, pb: 0 },
  { Hb: 84852, Tb: 186.946, L: 0, pb: 0 },
];
// Fill in base pressures by integrating layer by layer (this reproduces the published values).
for (let i = 1; i < LAYERS.length; i++) {
  const lo = LAYERS[i - 1];
  const dH = LAYERS[i].Hb - lo.Hb;
  if (lo.L === 0) {
    LAYERS[i].pb = lo.pb * Math.exp((-G0 * M_AIR * dH) / (R_STAR * lo.Tb));
  } else {
    const T = lo.Tb + lo.L * dH;
    LAYERS[i].pb = lo.pb * Math.pow(lo.Tb / T, (G0 * M_AIR) / (R_STAR * lo.L));
  }
}

/** Geometric altitude (m) to geopotential height (m). USSA76 eq. 18. */
export function geopotential(zGeometric: number): number {
  return (R_EARTH_GEOPOT * zGeometric) / (R_EARTH_GEOPOT + zGeometric);
}
/** Geopotential height (m) to geometric altitude (m). Inverse of the above. */
export function geometric(hGeopotential: number): number {
  return (R_EARTH_GEOPOT * hGeopotential) / (R_EARTH_GEOPOT - hGeopotential);
}

/** ISA state at a GEOMETRIC altitude in metres. Valid 0..86 km; clamped outside. */
export function isa(zGeometric: number): AtmoState {
  const H = Math.min(Math.max(geopotential(zGeometric), 0), 86000);
  let i = LAYERS.length - 1;
  while (i > 0 && LAYERS[i].Hb > H) i--;
  const L = LAYERS[i];
  const dH = H - L.Hb;
  let T: number, p: number;
  if (L.L === 0) {
    T = L.Tb;
    p = L.pb * Math.exp((-G0 * M_AIR * dH) / (R_STAR * L.Tb));
  } else {
    T = L.Tb + L.L * dH;
    p = L.pb * Math.pow(L.Tb / T, (G0 * M_AIR) / (R_STAR * L.L));
  }
  return { T, p, rho: p / (R_AIR * T) };
}

/** Geometric altitude (m) for an ISA pressure (Pa). Bisection on isa(); 1 mm precision. */
export function isaAltitudeForPressure(pPa: number): number {
  let lo = 0, hi = 86000;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (isa(mid).p > pPa) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Dynamic viscosity of air, Pa s, Sutherland's law (USSA76 eq. 51). */
export function viscosity(T: number): number {
  return (SUTHERLAND_BETA * Math.pow(T, 1.5)) / (T + SUTHERLAND_S);
}

/**
 * A real atmospheric column built from forecast or radiosonde levels:
 * arrays of geometric altitude (m), temperature (K) and pressure (Pa), ascending in altitude.
 * Density is p/(R T) at each level; between levels T is linear and ln(p) is linear in z
 * (hydrostatic in an isothermal slab), which is exact to well under 0.1% for level
 * spacings of a few km. Above the top level we fall back to ISA scaled to match the top level.
 */
export class Column {
  private readonly z: number[];
  private readonly T: number[];
  private readonly lnp: number[];
  readonly top: number;
  readonly bottom: number;
  private readonly topScale: number;
  constructor(levels: { z: number; T: number; p: number }[]) {
    const s = [...levels].filter(l => Number.isFinite(l.z) && Number.isFinite(l.T) && Number.isFinite(l.p) && l.p > 0).sort((a, b) => a.z - b.z);
    if (s.length < 2) throw new Error("Column needs at least two levels");
    this.z = s.map(l => l.z); this.T = s.map(l => l.T); this.lnp = s.map(l => Math.log(l.p));
    this.top = this.z[this.z.length - 1]; this.bottom = this.z[0];
    this.topScale = s[s.length - 1].p / isa(this.top).p;
  }
  state(zGeometric: number): AtmoState {
    if (zGeometric >= this.top) {
      const a = isa(zGeometric);
      // keep the column's own top temperature ratio and scale pressure continuously
      const p = a.p * this.topScale;
      return { T: a.T, p, rho: p / (R_AIR * a.T) };
    }
    if (zGeometric <= this.bottom) {
      // below the lowest level (e.g. underground pressure level): hydrostatic extrapolation with the bottom temperature
      const T = this.T[0];
      const p = Math.exp(this.lnp[0]) * Math.exp((-G0 * (zGeometric - this.bottom)) / (R_AIR * T));
      return { T, p, rho: p / (R_AIR * T) };
    }
    let lo = 0, hi = this.z.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.z[m] <= zGeometric) lo = m; else hi = m; }
    const f = (zGeometric - this.z[lo]) / (this.z[hi] - this.z[lo]);
    const T0 = this.T[lo], T1 = this.T[hi];
    const T = T0 + f * (T1 - T0);
    let p: number;
    if (Math.abs(T1 - T0) < 0.05) {
      p = Math.exp(this.lnp[lo] + f * (this.lnp[hi] - this.lnp[lo])); // isothermal slab: ln p linear in z
    } else {
      // hydrostatic layer with linear T: p = p0 (T/T0)^k, with k fitted so that p(z1) = p1 exactly
      const k = (this.lnp[hi] - this.lnp[lo]) / Math.log(T1 / T0);
      p = Math.exp(this.lnp[lo] + k * Math.log(T / T0));
    }
    return { T, p, rho: p / (R_AIR * T) };
  }
}

/** An atmosphere is anything that returns (T, p, rho) at a geometric altitude. */
export interface Atmosphere { state(z: number): AtmoState }
export const ISA: Atmosphere = { state: isa };
