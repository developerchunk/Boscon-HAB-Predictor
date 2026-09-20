/**
 * Monte Carlo landing dispersion.
 *
 * Each run draws one realisation of the things an operator cannot pin down:
 *   burst diameter   Weibull, k = 14.36 (ASTRA fit to radiosonde bursts), mean = nominal * meanRatio
 *   neck lift        Gaussian, sigma = fillSigma (default 5% — spring-scale reading in wind)
 *   payload mass     Gaussian, sigma 3%
 *   chute Cd         uniform ±(cdSpread), default ±20% (ASTRA: 0.7..1.1 on 0.9)
 *   balloon remnant  uniform 3%..100% of envelope mass stays attached (ASTRA)
 *   wind             either an ensemble member (real NWP spread) or, failing that, an
 *                    AR(1)-in-altitude perturbation with sigma_w (m/s) and 2 km correlation
 *                    length — the fallback is an ASSUMPTION, labelled as such in the UI.
 * Output: landing scatter plus 50/90/95% covariance ellipses (chi-square, 2 dof).
 */
import { flyTrajectory, type FlightConfig, type FlightResult } from "./trajectory";
import { PerturbedWindField, type WindField } from "./wind";
import { sampleBurstDiameter } from "./balloon";
import { eastNorthM, offsetLatLon } from "./geo";

export interface McConfig {
  runs: number;
  seed: number;
  burstMeanRatio: number;   // 1.0 trusts the nominal diameter
  fillSigma: number;        // fraction of neck lift
  payloadSigma: number;     // fraction
  chuteCdSpread: number;    // fraction, uniform
  remnant: boolean;
  windSigmaMs: number;      // fallback wind perturbation, m/s (0 disables)
  /** optional ensemble perturbation profiles: each {z[], du[], dv[]} */
  ensemble?: { z: number[]; du: number[]; dv: number[] }[];
  balloonMassKg: number;
}

export interface Ellipse { cx: number; cy: number; a: number; b: number; thetaDeg: number; prob: number; centerLat: number; centerLon: number }
export interface McResult {
  landings: { lat: number; lon: number; east: number; north: number; burstAlt: number; durationS: number; range: number }[];
  ellipses: Ellipse[];
  meanLat: number; meanLon: number;
  medianRangeM: number; p95RangeM: number; maxRangeM: number;
  burstAltP5: number; burstAltP50: number; burstAltP95: number;
  windSource: "ensemble" | "ar1" | "none";
}

/** Deterministic PRNG (mulberry32) so a run can be reproduced from its seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r: () => number): number {
  let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** AR(1) perturbation profile on a 500 m grid to 40 km with correlation length Lc. */
function ar1Profile(r: () => number, sigma: number, LcM = 2000, dz = 500, top = 40000) {
  const phi = Math.exp(-dz / LcM), s = sigma * Math.sqrt(1 - phi * phi);
  const z: number[] = [], du: number[] = [], dv: number[] = [];
  let u = sigma * gauss(r), v = sigma * gauss(r);
  for (let zz = 0; zz <= top; zz += dz) { z.push(zz); du.push(u); dv.push(v); u = phi * u + s * gauss(r); v = phi * v + s * gauss(r); }
  return { z, du, dv };
}

function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b); const k = (s.length - 1) * q; const lo = Math.floor(k), hi = Math.ceil(k);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (k - lo);
}

export function runMonteCarlo(field: WindField, base: FlightConfig, mc: McConfig, onProgress?: (i: number) => void): McResult {
  const r = rng(mc.seed);
  const landings: McResult["landings"] = [];
  const nominalBurst = base.ascent.burstDiameterM;
  for (let i = 0; i < mc.runs; i++) {
    const cfg: FlightConfig = JSON.parse(JSON.stringify(base));
    cfg.groundAltAt = base.groundAltAt;
    cfg.ascent.burstDiameterM = sampleBurstDiameter(nominalBurst, mc.burstMeanRatio, r());
    cfg.ascent.neckLiftKg = base.ascent.neckLiftKg * (1 + mc.fillSigma * gauss(r));
    const payloadFactor = 1 + mc.payloadSigma * gauss(r);
    cfg.ascent.payloadKg = base.ascent.payloadKg * payloadFactor;
    if (cfg.ascent.neckLiftKg <= cfg.ascent.payloadKg + 0.05) cfg.ascent.neckLiftKg = cfg.ascent.payloadKg + 0.05;
    cfg.descent.cd = base.descent.cd * (1 + mc.chuteCdSpread * (2 * r() - 1));
    const remnantKg = mc.remnant ? mc.balloonMassKg * (0.03 + 0.97 * r()) : 0;
    cfg.descent.massKg = base.descent.massKg * payloadFactor + remnantKg;
    if (base.constantAscentMs !== undefined) cfg.constantAscentMs = base.constantAscentMs * (1 + mc.fillSigma * gauss(r));
    if (base.burstAltOverrideM !== undefined && base.constantAscentMs !== undefined) cfg.burstAltOverrideM = base.burstAltOverrideM * (cfg.ascent.burstDiameterM / nominalBurst);

    let f: WindField = field;
    if (mc.ensemble && mc.ensemble.length) {
      const m = mc.ensemble[Math.floor(r() * mc.ensemble.length)];
      f = new PerturbedWindField(field, m.z, m.du, m.dv);
    } else if (mc.windSigmaMs > 0) {
      const p = ar1Profile(r, mc.windSigmaMs);
      f = new PerturbedWindField(field, p.z, p.du, p.dv);
    }
    let res: FlightResult;
    try { res = flyTrajectory(f, { ...cfg, dtS: base.dtS ?? 10 }); } catch { continue; }
    const [e, n] = eastNorthM(base.launchLat, base.launchLon, res.landing.lat, res.landing.lon);
    landings.push({ lat: res.landing.lat, lon: res.landing.lon, east: e, north: n, burstAlt: res.burst.z, durationS: res.durationS, range: res.rangeM });
    onProgress?.(i);
  }
  const n = landings.length;
  const mx = landings.reduce((s, l) => s + l.east, 0) / n, my = landings.reduce((s, l) => s + l.north, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const l of landings) { sxx += (l.east - mx) ** 2; syy += (l.north - my) ** 2; sxy += (l.east - mx) * (l.north - my); }
  sxx /= n - 1; syy /= n - 1; sxy /= n - 1;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det)), l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const theta = Math.atan2(l1 - sxx, sxy); // angle of major axis from east, radians
  const [cLat, cLon] = offsetLatLon(base.launchLat, base.launchLon, mx, my);
  const ellipses: Ellipse[] = [[0.5, 1.386], [0.9, 4.605], [0.95, 5.991]].map(([prob, chi2]) => ({
    cx: mx, cy: my, a: Math.sqrt(chi2 * l1), b: Math.sqrt(chi2 * Math.max(l2, 0)), thetaDeg: (theta * 180) / Math.PI, prob, centerLat: cLat, centerLon: cLon,
  }));
  const ranges = landings.map(l => l.range), bursts = landings.map(l => l.burstAlt);
  return {
    landings, ellipses, meanLat: cLat, meanLon: cLon,
    medianRangeM: pct(ranges, 0.5), p95RangeM: pct(ranges, 0.95), maxRangeM: Math.max(...ranges),
    burstAltP5: pct(bursts, 0.05), burstAltP50: pct(bursts, 0.5), burstAltP95: pct(bursts, 0.95),
    windSource: mc.ensemble?.length ? "ensemble" : mc.windSigmaMs > 0 ? "ar1" : "none",
  };
}

/** Points of an ellipse (for drawing), lat/lon. */
export function ellipsePolygon(e: Ellipse, launchLat: number, launchLon: number, n = 72): [number, number][] {
  const out: [number, number][] = [];
  const th = (e.thetaDeg * Math.PI) / 180;
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    const x = e.a * Math.cos(a), y = e.b * Math.sin(a);
    const ex = e.cx + x * Math.cos(th) - y * Math.sin(th), ny = e.cy + x * Math.sin(th) + y * Math.cos(th);
    const [la, lo] = offsetLatLon(launchLat, launchLon, ex, ny);
    out.push([lo, la]);
  }
  return out;
}
