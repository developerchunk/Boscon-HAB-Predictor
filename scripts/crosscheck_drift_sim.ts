/**
 * Cross-implementation check: fly the same measured Pune radiosonde with
 *   (a) tools/drift_sim.py  (Python, midpoint stepping in 50 m altitude steps, its own ISA)
 *   (b) this predictor        (TypeScript, RK4 in time, USSA76 with geopotential conversion)
 * using the SAME vehicle model (constant-Cd ascent = 5 m/s at sea level scaled rho^(-1/6),
 * burst 31300 m, 2.2 kg under a 1.2 m chute with Cd 1.5, launch 744.4 m, ground = launch).
 * The two should agree to ~1% in range; a larger gap means one of them is wrong.
 *
 *   npx tsx scripts/crosscheck_drift_sim.ts <IGRA data file> <YYYY-MM> [n soundings, default 3]
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { ProfileWindField } from "../src/physics/wind";
import { flyTrajectory } from "../src/physics/trajectory";
import { isa } from "../src/physics/atmosphere";

const [file, ym, nArg] = process.argv.slice(2);
const [Y, M] = ym.split("-").map(Number);
const N = nArg ? +nArg : 3;
const lines = readFileSync(file, "utf8").split("\n");

// list deep soundings (>= 30 km, >= 20 wind levels) in the month, same criterion as drift_sim.read_igra
type Snd = { D: number; H: string; lv: [number, number, number][] };
const snds: Snd[] = [];
let cur: Snd | null = null;
const flush = () => { if (cur) { cur.lv.sort((a, b) => a[0] - b[0]); const ded = cur.lv.filter((l, i) => i === 0 || l[0] - cur!.lv[i - 1][0] >= 1); if (ded.length >= 20 && ded[ded.length - 1][0] >= 30000) snds.push({ ...cur, lv: ded }); } };
for (const ln of lines) {
  if (ln.startsWith("#")) {
    flush(); cur = null;
    if (+ln.slice(13, 17) === Y && +ln.slice(18, 20) === M) cur = { D: +ln.slice(21, 23), H: ln.slice(24, 26).trim(), lv: [] };
    continue;
  }
  if (!cur) continue;
  const gph = +ln.slice(16, 21), wd = +ln.slice(40, 45), ws = +ln.slice(46, 51);
  if (!Number.isFinite(gph) || gph <= -8000 || wd < 0 || wd > 360 || ws < 0) continue;
  const spd = ws / 10, r = (wd * Math.PI) / 180;
  cur.lv.push([gph, -spd * Math.sin(r), -spd * Math.cos(r)]);
}
flush();
console.log(`${ym}: ${snds.length} deep soundings; checking first ${N}`);

// --- TS flight with the drift_sim vehicle: ascent 5 m/s * (rho0/rho)^(1/6); we emulate with the
// constant-Cd physical model anchored to give 5.0 m/s at sea level (which is exactly rho^(-1/6) scaling).
import { neckLiftForAscentRate } from "../src/physics/balloon";
const asc = { balloonMassKg: 1.2, payloadKg: 2.2, gas: "hydrogen" as const, burstDiameterM: 99, cdModel: "constant" as const, cdConstant: 0.25, launchAltM: 0, atmosphere: { state: isa } };
const nl = neckLiftForAscentRate(asc, 5.0);
let worst = 0;
for (const s of snds.slice(0, N)) {
  // take the profile exactly as drift_sim.py parses it (it also uses ISA-converted pressure-only levels)
  const pyProf = `
import sys, json; sys.path.insert(0, 'tools'); sys.argv=['x']
import drift_sim as ds
snd = ds.read_igra('${file}', {${M}}, 30000, 20, ${Y})
prof = [s[4] for s in snd if (s[0], s[1], s[2], s[3]) == (${Y}, ${M}, ${s.D}, '${s.H}')][0]
print(json.dumps(prof))
`;
  const prof: [number, number, number][] = JSON.parse(execSync(`python3 -c "${pyProf.replace(/"/g, '\\"')}"`, { cwd: "..", encoding: "utf8" }));
  const field = new ProfileWindField(prof.map(l => l[0]), prof.map(l => l[1]), prof.map(l => l[2]), "igra");
  const r = flyTrajectory(field, {
    launchLat: 18.286293, launchLon: 74.123039, launchAltM: 744.4, launchTimeS: 0,
    ascent: { ...asc, neckLiftKg: nl }, burstAltOverrideM: 31300,
    descent: { massKg: 2.2, chuteDiameterM: 1.2, cd: 1.5 }, dtS: 5,
  });
  const py = `
import sys; sys.path.insert(0, 'tools'); sys.argv=['x']
import drift_sim as ds
snd = ds.read_igra('${file}', {${M}}, 30000, 20, ${Y})
prof = [s[4] for s in snd if (s[0], s[1], s[2], s[3]) == (${Y}, ${M}, ${s.D}, '${s.H}')][0]
r = ds.fly(prof, 31300.0)
print(f"{r['range_km']:.3f} {r['bearing_deg']:.2f} {r['east_km']:.3f} {r['north_km']:.3f} {r['flight_min']:.2f} {r['apogee_min']:.2f}")
`;
  const out = execSync(`python3 -c "${py.replace(/"/g, '\\"')}"`, { cwd: "..", encoding: "utf8" }).trim().split(" ").map(Number);
  const dRange = Math.abs(r.rangeM / 1000 - out[0]) / out[0] * 100;
  worst = Math.max(worst, dRange);
  console.log(`${ym}-${String(s.D).padStart(2, "0")} ${s.H}Z  top ${s.lv[s.lv.length - 1][0]} m  (TS parse ${s.lv.length} levels, PY parse ${prof.length} levels)`);
  console.log(`   TS : range ${(r.rangeM / 1000).toFixed(2)} km, bearing ${r.bearingDeg.toFixed(1)}, flight ${(r.durationS / 60).toFixed(1)} min, ascent ${(r.ascentS / 60).toFixed(1)} min`);
  console.log(`   PY : range ${out[0].toFixed(2)} km, bearing ${out[1].toFixed(1)}, flight ${out[4].toFixed(1)} min, ascent ${out[5].toFixed(1)} min   -> range differs by ${dRange.toFixed(2)}%`);
}
console.log(`worst range difference ${worst.toFixed(2)}% (tolerance 1.5%) -> ${worst < 1.5 ? "PASS" : "FAIL"}`);
process.exit(worst < 1.5 ? 0 : 1);
