/**
 * Latex balloon fill, ascent-rate and burst model.
 *
 * Two models live here on purpose:
 *
 *  1. `cusfBurstCalc` — a line-for-line transcription of the CUSF / SondeHub burst
 *     calculator (sondehub.org/calc/js/calc.js, Steve Randall's burst1a maths). It is
 *     kept as a cross-check, because every HAB group compares against it. Its
 *     simplifications: sea-level air density 1.2050 kg/m^3 regardless of launch
 *     site, constant ascent rate, and an exponential atmosphere with a 7238.3 m
 *     scale height for the burst altitude.
 *
 *  2. `simulateAscent` — the physical model this predictor actually flies:
 *     - gas is at ambient p, T (latex is unstressed), so V(z) = n R T(z) / p(z),
 *       i.e. the displaced air mass and therefore the FREE LIFT are constant with
 *       altitude (rho_air * V = n * M_air * const);
 *     - quasi-steady vertical force balance every step:
 *           F_free = 0.5 * rho * v^2 * Cd * A(z),   A = pi D(z)^2 / 4
 *       so v(z) = sqrt(2 F_free / (rho Cd A)). With A ∝ V^(2/3) ∝ rho^(-2/3) this gives
 *       v ∝ rho^(-1/6) for constant Cd (a 31 km ascent ends ~2x faster than it started);
 *     - Cd is either a constant (CUSF: 0.25 for >= 1200 g) or the Reynolds-number
 *       dependent fit used by the Southampton ASTRA simulator (Sóbester et al., AIAA J.
 *       52(4) 2014), which raises Cd from 0.225 to 0.425 as Re falls through ~3.3e5 —
 *       this is what makes real stratospheric ascent rates flatten;
 *     - burst is on DIAMETER, not altitude (the manufacturer's spec is a diameter).
 *     The atmosphere can be ISA or a real forecast/radiosonde column.
 */
import { G0, M_AIR, M_H2, M_HE, R_STAR } from "./constants";
import { isa, viscosity, type Atmosphere } from "./atmosphere";

export type Gas = "hydrogen" | "helium";
export const GAS_MOLAR_MASS: Record<Gas, number> = { hydrogen: M_H2, helium: M_HE };

export interface BalloonSpec {
  id: string;
  maker: string;
  massG: number;
  /** manufacturer nominal burst diameter, m */
  burstDiameterM: number;
  /** drag coefficient the CUSF calculator assigns (constant-Cd model) */
  cdCusf: number;
  source: string;
}

/**
 * Burst diameters (m). Sources, all read 2026-09-20:
 *  - Kaymont/Totex: Kaymont spec sheets, as tabulated in sondehub.org/calc/js/calc.js (find_bd).
 *  - Hwoyee: hwoyee.com product table (">= 9100 mm" for HY-1200), adopted by SondeHub 2024-11;
 *    the older UKHAS/CUSF table had 8.50 m. Both kept.
 *  - Pawan: Pawan Rubber Products technical data sheet CPR-1200 (2012): burst 800 cm, 31 km at 1 kg payload.
 * Cd: CUSF calc.js find_cd: 0.25 for all sizes except 0.30 for 600..1000 g ("Hwoyee/Pawan data guesswork").
 */
export const BALLOONS: BalloonSpec[] = [
  { id: "k1000", maker: "Kaymont / Totex", massG: 1000, burstDiameterM: 7.86, cdCusf: 0.30, source: "Kaymont Totex sounding balloon data via CUSF calc.js" },
  { id: "k1200", maker: "Kaymont / Totex", massG: 1200, burstDiameterM: 8.63, cdCusf: 0.25, source: "Kaymont KCI/HAB-1200 spec sheet: burst 863 cm, 33.2 km at 1050 g payload, 1190 g free lift" },
  { id: "k1500", maker: "Kaymont / Totex", massG: 1500, burstDiameterM: 9.44, cdCusf: 0.25, source: "Kaymont via CUSF calc.js" },
  { id: "k2000", maker: "Kaymont / Totex", massG: 2000, burstDiameterM: 10.54, cdCusf: 0.25, source: "Kaymont via CUSF calc.js" },
  { id: "h1000", maker: "Hwoyee", massG: 1000, burstDiameterM: 8.00, cdCusf: 0.30, source: "hwoyee.com HY-1000 (SondeHub 2024-11 table)" },
  { id: "h1200", maker: "Hwoyee (2024 table)", massG: 1200, burstDiameterM: 9.10, cdCusf: 0.25, source: "hwoyee.com HY-1200: burst >= 9100 mm, avg 33 km at 250 g payload / 2240 g free lift" },
  { id: "h1200old", maker: "Hwoyee (UKHAS 8.50 m table)", massG: 1200, burstDiameterM: 8.50, cdCusf: 0.25, source: "ukhas.org.uk guides:balloon_data / GitHub cusf-burst-calc" },
  { id: "h1600", maker: "Hwoyee", massG: 1600, burstDiameterM: 10.00, cdCusf: 0.25, source: "hwoyee.com (SondeHub 2024-11 table)" },
  { id: "h2000", maker: "Hwoyee", massG: 2000, burstDiameterM: 11.00, cdCusf: 0.25, source: "SondeHub table (\"fudged a little\")" },
  { id: "p1200", maker: "Pawan CPR-1200 (Pune)", massG: 1200, burstDiameterM: 8.00, cdCusf: 0.25, source: "Pawan Rubber Products CPR-1200 data sheet 2012: burst 800 cm, 31 km at 1000 g payload, 1180 g free lift, 325 m/min" },
  { id: "p1600", maker: "Pawan CPR-1600 (Pune)", massG: 1600, burstDiameterM: 9.50, cdCusf: 0.25, source: "randomaerospace.com Pawan table via CUSF calc.js" },
  { id: "p2000", maker: "Pawan CPR-2000 (Pune)", massG: 2000, burstDiameterM: 10.20, cdCusf: 0.25, source: "randomaerospace.com Pawan table via CUSF calc.js" },
];
export const balloonById = (id: string): BalloonSpec => {
  const b = BALLOONS.find(x => x.id === id);
  if (!b) throw new Error(`unknown balloon ${id}`);
  return b;
};

/* ------------------------------------------------------------------ CUSF cross-check */
/** Constants exactly as in sondehub.org/calc index.html defaults. */
export const CUSF = { rhoAir: 1.2050, rhoH2: 0.0899, rhoHe: 0.1786, scaleHeight: 7238.3, g: 9.80665 };

export interface CusfResult {
  launchRadiusM: number; launchVolumeM3: number; launchDiameterM: number;
  grossLiftKg: number; neckLiftG: number; freeLiftN: number; freeLiftG: number;
  ascentRateMs: number; burstAltitudeM: number; timeToBurstMin: number;
}
/**
 * CUSF/SondeHub burst calculator, transcribed from calc.js `calc_update`.
 * Give either targetAscentMs or targetBurstAltM (the other undefined).
 */
export function cusfBurstCalc(o: { balloonMassKg: number; payloadKg: number; gas: Gas; burstDiameterM: number; cd: number; targetAscentMs?: number; targetBurstAltM?: number }): CusfResult {
  const { rhoAir, scaleHeight: adm, g } = CUSF;
  const rhoG = o.gas === "hydrogen" ? CUSF.rhoH2 : CUSF.rhoHe;
  const mb = o.balloonMassKg, mp = o.payloadKg, cd = o.cd;
  const burstVolume = (4 / 3) * Math.PI * Math.pow(o.burstDiameterM / 2, 3);
  let r: number;
  if (o.targetBurstAltM !== undefined) {
    const V = burstVolume * Math.exp(-o.targetBurstAltM / adm);
    r = Math.pow((3 * V) / (4 * Math.PI), 1 / 3);
  } else if (o.targetAscentMs !== undefined) {
    // a r^3 + b r^2 + d = 0, Cardano, exactly as calc.js
    const a = g * (rhoAir - rhoG) * (4 / 3) * Math.PI;
    const b = -0.5 * o.targetAscentMs ** 2 * cd * rhoAir * Math.PI;
    const c = 0, d = -(mp + mb) * g;
    const f = (3 * c) / a - (b * b) / (a * a) / 3;
    const gg = ((2 * b ** 3) / a ** 3 - (9 * b * c) / (a * a) + (27 * d) / a) / 27;
    const h = (gg * gg) / 4 + (f ** 3) / 27;
    if (h <= 0) throw new Error("expect exactly one real root");
    const R = -0.5 * gg + Math.sqrt(h), S = Math.cbrt(R);
    const T = -0.5 * gg - Math.sqrt(h), U = Math.cbrt(T);
    r = S + U - b / (3 * a);
  } else throw new Error("need targetAscentMs or targetBurstAltM");
  const launchArea = Math.PI * r * r;
  const launchVolume = (4 / 3) * Math.PI * r ** 3;
  const grossLift = launchVolume * (rhoAir - rhoG);
  const neckLiftG = (grossLift - mb) * 1000;
  const freeLiftN = (grossLift - mp - mb) * g;
  const ascentRate = Math.sqrt(freeLiftN / (0.5 * cd * launchArea * rhoAir));
  const burstAltitude = -adm * Math.log(launchVolume / burstVolume);
  return {
    launchRadiusM: r, launchVolumeM3: launchVolume, launchDiameterM: 2 * r, grossLiftKg: grossLift, neckLiftG,
    freeLiftN, freeLiftG: (grossLift - mp - mb) * 1000, ascentRateMs: ascentRate, burstAltitudeM: burstAltitude,
    timeToBurstMin: burstAltitude / ascentRate / 60,
  };
}

/* ------------------------------------------------------------------ physical model */
export type CdModel = "constant" | "astra" | "gallice";
/** ASTRA balloonDrag constants (astra_simulator/flight_tools.py). Re is DIAMETER-based there. */
export const ASTRA_CD = { lowCD: 0.225, highCD: 0.425, transitionRe: 3.296e5, bandRe: 0.363e5 };

/**
 * Gallice et al. (2011), AMT 4, 2235, eq. (6): drag curve fitted to 10 night flights of
 * Totex TX1200 balloons (LUAMI campaign, Lindenberg 2008):
 *     c_D = 4.808e-2 (ln Re)^2 - 1.406 ln Re + 10.490,   Re = rho R v / mu  (RADIUS-based)
 * Fit scatter sigma = 0.04; balloon-to-balloon offsets +-25%. It gives 0.26-0.32 at
 * Re 5-8e5 (matching the manufacturers' 0.2-0.3) and rises to ~1 at Re ~3e4 (30 km), which is
 * what makes measured ascent rates nearly constant with height instead of rising as rho^(-1/6).
 * Because the per-balloon offset is multiplicative, the predictor uses this curve for the
 * SHAPE of v(z) and anchors its level to the ascent rate at the pad (see AscentConfig.padAscentMs).
 */
export function galliceCd(ReRadius: number): number {
  const l = Math.log(Math.max(ReRadius, 1));
  return 4.808e-2 * l * l - 1.406 * l + 10.49;
}

/** Cd for a given model. `ReD` is the diameter-based Reynolds number rho v D / mu. */
export function balloonCd(model: CdModel, cdConstant: number, ReD: number): number {
  if (model === "constant") return cdConstant;
  if (model === "gallice") return galliceCd(ReD / 2);
  const { lowCD, highCD, transitionRe, bandRe } = ASTRA_CD;
  if (ReD < transitionRe) return highCD;
  if (ReD > transitionRe + bandRe) return lowCD;
  return highCD + ((lowCD - highCD) * (ReD - transitionRe)) / bandRe;
}

export interface AscentConfig {
  balloonMassKg: number;
  payloadKg: number;         // everything hanging under the balloon: payload, chute, rigging
  gas: Gas;
  burstDiameterM: number;
  cdModel: CdModel;
  cdConstant: number;        // used when cdModel === "constant"
  launchAltM: number;        // geometric altitude of the pad
  atmosphere: Atmosphere;    // ISA or a forecast Column
  /** amount of gas, expressed as neck lift measured at the pad with a spring scale, kg.
   *  Neck lift = buoyancy - balloon envelope mass = what the scale reads with the payload detached. */
  neckLiftKg: number;
  /**
   * If set, the Cd curve is multiplied by a constant so that the ascent rate at the pad equals
   * this value (m/s). This absorbs the +-25% balloon-to-balloon drag offset (Gallice 2011) into
   * one measurable number — the rate you see in the first minutes, or the rate the fill was
   * designed for — while keeping the curve's altitude dependence. Burst altitude is unaffected
   * (it depends only on gas quantity and burst diameter).
   */
  padAscentMs?: number;
  maxAltM?: number;          // stop here if the balloon has not burst (default 45 km)
  dz?: number;               // integration step, m (default 25)
}

export interface AscentPoint { z: number; t: number; v: number; D: number; Re: number; Cd: number; rho: number }
export interface AscentResult {
  burstAltM: number; burstTimeS: number; burstDiameterM: number; burst: boolean;
  gasKg: number; gasMoles: number; launchVolumeM3: number; launchDiameterM: number;
  freeLiftKg: number; grossLiftKg: number; neckLiftKg: number;
  meanAscentMs: number; track: AscentPoint[];
  /** multiplier applied to the Cd curve to hit padAscentMs (1 when not anchored) */
  cdScale: number;
}

/** Gas density at (p, T), kg/m^3 — ideal gas. */
export function gasDensity(gas: Gas, p: number, T: number): number {
  return (p * GAS_MOLAR_MASS[gas]) / (R_STAR * T);
}
/** Air density at (p, T) via the same gas law, so the buoyancy uses consistent numbers. */
export function airDensity(p: number, T: number): number {
  return (p * M_AIR) / (R_STAR * T);
}

/** Launch volume (m^3) that gives the requested neck lift at pad conditions. */
export function launchVolumeForNeckLift(neckLiftKg: number, balloonMassKg: number, gas: Gas, p: number, T: number): number {
  return (neckLiftKg + balloonMassKg) / (airDensity(p, T) - gasDensity(gas, p, T));
}

/** Integrate the ascent with a quasi-steady force balance. */
export function simulateAscent(c: AscentConfig): AscentResult {
  const dz = c.dz ?? 25;
  const maxAlt = c.maxAltM ?? 45000;
  const pad = c.atmosphere.state(c.launchAltM);
  const V0 = launchVolumeForNeckLift(c.neckLiftKg, c.balloonMassKg, c.gas, pad.p, pad.T);
  const n = (pad.p * V0) / (R_STAR * pad.T);
  const gasKg = n * GAS_MOLAR_MASS[c.gas];
  const grossLiftKg = V0 * airDensity(pad.p, pad.T) - gasKg; // buoyancy minus gas weight... see note
  // Note: "gross lift" in CUSF usage = V*(rho_air - rho_gas), i.e. buoyant force minus gas weight, in kg-force.
  const freeLiftKg = c.neckLiftKg - c.payloadKg;
  if (freeLiftKg <= 0) throw new Error(`neck lift ${c.neckLiftKg.toFixed(3)} kg is below the payload ${c.payloadKg.toFixed(3)} kg: it will not lift off`);
  const F = freeLiftKg * G0; // constant with altitude for an unstressed latex balloon

  const track: AscentPoint[] = [];
  let z = c.launchAltM, t = 0, D = 0, burst = false;
  let v = 1; // initial guess for the Re iteration
  let cdScale = 1;
  const solveV = (a: { rho: number; T: number }, Dm: number, vGuess: number): [number, number, number] => {
    const A = (Math.PI * Dm * Dm) / 4;
    const mu = viscosity(a.T);
    let vv = vGuess, Cd = c.cdConstant;
    for (let k = 0; k < 8; k++) { // fixed point on v <-> Re <-> Cd
      const Re = (a.rho * vv * Dm) / mu;
      Cd = cdScale * balloonCd(c.cdModel, c.cdConstant, Re);
      vv = Math.sqrt((2 * F) / (a.rho * Cd * A));
    }
    return [vv, Cd, (a.rho * vv * Dm) / mu];
  };
  if (c.padAscentMs !== undefined && c.padAscentMs > 0) {
    // choose cdScale so that v(pad) == padAscentMs: v ∝ Cd^(-1/2), so iterate twice for the Re coupling
    const D0 = Math.cbrt((6 * V0) / Math.PI);
    for (let k = 0; k < 40; k++) {
      const [vp] = solveV(pad, D0, c.padAscentMs);
      if (Math.abs(vp / c.padAscentMs - 1) < 1e-5) break;
      cdScale *= (vp / c.padAscentMs) ** 2;
    }
  }
  while (z < maxAlt) {
    const a = c.atmosphere.state(z);
    const V = (n * R_STAR * a.T) / a.p;
    D = Math.cbrt((6 * V) / Math.PI);
    if (D >= c.burstDiameterM) { burst = true; break; }
    let Cd: number, Re: number;
    [v, Cd, Re] = solveV(a, D, v);
    if (track.length === 0 || z - track[track.length - 1].z >= 100 - 1e-6) track.push({ z, t, v, D, Re, Cd, rho: a.rho });
    t += dz / v;
    z += dz;
  }
  track.push({ z, t, v, D, Re: 0, Cd: 0, rho: c.atmosphere.state(z).rho });
  return {
    burstAltM: z, burstTimeS: t, burstDiameterM: D, burst, gasKg, gasMoles: n, launchVolumeM3: V0,
    launchDiameterM: Math.cbrt((6 * V0) / Math.PI), freeLiftKg, grossLiftKg, neckLiftKg: c.neckLiftKg,
    meanAscentMs: (z - c.launchAltM) / t, track, cdScale,
  };
}

/** Neck lift (kg) that gives a target ascent rate at the pad. Bisection. */
export function neckLiftForAscentRate(c: Omit<AscentConfig, "neckLiftKg">, targetMs: number): number {
  let lo = c.payloadKg + 0.001, hi = c.payloadKg + 15;
  const rateAtPad = (nl: number) => {
    const r = simulateAscent({ ...c, neckLiftKg: nl, maxAltM: c.launchAltM + 200, dz: 25 });
    return r.track[0].v;
  };
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (rateAtPad(mid) < targetMs) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Neck lift (kg) that bursts at a target altitude (ISA or given column). Bisection on burst altitude. */
export function neckLiftForBurstAltitude(c: Omit<AscentConfig, "neckLiftKg">, targetAltM: number): number | null {
  let lo = c.payloadKg + 0.001, hi = c.payloadKg + 15;
  const burstAt = (nl: number) => simulateAscent({ ...c, neckLiftKg: nl, dz: 50 }).burstAltM;
  if (burstAt(lo) < targetAltM) return null; // even the lightest fill bursts too low
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (burstAt(mid) > targetAltM) lo = mid; else hi = mid; // more gas -> bigger at launch -> bursts lower
  }
  return 0.5 * (lo + hi);
}

/** ISA convenience for the burst calculator UI. */
export const ISA_ATMOS: Atmosphere = { state: isa };

/**
 * Burst-diameter scatter. ASTRA (available_balloons_parachutes.py) fits a Weibull to
 * observed radiosonde bursts with shape k = 14.3577 for every size and scale lambda such
 * that mean/nominal = 1.08116 (e.g. TA1200: nominal 8.63 m, lambda 9.6758 m; HW1200: 8.5 m, 9.5301 m).
 * A Weibull with k = 14.36 has coefficient of variation ~8.5%.
 * We expose the mean ratio as a parameter (default 1.0 = trust the maker's nominal, which is
 * what the UKHAS flight data suggests for Kaymont/Totex; Hwoyee tends to exceed nominal).
 */
export const BURST_WEIBULL_K = 14.3577;
export function sampleBurstDiameter(nominalM: number, meanRatio: number, u01: number): number {
  const gamma1p1k = gammaFn(1 + 1 / BURST_WEIBULL_K);
  const lambda = (nominalM * meanRatio) / gamma1p1k;
  return lambda * Math.pow(-Math.log(1 - u01), 1 / BURST_WEIBULL_K);
}
/** Lanczos approximation of the gamma function (enough for Gamma(1.07)). */
function gammaFn(x: number): number {
  const g = 7, p = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  x -= 1;
  let a = p[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += p[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}
