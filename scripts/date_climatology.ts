/**
 * Climatological prediction for a calendar date: fly the vehicle on every archived atmosphere
 * within +-N days of that date (all years), from the Pune/Mumbai radiosondes (ISA density column)
 * and from the GFS archive column at the pad (its own density column, 05/06 UTC = launch hour).
 *
 *   npx tsx scripts/date_climatology.ts 10-24 [window days, default 10]
 */
import { readFileSync } from "node:fs";
import { planFill, buildFlightConfig } from "../src/physics/predictor";
import { flyTrajectory } from "../src/physics/trajectory";
import { ProfileWindField } from "../src/physics/wind";
import { Column, isa } from "../src/physics/atmosphere";
import { DEFAULT_INPUTS } from "../src/physics/defaults";

const [md, winArg] = process.argv.slice(2);
const [MM, DD] = md.split("-").map(Number);
const WIN = winArg ? +winArg : 10;
const igra = JSON.parse(readFileSync("public/data/igra_profiles.json", "utf8"));
const gfs = JSON.parse(readFileSync("public/data/gfs_jejuri_profiles.json", "utf8"));

const inp = { ...DEFAULT_INPUTS, launchUtc: new Date(Date.UTC(2026, MM - 1, DD, 5, 30)) };
const plan = planFill(inp, { state: isa });
const cfg = buildFlightConfig(inp, plan, 0, () => inp.launchAltM);
console.log(`Vehicle: ${inp.balloonId}, ${inp.payloadKg} kg, ${inp.gas}, ${plan.padAscentMs.toFixed(2)} m/s at pad -> neck lift ${(plan.neckLiftKg * 1000).toFixed(0)} g, burst ${plan.burstAltM.toFixed(0)} m (ISA) after ${plan.burstTimeMin.toFixed(0)} min, chute ${inp.chuteDiameterM} m Cd ${inp.chuteCd}`);

const dayOfYear = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(y, 0, 1)) / 864e5); };
const target = dayOfYear(`2026-${String(MM).padStart(2, "0")}-${String(DD).padStart(2, "0")}`);
const inWindow = (d: string) => Math.abs(dayOfYear(d.replace(/^\d{4}/, "2026")) - target) <= WIN;
const compass = (b: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.floor(((b + 22.5) % 360) / 45)];

function fly(p: any, step: number, useCol: boolean) {
  const z = p.uv.map((_: any, i: number) => i * step), u = p.uv.map((x: number[]) => x[0] / 10), v = p.uv.map((x: number[]) => x[1] / 10);
  const col = useCol && p.col ? new Column(p.col.map((c: number[]) => ({ z: c[0], T: c[1] / 10, p: c[2] }))) : undefined;
  const f = new ProfileWindField(z, u, v, p.d, col);
  return flyTrajectory(f, { ...cfg, dtS: 10 });
}
function summarise(name: string, rows: { d: string; h: number; r: ReturnType<typeof flyTrajectory> }[]) {
  if (!rows.length) { console.log(`\n${name}: no profiles`); return; }
  const rng = rows.map(x => x.r.rangeM / 1000).sort((a, b) => a - b);
  const q = (f: number) => rng[Math.min(rng.length - 1, Math.floor(f * (rng.length - 1)))];
  const rose: Record<string, number> = {}; for (const x of rows) rose[compass(x.r.bearingDeg)] = (rose[compass(x.r.bearingDeg)] ?? 0) + 1;
  const years = [...new Set(rows.map(x => x.d.slice(0, 4)))];
  console.log(`\n${name}: ${rows.length} atmospheres, years ${years[0]}..${years[years.length - 1]}`);
  console.log(`  range km: median ${q(0.5).toFixed(1)}  p75 ${q(0.75).toFixed(1)}  p90 ${q(0.9).toFixed(1)}  p95 ${q(0.95).toFixed(1)}  max ${rng[rng.length - 1].toFixed(1)}`);
  console.log(`  bearing:  ${Object.entries(rose).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${(100 * n / rows.length).toFixed(0)}%`).join(", ")}`);
  console.log(`  duration: median ${(rows.map(x => x.r.durationS).sort((a, b) => a - b)[Math.floor(rows.length / 2)] / 60).toFixed(0)} min; profiles topped out below burst: ${rows.filter(x => x.r.windClipped).length}`);
}

// --- GFS archive: exact date each year, launch hour
console.log(`\nGFS archive column at the pad, ${md} at 05 and 06 UTC, each year:`);
for (const p of gfs.profiles.filter((p: any) => p.d.slice(5) === md)) {
  const r = fly(p, gfs.meta.grid_step_m, true);
  console.log(`  ${p.d} ${String(p.h).padStart(2, "0")}Z  ${(r.rangeM / 1000).toFixed(1).padStart(6)} km  ${r.bearingDeg.toFixed(0).padStart(3)}° ${compass(r.bearingDeg).padEnd(2)}  landing ${r.landing.lat.toFixed(3)}, ${r.landing.lon.toFixed(3)}  burst ${(r.burst.z / 1000).toFixed(1)} km  ${(r.durationS / 60).toFixed(0)} min${r.windClipped ? "  (top wind held)" : ""}`);
}
summarise(`GFS archive, ${md} ±${WIN} days, 05/06 UTC`, gfs.profiles.filter((p: any) => inWindow(p.d)).map((p: any) => ({ d: p.d, h: p.h, r: fly(p, gfs.meta.grid_step_m, true) })));
for (const st of ["INM00043063", "INM00043003"]) {
  summarise(`${igra.stations[st].name} radiosonde, ${md} ±${WIN} days, 00Z+12Z`, igra.profiles.filter((p: any) => p.s === st && inWindow(p.d)).map((p: any) => ({ d: p.d, h: p.h, r: fly(p, igra.meta.grid_step_m, false) })));
}
