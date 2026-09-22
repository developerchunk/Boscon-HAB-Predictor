/**
 * Fetch the Open-Meteo GFS archive (historical forecast, 23 levels, every hour) at one point, one
 * request per calendar month, and write a bundled archive the app installs into a visitor's browser
 * without touching the Open-Meteo quota:
 *
 *   npx tsx scripts/fetch_archive.ts --lat 17.721666 --lon 75.84237 --name "Solapur pad" \
 *       --from 2021-04 --to 2026-09 --out public/data/archives/solapur.habarchive.json.gz
 *
 * Each month is cached in .cache/archive/<loc>/<ym>.json as it arrives, so a stopped run resumes.
 * The month payload is exactly what src/data/openmeteo.ts fetchArchiveMonth returns ({time, vars}),
 * and the bundle is {format: "boscon-hab-archive", version: 1, loc, lat, lon, name, fetchedAt,
 * months: {"YYYY-MM": {time, vars}}} gzipped. A per-minute 429 is waited out; an hourly one stops
 * the run (rerun next hour, cached months are skipped).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Must equal MODEL_LEVELS.gfs_seamless in src/data/openmeteo.ts (checked by src/data/__tests__/archive.test.ts).
const GFS_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 40, 30, 20, 15, 10];
const ARCHIVE_FIRST_YM = "2021-04";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const lat = +args.get("lat")!, lon = +args.get("lon")!, name = args.get("name") ?? `${lat}, ${lon}`;
const from = args.get("from") ?? ARCHIVE_FIRST_YM, to = args.get("to") ?? new Date().toISOString().slice(0, 7), out = args.get("out")!;
if (!Number.isFinite(lat) || !Number.isFinite(lon) || !out) { console.error("usage: --lat --lon [--name] [--from YYYY-MM] [--to YYYY-MM] --out file.habarchive.json.gz"); process.exit(2); }
const loc = `${lat.toFixed(2)},${lon.toFixed(2)}`;
const cacheDir = `.cache/archive/${loc}`; mkdirSync(cacheDir, { recursive: true });

const months: string[] = [];
{ const now = new Date().toISOString().slice(0, 7); let [y, m] = (from < ARCHIVE_FIRST_YM ? ARCHIVE_FIRST_YM : from).split("-").map(Number); const hi = to > now ? now : to; for (; ;) { const ym = `${y}-${String(m).padStart(2, "0")}`; if (ym > hi) break; months.push(ym); m++; if (m > 12) { m = 1; y++; } } }
const vars: string[] = []; for (const p of GFS_LEVELS) vars.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`, `temperature_${p}hPa`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchMonth(ym: string): Promise<{ time: string[]; vars: Record<string, (number | null)[]> }> {
  const [y, mo] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${ym}-01&end_date=${ym}-${last}&hourly=${vars.join(",")}&models=gfs_seamless&wind_speed_unit=ms&timezone=UTC`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.status === 429) {
      let reason = "rate limit"; try { reason = (await r.json()).reason ?? reason; } catch { /* ignore */ }
      if (/minute/i.test(reason) && attempt < 5) { console.log(`  429 (${reason}) — waiting 65 s`); await sleep(65000); continue; }
      throw new Error(`Open-Meteo 429: ${reason}`);
    }
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d: any = await r.json(); const h = d.hourly ?? {}; const v: Record<string, (number | null)[]> = {};
    for (const k of vars) if (h[k]) v[k] = h[k];
    return { time: h.time ?? [], vars: v };
  }
}

(async () => {
  const t0 = Date.now(); let fetched = 0, bytes = 0;
  console.log(`${name} (${loc}): ${months.length} months ${months[0]} .. ${months[months.length - 1]}`);
  for (const [i, ym] of months.entries()) {
    const f = `${cacheDir}/${ym}.json`;
    if (existsSync(f)) { console.log(`${i + 1}/${months.length} ${ym}: cached (${(statSync(f).size / 1024).toFixed(0)} kB)`); continue; }
    const t1 = Date.now();
    const m = await fetchMonth(ym);
    const text = JSON.stringify(m); writeFileSync(f, text); fetched++; bytes += text.length;
    console.log(`${i + 1}/${months.length} ${ym}: ${m.time.length} h, ${(text.length / 1024).toFixed(0)} kB in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  }
  const all: Record<string, unknown> = {}; for (const ym of months) all[ym] = JSON.parse(readFileSync(`${cacheDir}/${ym}.json`, "utf8"));
  const bundle = { format: "boscon-hab-archive", version: 1, loc, lat, lon, name, fetchedAt: new Date().toISOString(), source: "Open-Meteo historical forecast API, models=gfs_seamless, hourly, 23 pressure levels 1000..10 hPa", months: all };
  const text = JSON.stringify(bundle); const gz = gzipSync(text, { level: 9 });
  writeFileSync(out, gz);
  console.log(`fetched ${fetched} months (${(bytes / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s; bundle ${(text.length / 1048576).toFixed(1)} MB raw -> ${(gz.length / 1048576).toFixed(2)} MB gzip at ${out}`);
})().catch(e => { console.error("stopped:", e.message ?? e); process.exit(1); });
