/**
 * Orchestration: user inputs -> fill -> nominal flight -> terrain refinement -> Monte Carlo.
 * Pure functions where possible; network calls live in src/data.
 */
import { balloonById, neckLiftForAscentRate, neckLiftForBurstAltitude, simulateAscent, cusfBurstCalc, type CdModel, type Gas, type AscentConfig } from "./balloon";
import { terminalVelocity, fromSeaLevelRate, type DescentConfig } from "./descent";
import { flyTrajectory, type FlightConfig, type FlightResult } from "./trajectory";
import { runMonteCarlo, type McConfig, type McResult } from "./montecarlo";
import type { WindField } from "./wind";
import type { Atmosphere } from "./atmosphere";
import { RHO_SL } from "./constants";

export type FillMode = "ascentRate" | "neckLift" | "burstAlt";
export type AscentModel = CdModel | "constantRate";
export type DescentMode = "chute" | "seaLevelRate";

export interface PredictInputs {
  launchLat: number; launchLon: number; launchAltM: number;
  launchUtc: Date;
  balloonId: string; gas: Gas;
  /** everything under the balloon: payload boxes, parachute, rigging, kg */
  payloadKg: number;
  fillMode: FillMode; targetAscentMs: number; neckLiftKg: number; targetBurstAltM: number;
  ascentModel: AscentModel;
  /** burst-diameter multiplier applied to the maker's nominal (1.0 = trust the spec) */
  burstDiameterFactor: number;
  descentMode: DescentMode; chuteDiameterM: number; chuteCd: number; seaLevelDescentMs: number;
  /** balloon remnant mass assumed to stay attached during descent, kg */
  remnantKg: number;
  floatMinutes: number;
  dtS: number;
}

export interface FillPlan {
  neckLiftKg: number; freeLiftKg: number; grossLiftKg: number; launchVolumeM3: number; launchDiameterM: number; gasKg: number;
  padAscentMs: number; burstAltM: number; burstTimeMin: number; meanAscentMs: number; burstDiameterM: number;
  padRho: number; padT: number; padP: number;
  /** CUSF calculator answer for the same inputs, for comparison */
  cusf: { neckLiftG: number; burstAltM: number; timeToBurstMin: number; ascentRateMs: number; launchVolumeM3: number };
  descentSeaLevelMs: number; descentAtBurstMs: number; descentAtGroundMs: number; descent: DescentConfig;
  cdScale: number;
  warnings: string[];
}

/** Work out the fill and the vertical profile for the pad atmosphere. */
export function planFill(inp: PredictInputs, atmosphere: Atmosphere): FillPlan {
  const b = balloonById(inp.balloonId);
  const warnings: string[] = [];
  const burstDia = b.burstDiameterM * inp.burstDiameterFactor;
  const pad = atmosphere.state(inp.launchAltM);
  // Fill is always planned with the CUSF-style constant Cd (0.25/0.30) because that is what the
  // manufacturers' free-lift tables and the whole community's launch practice are calibrated to.
  const planCfg: Omit<AscentConfig, "neckLiftKg"> = { balloonMassKg: b.massG / 1000, payloadKg: inp.payloadKg, gas: inp.gas, burstDiameterM: burstDia, cdModel: "constant", cdConstant: b.cdCusf, launchAltM: inp.launchAltM, atmosphere };
  let neckLift: number;
  if (inp.fillMode === "neckLift") neckLift = inp.neckLiftKg;
  else if (inp.fillMode === "burstAlt") {
    const nl = neckLiftForBurstAltitude(planCfg, inp.targetBurstAltM);
    if (nl === null) { warnings.push(`Target burst altitude ${inp.targetBurstAltM} m is unreachable with this balloon and payload; using the lightest fill that still ascends at 1 m/s.`); neckLift = neckLiftForAscentRate(planCfg, 1.0); }
    else neckLift = nl;
  } else neckLift = neckLiftForAscentRate(planCfg, inp.targetAscentMs);
  const padRun = simulateAscent({ ...planCfg, neckLiftKg: neckLift, maxAltM: inp.launchAltM + 100 });
  const padAscent = padRun.track[0].v;
  // The flight itself uses the chosen drag model anchored to the pad ascent rate.
  const flightModel: CdModel = inp.ascentModel === "constantRate" ? "constant" : inp.ascentModel;
  const run = simulateAscent({ ...planCfg, neckLiftKg: neckLift, cdModel: flightModel, padAscentMs: padAscent });
  if (!run.burst) warnings.push("Balloon does not reach its burst diameter below 45 km with this fill: it would float. Add gas.");
  if (padAscent < 3.5) warnings.push(`Pad ascent rate ${padAscent.toFixed(2)} m/s is in float territory (UKHAS rule of thumb: below ~3.5 m/s the balloon may never burst).`);
  if (padAscent > 7) warnings.push(`Pad ascent rate ${padAscent.toFixed(2)} m/s is high; more than ~6 m/s wastes gas and lowers burst altitude (Randall, Akerman).`);
  const cusf = cusfBurstCalc({ balloonMassKg: b.massG / 1000, payloadKg: inp.payloadKg, gas: inp.gas, burstDiameterM: burstDia, cd: b.cdCusf, targetAscentMs: padAscent });

  // descent
  const massDown = inp.payloadKg + inp.remnantKg;
  const descent: DescentConfig = inp.descentMode === "chute" ? { massKg: massDown, chuteDiameterM: inp.chuteDiameterM, cd: inp.chuteCd } : fromSeaLevelRate(inp.seaLevelDescentMs, massDown);
  const vSL = terminalVelocity(RHO_SL, descent);
  const vBurst = terminalVelocity(atmosphere.state(run.burstAltM).rho, descent);
  const vGround = terminalVelocity(pad.rho, descent);
  if (vGround > 7) warnings.push(`Descent speed at the pad altitude is ${vGround.toFixed(1)} m/s; most groups aim for 4-6 m/s at touchdown.`);
  return {
    neckLiftKg: neckLift, freeLiftKg: run.freeLiftKg, grossLiftKg: run.grossLiftKg, launchVolumeM3: run.launchVolumeM3, launchDiameterM: run.launchDiameterM, gasKg: run.gasKg,
    padAscentMs: padAscent, burstAltM: run.burstAltM, burstTimeMin: run.burstTimeS / 60, meanAscentMs: run.meanAscentMs, burstDiameterM: burstDia,
    padRho: pad.rho, padT: pad.T, padP: pad.p,
    cusf: { neckLiftG: cusf.neckLiftG, burstAltM: cusf.burstAltitudeM, timeToBurstMin: cusf.timeToBurstMin, ascentRateMs: cusf.ascentRateMs, launchVolumeM3: cusf.launchVolumeM3 },
    descentSeaLevelMs: vSL, descentAtBurstMs: vBurst, descentAtGroundMs: vGround, descent, cdScale: run.cdScale, warnings,
  };
}

export function buildFlightConfig(inp: PredictInputs, plan: FillPlan, launchTimeS: number, groundAltAt?: (lat: number, lon: number) => number): FlightConfig {
  const b = balloonById(inp.balloonId);
  const cfg: FlightConfig = {
    launchLat: inp.launchLat, launchLon: inp.launchLon, launchAltM: inp.launchAltM, launchTimeS,
    ascent: { balloonMassKg: b.massG / 1000, payloadKg: inp.payloadKg, gas: inp.gas, burstDiameterM: plan.burstDiameterM, cdModel: inp.ascentModel === "constantRate" ? "constant" : inp.ascentModel, cdConstant: b.cdCusf, neckLiftKg: plan.neckLiftKg, padAscentMs: plan.padAscentMs },
    descent: plan.descent, dtS: inp.dtS, groundAltAt,
    floatDurationS: inp.floatMinutes > 0 ? inp.floatMinutes * 60 : undefined,
  };
  if (inp.ascentModel === "constantRate") { cfg.constantAscentMs = plan.padAscentMs; cfg.burstAltOverrideM = plan.burstAltM; }
  return cfg;
}

/** Fly the nominal trajectory, then refine the ground altitude at the landing point with a DEM lookup. */
export async function flyWithTerrain(field: WindField, cfg: FlightConfig, dem: (pts: [number, number][]) => Promise<number[]>, maxIter = 3): Promise<{ result: FlightResult; groundAltM: number; iterations: number; demError?: string }> {
  let ground = cfg.launchAltM;
  let res = flyTrajectory(field, { ...cfg, groundAltAt: () => ground });
  let it = 0; let demError: string | undefined;
  for (; it < maxIter; it++) {
    let g: number;
    try { [g] = await dem([[res.landing.lat, res.landing.lon]]); }
    catch (e: any) { demError = String(e?.message ?? e); break; } // keep the flight; report that the ground height is the pad's
    if (!Number.isFinite(g)) break;
    if (Math.abs(g - ground) < 15) { ground = g; break; }
    ground = g;
    res = flyTrajectory(field, { ...cfg, groundAltAt: () => ground });
  }
  return { result: res, groundAltM: ground, iterations: it, demError };
}

export interface McRequest { cfg: FlightConfig; mc: McConfig; groundAltM: number }
export function runMc(field: WindField, req: McRequest, onProgress?: (i: number) => void): McResult {
  return runMonteCarlo(field, { ...req.cfg, groundAltAt: () => req.groundAltM }, req.mc, onProgress);
}
