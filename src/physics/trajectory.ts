/**
 * Flight integrator.
 *
 * State: (lat, lon, z). Horizontal motion is pure advection by the wind (a balloon has no
 * airspeed of its own); the vertical speed is the ascent model until burst, then the
 * quasi-steady parachute terminal speed (see descent.ts for why quasi-steady is adequate).
 *
 * Integration: classical RK4 with a fixed step (default 5 s; Tawhiri uses 60 s). Position
 * rates in deg/s follow Tawhiri's spherical form: dlat = v / R, dlon = u / (R cos lat),
 * R = 6371009 + z. Landing is found by bisection inside the last step to 1 cm.
 *
 * Ground: the caller supplies `groundAltAt(lat, lon)`; the default is the launch elevation.
 * `predictFlight` in predictor.ts refines this with a DEM lookup at the landing point.
 */
import { R_EARTH_MEAN } from "./constants";
import type { WindField } from "./wind";
import { terminalVelocity, type DescentConfig } from "./descent";
import { simulateAscent, type AscentConfig, type AscentResult } from "./balloon";
import { distanceM, bearingDeg, eastNorthM } from "./geo";

export interface TrajectoryPoint { t: number; lat: number; lon: number; z: number; w: number; u: number; v: number; stage: "ascent" | "float" | "descent" }

export interface FlightConfig {
  launchLat: number; launchLon: number; launchAltM: number;
  /** seconds after the wind field epoch at which the balloon is released */
  launchTimeS: number;
  ascent: Omit<AscentConfig, "atmosphere" | "launchAltM">;
  /** alternatively, a fixed ascent rate (Tawhiri style); when set, `ascent` physics are bypassed */
  constantAscentMs?: number;
  /** burst altitude override (m); when set, burst happens here regardless of diameter */
  burstAltOverrideM?: number;
  descent: DescentConfig;
  floatDurationS?: number;
  dtS?: number;
  groundAltAt?: (lat: number, lon: number) => number;
  maxFlightS?: number;
}

export interface LayerContribution { zFrom: number; zTo: number; ascentEast: number; ascentNorth: number; descentEast: number; descentNorth: number; ascentTimeS: number; descentTimeS: number }

export interface FlightResult {
  points: TrajectoryPoint[];
  burst: { lat: number; lon: number; z: number; t: number; diameterM: number; byDiameter: boolean };
  landing: { lat: number; lon: number; z: number; t: number; groundAlt: number; impactMs: number };
  rangeM: number; bearingDeg: number; eastM: number; northM: number;
  durationS: number; ascentS: number; descentS: number;
  maxDescentMs: number;
  layers: LayerContribution[];
  windClipped: boolean;
  ascentModel?: AscentResult;
}

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function flyTrajectory(field: WindField, c: FlightConfig): FlightResult {
  const dt = c.dtS ?? 5;
  const maxT = c.maxFlightS ?? 6 * 3600;
  const ground = c.groundAltAt ?? (() => c.launchAltM);
  const atmos = field.atmosphere(c.launchLat, c.launchLon, c.launchTimeS);

  // ---- vertical model
  let ascentModel: AscentResult | undefined;
  let ascentRateAt: (z: number) => number;
  let burstAlt: number;
  let burstDia = 0;
  let byDiameter = false;
  if (c.constantAscentMs !== undefined) {
    ascentRateAt = () => c.constantAscentMs!;
    burstAlt = c.burstAltOverrideM ?? Infinity;
  } else {
    ascentModel = simulateAscent({ ...c.ascent, atmosphere: atmos, launchAltM: c.launchAltM, maxAltM: c.burstAltOverrideM ?? 45000 });
    const tr = ascentModel.track;
    ascentRateAt = (z: number) => {
      if (z <= tr[0].z) return tr[0].v;
      if (z >= tr[tr.length - 1].z) return tr[tr.length - 1].v;
      let lo = 0, hi = tr.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr[m].z <= z) lo = m; else hi = m; }
      const f = (z - tr[lo].z) / (tr[hi].z - tr[lo].z);
      return tr[lo].v + f * (tr[hi].v - tr[lo].v);
    };
    burstAlt = c.burstAltOverrideM !== undefined ? Math.min(c.burstAltOverrideM, ascentModel.burstAltM) : ascentModel.burstAltM;
    burstDia = ascentModel.burstDiameterM;
    byDiameter = ascentModel.burst && (c.burstAltOverrideM === undefined || ascentModel.burstAltM <= c.burstAltOverrideM);
  }
  if (!Number.isFinite(burstAlt)) throw new Error("no burst altitude: give burstAltOverrideM with constantAscentMs");

  // ---- state
  let lat = c.launchLat, lon = c.launchLon, z = c.launchAltM, w = 0, t = c.launchTimeS;
  let stage: TrajectoryPoint["stage"] = "ascent";
  const points: TrajectoryPoint[] = [];
  let clipped = false, maxDesc = 0;
  const layerEdges = [0, 1000, 2000, 3000, 5000, 7000, 10000, 12000, 15000, 18000, 21000, 24000, 27000, 30000, 33000, 36000, 40000, 50000];
  const layers: LayerContribution[] = [];
  for (let i = 0; i < layerEdges.length - 1; i++) layers.push({ zFrom: layerEdges[i], zTo: layerEdges[i + 1], ascentEast: 0, ascentNorth: 0, descentEast: 0, descentNorth: 0, ascentTimeS: 0, descentTimeS: 0 });
  const layerOf = (zz: number) => { let i = 0; while (i < layers.length - 1 && zz >= layers[i].zTo) i++; return layers[i]; };

  // derivative of (lat, lon, z, w) at a state
  const deriv = (la: number, lo: number, zz: number, _ww: number, tt: number, st: typeof stage): [number, number, number, number, number, number] => {
    const s = field.wind(la, lo, zz, tt);
    if (s.clipped) clipped = true;
    const R = R_EARTH_MEAN + zz;
    const dlat = (s.v / R) * R2D, dlon = (s.u / (R * Math.cos(la * D2R))) * R2D;
    if (st === "ascent") return [dlat, dlon, ascentRateAt(zz), 0, s.u, s.v];
    if (st === "float") return [dlat, dlon, 0, 0, s.u, s.v];
    const rho = atmos.state(zz).rho;
    return [dlat, dlon, -terminalVelocity(rho, c.descent), 0, s.u, s.v];
  };

  const w0 = field.wind(lat, lon, z, t);
  points.push({ t, lat, lon, z, w: 0, u: w0.u, v: w0.v, stage });
  let burst = { lat, lon, z: burstAlt, t: 0, diameterM: burstDia, byDiameter };
  let floatUntil = Infinity;
  let ascentEnd = 0, descentStart = 0;
  let landing: FlightResult["landing"] | null = null;

  while (t - c.launchTimeS < maxT) {
    // RK4 step
    const k1 = deriv(lat, lon, z, w, t, stage);
    const k2 = deriv(lat + 0.5 * dt * k1[0], lon + 0.5 * dt * k1[1], z + 0.5 * dt * k1[2], w + 0.5 * dt * k1[3], t + 0.5 * dt, stage);
    const k3 = deriv(lat + 0.5 * dt * k2[0], lon + 0.5 * dt * k2[1], z + 0.5 * dt * k2[2], w + 0.5 * dt * k2[3], t + 0.5 * dt, stage);
    const k4 = deriv(lat + dt * k3[0], lon + dt * k3[1], z + dt * k3[2], w + dt * k3[3], t + dt, stage);
    const nlat = lat + (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    const nlon = lon + (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    const nz = z + (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
    const uMean = (k1[4] + 2 * k2[4] + 2 * k3[4] + k4[4]) / 6, vMean = (k1[5] + 2 * k2[5] + 2 * k3[5] + k4[5]) / 6;

    // layer bookkeeping (east/north displacement over this step)
    const [de, dn] = eastNorthM(lat, lon, nlat, nlon);
    const L = layerOf(0.5 * (z + nz));
    if (stage === "descent") { L.descentEast += de; L.descentNorth += dn; L.descentTimeS += dt; }
    else { L.ascentEast += de; L.ascentNorth += dn; L.ascentTimeS += dt; }

    // stage transitions
    if (stage === "ascent" && nz >= burstAlt) {
      // fraction of the step to the burst altitude (linear)
      const f = (burstAlt - z) / (nz - z);
      lat = lat + f * (nlat - lat); lon = lon + f * (nlon - lon); z = burstAlt; t = t + f * dt; w = 0;
      burst = { lat, lon, z, t: t - c.launchTimeS, diameterM: burstDia, byDiameter };
      ascentEnd = t;
      if (c.floatDurationS && c.floatDurationS > 0) { stage = "float"; floatUntil = t + c.floatDurationS; }
      else { stage = "descent"; descentStart = t; }
      points.push({ t, lat, lon, z, w, u: uMean, v: vMean, stage });
      continue;
    }
    if (stage === "float" && t + dt >= floatUntil) {
      stage = "descent"; descentStart = t + dt;
    }
    const g = stage === "descent" ? ground(nlat, nlon) : -Infinity;
    if (stage === "descent" && nz <= g) {
      // bisect the landing within the step assuming linear motion
      const f = Math.max(0, Math.min(1, (z - g) / (z - nz)));
      lat = lat + f * (nlat - lat); lon = lon + f * (nlon - lon); t = t + f * dt; w = (nz - z) / dt; z = g;
      landing = { lat, lon, z, t: t - c.launchTimeS, groundAlt: g, impactMs: terminalVelocity(atmos.state(g).rho, c.descent) };
      points.push({ t, lat, lon, z, w, u: uMean, v: vMean, stage });
      break;
    }
    w = (nz - z) / dt; // vertical speed over the step, for reporting
    lat = nlat; lon = nlon; z = nz; t += dt;
    if (stage === "descent") maxDesc = Math.max(maxDesc, -w);
    points.push({ t, lat, lon, z, w, u: uMean, v: vMean, stage });
    if (stage === "descent" && c.floatDurationS === undefined && descentStart === 0) descentStart = t;
  }
  if (!landing) {
    landing = { lat, lon, z, t: t - c.launchTimeS, groundAlt: ground(lat, lon), impactMs: -w };
  }
  const [eastM, northM] = eastNorthM(c.launchLat, c.launchLon, landing.lat, landing.lon);
  return {
    points, burst, landing,
    rangeM: distanceM(c.launchLat, c.launchLon, landing.lat, landing.lon),
    bearingDeg: bearingDeg(c.launchLat, c.launchLon, landing.lat, landing.lon),
    eastM, northM,
    durationS: landing.t, ascentS: ascentEnd - c.launchTimeS, descentS: landing.t - (descentStart - c.launchTimeS),
    maxDescentMs: maxDesc, layers, windClipped: clipped, ascentModel,
  };
}
