/**
 * How well does the archived GFS column at Jejuri (05 UTC) match the Pune radiosonde (00 UTC, 43 km away)
 * on the same day? Vector RMS difference and mean speed per altitude, October-November, 2022-2026.
 *   npx tsx scripts/verify_gfs_vs_igra.ts [station id] [months e.g. 10,11]
 */
import { readFileSync } from "node:fs";
const igra = JSON.parse(readFileSync("public/data/igra_profiles.json", "utf8"));
const gfs = JSON.parse(readFileSync("public/data/gfs_jejuri_profiles.json", "utf8"));
const station = process.argv[2] ?? "INM00043063";
const months = (process.argv[3] ?? "10,11").split(",").map(Number);
const byDate = new Map<string, any>(); for (const p of gfs.profiles) if (p.h === 5) byDate.set(p.d, p);
const pairs = igra.profiles.filter((p: any) => p.s === station && p.h === 0 && months.includes(+p.d.slice(5, 7)) && byDate.has(p.d)).map((p: any) => [p, byDate.get(p.d)]);
console.log(`${igra.stations[station].name} 00Z vs GFS Jejuri 05Z, months ${months.join("/")}: ${pairs.length} paired days (${pairs[0]?.[0].d} .. ${pairs[pairs.length - 1]?.[0].d})`);
console.log("alt km   n   RMS vec diff   mean bias   mean sonde speed   diff/speed");
for (const z of [1000, 2000, 3000, 5000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000, 26000, 28000, 30000]) {
  const i = z / 250; let se = 0, n = 0, bu = 0, bv = 0, ms = 0;
  for (const [a, b] of pairs) { const x = a.uv[i], y = b.uv[i]; if (!x || !y) continue; const du = (y[0] - x[0]) / 10, dv = (y[1] - x[1]) / 10; se += du * du + dv * dv; bu += du; bv += dv; ms += Math.hypot(x[0], x[1]) / 10; n++; }
  if (n) console.log(`${(z / 1000).toString().padStart(5)}  ${String(n).padStart(3)}   ${Math.sqrt(se / n).toFixed(1).padStart(8)} m/s   ${Math.hypot(bu / n, bv / n).toFixed(1).padStart(6)} m/s   ${(ms / n).toFixed(1).padStart(8)} m/s   ${(Math.sqrt(se / n) / (ms / n) * 100).toFixed(0).padStart(6)}%`);
}
