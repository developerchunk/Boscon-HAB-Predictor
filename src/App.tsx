import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapView, type MapData } from "./ui/MapView";
import { BurstCalcPanel } from "./ui/BurstCalcPanel";
import { ClimatologyPanel } from "./ui/ClimatologyPanel";
import { MethodPanel } from "./ui/MethodPanel";
import { Flight3D } from "./ui/Flight3D";
import { LineChart, PlanView, LayerBars } from "./ui/charts";
import { km, nm, ft, fl, hhmm, deg, compass, istString, utcString, istToDate, dateToIstParts } from "./ui/format";
import { BALLOONS, balloonById } from "./physics/balloon";
import { planFill, buildFlightConfig, flyWithTerrain, type PredictInputs } from "./physics/predictor";
import { flyTrajectory, type FlightResult } from "./physics/trajectory";
import { ellipsePolygon, type McResult } from "./physics/montecarlo";
import { eastNorthM, distanceM, bearingDeg, dirSpeedFromUV } from "./physics/geo";
import { isa } from "./physics/atmosphere";
import { fetchGridField, fetchEnsemblePerturbations, fetchElevations, fetchWeatherColumn, fetchSurfaceWeather, weatherCodeText, geocode, apiStats, OM_HOSTS, MODEL_LABEL, type ModelId, type GridFetchResult, type GeocodeHit, type WeatherColumn, type SurfaceWx } from "./data/openmeteo";
import { fetchTawhiri, type TawhiriResult } from "./data/tawhiri";
import { bridgeOnline, NOMADS_BRIDGE } from "./data/nomads";
import { callWorker } from "./ui/worker-client";

type Tab = "predict" | "flight3d" | "burst" | "climatology" | "method";

import { DEFAULT_INPUTS } from "./physics/defaults";
type GridDensity = "dense" | "standard" | "light";
/**
 * Columns fetched around the pad (Open-Meteo models only; the NOMADS bridge always returns every
 * native grid point). Policy: data and accuracy are never traded for API quota — the default is
 * the model's own 0.25° spacing, and caching (30 min) is what keeps repeat runs free.
 */
const GRID_PRESETS: Record<GridDensity, { step: number; half: number; label: string }> = {
  dense: { step: 0.25, half: 1.0, label: "full — 9×9 columns at 0.25° (±110 km, the model's native spacing)" },
  standard: { step: 0.5, half: 1.0, label: "5×5 columns at 0.5° (±110 km, Tawhiri's resolution)" },
  light: { step: 0.75, half: 0.75, label: "3×3 columns at 0.75° (±80 km) — only if the API is throttling" },
};
interface Settings { model: ModelId; mcRuns: number; useEnsemble: boolean; compareTawhiri: boolean; windSigmaMs: number; burstMeanRatio: number; fillSigma: number; chuteCdSpread: number; remnant: boolean; hourSweep: boolean; grid: GridDensity }
const DEFAULT_SETTINGS: Settings = { model: "gfs_seamless", mcRuns: 300, useEnsemble: true, compareTawhiri: true, windSigmaMs: 2.5, burstMeanRatio: 1.0, fillSigma: 0.05, chuteCdSpread: 0.2, remnant: true, hourSweep: true, grid: "dense" };

interface Results {
  grid: GridFetchResult; plan: ReturnType<typeof planFill>; nominal: FlightResult; groundAltM: number; demIterations: number;
  mc?: McResult; ensembleN: number; tawhiri?: TawhiriResult; tawhiriError?: string;
  hourly?: { offsetH: number; lat: number; lon: number; rangeM: number; bearing: number; durationS: number }[];
  computedAt: Date;
  demError?: string;
  weather?: WeatherColumn;
  landingWx?: SurfaceWx[];
  weatherError?: string;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("predict");
  const [inp, setInp] = useState<PredictInputs>(DEFAULT_INPUTS);
  const [set, setSet] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState("");
  const abort = useRef<AbortController | null>(null);
  const [bridge, setBridge] = useState<boolean | null>(null);
  useEffect(() => { bridgeOnline().then(ok => { setBridge(ok); if (ok) setSet(s => (s.model === DEFAULT_SETTINGS.model ? { ...s, model: "nomads_gfs025" } : s)); }); }, []);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeHits, setPlaceHits] = useState<GeocodeHit[] | null>(null);
  const [placeBusy, setPlaceBusy] = useState(false);
  const ist = dateToIstParts(inp.launchUtc);
  async function searchPlace() {
    if (!placeQuery.trim()) return;
    setPlaceBusy(true);
    try { setPlaceHits(await geocode(placeQuery.trim())); } catch (e: any) { setError(String(e.message ?? e)); } finally { setPlaceBusy(false); }
  }
  function choosePlace(h: GeocodeHit) {
    setInp(s => ({ ...s, launchLat: +h.latitude.toFixed(6), launchLon: +h.longitude.toFixed(6), launchAltM: Number.isFinite(h.elevation) ? h.elevation : s.launchAltM }));
    setPlaceHits(null); setPlaceQuery(`${h.name}${h.admin1 ? ", " + h.admin1 : ""}`);
    lookupElevation(+h.latitude.toFixed(6), +h.longitude.toFixed(6));
  }
  const up = <K extends keyof PredictInputs>(k: K, v: PredictInputs[K]) => setInp(s => ({ ...s, [k]: v }));
  const upS = <K extends keyof Settings>(k: K, v: Settings[K]) => setSet(s => ({ ...s, [k]: v }));

  const lookupElevation = useCallback(async (lat: number, lon: number) => {
    try { const [e] = await fetchElevations([[lat, lon]]); if (Number.isFinite(e)) setInp(s => ({ ...s, launchLat: lat, launchLon: lon, launchAltM: e })); else setInp(s => ({ ...s, launchLat: lat, launchLon: lon })); }
    catch { setInp(s => ({ ...s, launchLat: lat, launchLon: lon })); }
  }, []);

  async function run() {
    abort.current?.abort(); const ac = new AbortController(); abort.current = ac;
    setBusy(true); setError(null); setRes(null);
    const log = (s: string) => setStatus(s);
    try {
      const leadH = (inp.launchUtc.getTime() - Date.now()) / 3600e3;
      if (leadH > 16 * 24) throw new Error(`Launch is ${(leadH / 24).toFixed(0)} days away; GFS only reaches 16 days. Use the Climatology tab for planning, and come back within 7 days for a forecast.`);
      if (leadH < -24 * 60) throw new Error("Launch time is more than 60 days in the past; the forecast archive is not wired in for that.");
      const req0 = apiStats.requests;
      const gp = GRID_PRESETS[set.grid]; const nCols = (Math.round((2 * gp.half) / gp.step) + 1) ** 2;
      if (set.model === "nomads_gfs025") log(`Fetching native GFS 0.25° from the local NOMADS bridge — every grid point within ±${gp.half}° (~${(Math.round(2 * gp.half / 0.25) + 1) ** 2} columns), ${set.hourSweep ? 15 : 10} hourly files, ~40 s the first time, instant from cache…`);
      else log(`Fetching ${MODEL_LABEL[set.model]} — ${nCols} columns at ${gp.step}°, ${set.hourSweep ? 15 : 10} hours, via the ${OM_HOSTS.mode} (cached 30 min)…`);
      const grid = await fetchGridField({ lat: inp.launchLat, lon: inp.launchLon, model: set.model, launch: inp.launchUtc, hoursBefore: set.hourSweep ? 4 : 1, hoursAfter: set.hourSweep ? 11 : 8, halfSpanDeg: gp.half, stepDeg: gp.step, signal: ac.signal });
      const launchTimeS = (inp.launchUtc.getTime() - grid.epochMs) / 1000;
      const atmos = grid.field.atmosphere(inp.launchLat, inp.launchLon, launchTimeS);
      const plan = planFill(inp, atmos);
      log("Flying nominal trajectory and looking up terrain at the landing point…");
      const cfg = buildFlightConfig(inp, plan, launchTimeS);
      const { result: nominal, groundAltM, iterations, demError } = await flyWithTerrain(grid.field, cfg, pts => fetchElevations(pts, ac.signal), 3);
      const partial: Results = { grid, plan, nominal, groundAltM, demIterations: iterations, ensembleN: 0, computedAt: new Date(), demError };
      setRes({ ...partial }); setFitKey(String(Date.now()));
      // humidity, cloud and rain: from the bridge's GRIB when that is the source, else one small Open-Meteo request each for the pad column and the landing zone
      try {
        if (grid.weather && grid.surfaceAt) { partial.weather = grid.weather; partial.landingWx = grid.surfaceAt(nominal.landing.lat, nominal.landing.lon); }
        else if (set.model !== "nomads_gfs025") {
          log("Fetching humidity, cloud and rain for the pad column and the landing zone (waits out a per-minute limit if needed)…");
          partial.weather = await fetchWeatherColumn({ lat: inp.launchLat, lon: inp.launchLon, model: set.model, launch: inp.launchUtc, hoursBefore: set.hourSweep ? 4 : 1, hoursAfter: set.hourSweep ? 11 : 8, signal: ac.signal });
          partial.landingWx = await fetchSurfaceWeather({ lat: nominal.landing.lat, lon: nominal.landing.lon, model: set.model, launch: inp.launchUtc, signal: ac.signal });
        }
      } catch (e: any) { partial.weatherError = String(e?.message ?? e); }
      setRes({ ...partial });
      // hour sweep
      if (set.hourSweep) {
        const hourly: Results["hourly"] = [];
        for (const off of [-3, -2, -1, 1, 2, 3]) {
          const t = launchTimeS + off * 3600; if (t < 0 || t > grid.field.timesS[grid.field.timesS.length - 1] - 3 * 3600) continue;
          try { const r = flyTrajectory(grid.field, { ...cfg, launchTimeS: t, groundAltAt: () => groundAltM }); hourly.push({ offsetH: off, lat: r.landing.lat, lon: r.landing.lon, rangeM: r.rangeM, bearing: r.bearingDeg, durationS: r.durationS }); } catch { /* outside data */ }
        }
        partial.hourly = hourly; setRes({ ...partial });
      }
      // Tawhiri reference (in parallel with the MC)
      const tawhiriP = set.compareTawhiri ? fetchTawhiri({ lat: inp.launchLat, lon: inp.launchLon, altM: inp.launchAltM, launch: inp.launchUtc, ascentMs: plan.meanAscentMs, burstAltM: plan.burstAltM, descentMs: plan.descentSeaLevelMs, signal: ac.signal })
        .then(t => { partial.tawhiri = t; setRes({ ...partial }); }).catch(e => { partial.tawhiriError = String(e.message ?? e); setRes({ ...partial }); }) : Promise.resolve();
      // ensemble
      let ensemble: { z: number[]; du: number[]; dv: number[] }[] | undefined;
      if (set.useEnsemble) {
        log("Fetching ECMWF ensemble (51 members) for wind uncertainty…");
        try { ensemble = await fetchEnsemblePerturbations(inp.launchLat, inp.launchLon, inp.launchUtc, ac.signal); partial.ensembleN = ensemble.length; } catch { partial.ensembleN = 0; }
      }
      log(`Monte Carlo: ${set.mcRuns} flights in a worker…`);
      const b = balloonById(inp.balloonId);
      const columns = (grid.field as any).cols.flat();
      const mcMsg = await callWorker<{ result: McResult }>({ type: "mc", timesS: grid.field.timesS, columns, label: grid.field.label, cfg: { ...cfg, groundAltAt: undefined }, groundAltM,
        mc: { runs: set.mcRuns, seed: 1, burstMeanRatio: set.burstMeanRatio, fillSigma: set.fillSigma, payloadSigma: 0.03, chuteCdSpread: set.chuteCdSpread, remnant: set.remnant, windSigmaMs: ensemble?.length ? 0 : set.windSigmaMs, ensemble, balloonMassKg: b.massG / 1000 } },
        i => log(`Monte Carlo: ${i}/${set.mcRuns}…`));
      partial.mc = mcMsg.result;
      setRes({ ...partial });
      await tawhiriP;
      log(`Done at ${istString(new Date())} — ${apiStats.requests - req0} Open-Meteo request${apiStats.requests - req0 === 1 ? "" : "s"} this run (${apiStats.cacheHits} cache hits so far).`);
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(String(e.message ?? e));
    } finally { setBusy(false); }
  }

  const mapData: MapData = useMemo(() => {
    const d: MapData = { launch: [inp.launchLat, inp.launchLon] };
    if (res) {
      d.track = res.nominal.points.filter((_, i) => i % 3 === 0 || i === res.nominal.points.length - 1).map(q => ({ lon: q.lon, lat: q.lat, stage: q.stage, alt: q.z }));
      d.burst = [res.nominal.burst.lat, res.nominal.burst.lon]; d.landing = [res.nominal.landing.lat, res.nominal.landing.lon];
      if (res.mc) { d.mc = res.mc.landings.map(l => [l.lat, l.lon]); d.ellipses = res.mc.ellipses.map(e => ellipsePolygon(e, inp.launchLat, inp.launchLon)); }
      if (res.tawhiri) d.tawhiri = { track: [...res.tawhiri.ascent, ...res.tawhiri.descent].map(q => [q.longitude > 180 ? q.longitude - 360 : q.longitude, q.latitude] as [number, number]), landing: [res.tawhiri.landing.longitude > 180 ? res.tawhiri.landing.longitude - 360 : res.tawhiri.landing.longitude, res.tawhiri.landing.latitude] };
      if (res.hourly) d.hourly = res.hourly.map(h => ({ lon: h.lon, lat: h.lat, label: `${h.offsetH > 0 ? "+" : ""}${h.offsetH} h` }));
    }
    return d;
  }, [res, inp.launchLat, inp.launchLon]);

  const tawhiriSep = res?.tawhiri ? distanceM(res.nominal.landing.lat, res.nominal.landing.lon, res.tawhiri.landing.latitude, res.tawhiri.landing.longitude > 180 ? res.tawhiri.landing.longitude - 360 : res.tawhiri.landing.longitude) : null;

  return <div className="app">
    <div className="topbar">
      <h1>BOSCON HAB predictor</h1><span className="note">landing prediction · burst calculator · Pune wind climatology</span>
      <div className="tabs">{(["predict", "flight3d", "burst", "climatology", "method"] as Tab[]).map(t => <button key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>{{ predict: "Predict", flight3d: "3-D flight", burst: "Burst calculator", climatology: "Climatology", method: "Method & sources" }[t]}</button>)}</div>
    </div>
    {tab === "flight3d" && <Flight3D data={res ? { nominal: res.nominal, mc: res.mc, tawhiri: res.tawhiri, grid: res.grid, weather: res.weather } : null} launchLat={inp.launchLat} launchLon={inp.launchLon} launchAltM={inp.launchAltM} />}
    {tab === "burst" && <BurstCalcPanel siteAltM={inp.launchAltM} />}
    {tab === "method" && <MethodPanel />}
    {tab === "climatology" && <ClimatologyPanel inputs={inp} />}
    {tab === "predict" && <div className="main">
      <div className="sidebar">
        <h2>Launch</h2>
        <div className="field"><label>Place <span className="unit">any town in India, or anywhere</span></label><div className="row"><input value={placeQuery} placeholder="e.g. Nashik" onChange={e => setPlaceQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") searchPlace(); }} /><button className="secondary" disabled={placeBusy} onClick={searchPlace}>{placeBusy ? "…" : "Find"}</button></div></div>
        {placeHits && <div className="card" style={{ padding: "6px 8px", margin: "4px 0" }}>{placeHits.length === 0 ? <span className="note">no match</span> : placeHits.map((h, i) => <div key={i}><button className="tab small" style={{ textAlign: "left" }} onClick={() => choosePlace(h)}>{h.name}{h.admin1 ? `, ${h.admin1}` : ""} ({h.country_code}) — {h.latitude.toFixed(4)}, {h.longitude.toFixed(4)}, {Number.isFinite(h.elevation) ? `${Math.round(h.elevation)} m` : "elev ?"}</button></div>)}</div>}
        <div className="field"><label>Latitude</label><input type="number" step="0.000001" value={inp.launchLat} onChange={e => up("launchLat", +e.target.value)} /></div>
        <div className="field"><label>Longitude</label><input type="number" step="0.000001" value={inp.launchLon} onChange={e => up("launchLon", +e.target.value)} /></div>
        <div className="field"><label>Pad elevation <span className="unit">m AMSL</span></label><div className="row"><input type="number" step="0.1" value={inp.launchAltM} onChange={e => up("launchAltM", +e.target.value)} /><button className="secondary" title="Copernicus DEM GLO-90 via Open-Meteo" onClick={() => lookupElevation(inp.launchLat, inp.launchLon)}>DEM</button></div></div>
        <div className="field"><label>Date <span className="unit">IST</span></label><input type="date" value={ist.date} onChange={e => up("launchUtc", istToDate(e.target.value, ist.time))} /></div>
        <div className="field"><label>Time <span className="unit">IST</span></label><input type="time" value={ist.time} onChange={e => up("launchUtc", istToDate(ist.date, e.target.value))} /></div>
        <p className="note">{utcString(inp.launchUtc)} · lead {((inp.launchUtc.getTime() - Date.now()) / 3600e3).toFixed(0)} h. Move the pad by searching a place, typing coordinates, dragging the marker, or "Pick pad on map"; the elevation is re-read from the DEM each time. The forecast, terrain and Tawhiri comparison work for any point on Earth; the bundled climatology is for the Pune region, and the Climatology tab can fetch the GFS archive for the current pad.</p>
        <h2>Balloon &amp; fill</h2>
        <div className="field"><label>Balloon</label><select value={inp.balloonId} onChange={e => up("balloonId", e.target.value)}>{BALLOONS.map(b => <option key={b.id} value={b.id}>{b.maker} {b.massG} g — {b.burstDiameterM} m</option>)}</select></div>
        <div className="field"><label>Gas</label><select value={inp.gas} onChange={e => up("gas", e.target.value as any)}><option value="hydrogen">Hydrogen</option><option value="helium">Helium</option></select></div>
        <div className="field"><label>Mass under balloon <span className="unit">kg</span></label><input type="number" step="0.05" value={inp.payloadKg} onChange={e => up("payloadKg", +e.target.value)} /></div>
        <div className="field"><label>Fill by</label><select value={inp.fillMode} onChange={e => up("fillMode", e.target.value as any)}><option value="ascentRate">target ascent rate</option><option value="neckLift">measured neck lift</option><option value="burstAlt">target burst altitude</option></select></div>
        {inp.fillMode === "ascentRate" && <div className="field"><label>Ascent rate at pad <span className="unit">m/s</span></label><input type="number" step="0.1" value={inp.targetAscentMs} onChange={e => up("targetAscentMs", +e.target.value)} /></div>}
        {inp.fillMode === "neckLift" && <div className="field"><label>Neck lift <span className="unit">kg</span></label><input type="number" step="0.05" value={inp.neckLiftKg} onChange={e => up("neckLiftKg", +e.target.value)} /></div>}
        {inp.fillMode === "burstAlt" && <div className="field"><label>Burst altitude <span className="unit">m</span></label><input type="number" step="100" value={inp.targetBurstAltM} onChange={e => up("targetBurstAltM", +e.target.value)} /></div>}
        <div className="field"><label>Ascent-rate model</label><select value={inp.ascentModel} onChange={e => up("ascentModel", e.target.value as any)}><option value="gallice">Gallice 2011 Cd(Re) — near-constant rate</option><option value="constant">constant Cd — rate ∝ ρ^-1/6</option><option value="astra">ASTRA Cd(Re)</option><option value="constantRate">constant rate (Tawhiri style)</option></select></div>
        <div className="field"><label>Burst diameter ×</label><input type="number" step="0.01" value={inp.burstDiameterFactor} onChange={e => up("burstDiameterFactor", +e.target.value)} /></div>
        <h2>Descent</h2>
        <div className="field"><label>Specify</label><select value={inp.descentMode} onChange={e => up("descentMode", e.target.value as any)}><option value="chute">parachute geometry</option><option value="seaLevelRate">sea-level descent rate</option></select></div>
        {inp.descentMode === "chute" ? <>
          <div className="field"><label>Canopy diameter <span className="unit">m, constructed</span></label><input type="number" step="0.05" value={inp.chuteDiameterM} onChange={e => up("chuteDiameterM", +e.target.value)} /></div>
          <div className="field"><label>Cd on constructed area</label><input type="number" step="0.05" value={inp.chuteCd} onChange={e => up("chuteCd", +e.target.value)} /></div>
        </> : <div className="field"><label>Sea-level descent rate <span className="unit">m/s</span></label><input type="number" step="0.1" value={inp.seaLevelDescentMs} onChange={e => up("seaLevelDescentMs", +e.target.value)} /></div>}
        <div className="field"><label>Balloon remnant carried down <span className="unit">kg</span></label><input type="number" step="0.05" value={inp.remnantKg} onChange={e => up("remnantKg", +e.target.value)} /></div>
        <h2>Wind &amp; uncertainty</h2>
        <div className="field"><label>Forecast model</label><select value={set.model} onChange={e => upS("model", e.target.value as ModelId)}>{(Object.keys(MODEL_LABEL) as ModelId[]).map(m => <option key={m} value={m} disabled={m === "nomads_gfs025" && bridge === false}>{MODEL_LABEL[m]}{m === "nomads_gfs025" ? (bridge === false ? " — bridge offline" : bridge ? " — online" : "") : ""}</option>)}</select></div>
        {bridge === false && <p className="note">Native-GFS bridge not detected at {NOMADS_BRIDGE}. Start it with <code>npm run bridge</code> to use NOAA's data directly with no API quota (README §3.3b).</p>}
        <div className="field"><label>Wind grid density</label><select value={set.grid} onChange={e => upS("grid", e.target.value as GridDensity)}>{(Object.keys(GRID_PRESETS) as GridDensity[]).map(k => <option key={k} value={k}>{GRID_PRESETS[k].label}</option>)}</select></div>
        <p className="note">Data source: {OM_HOSTS.mode}. The default is the model's full native spacing; results are cached for 30 min so repeat runs cost nothing. Use the local NOMADS bridge for every native point, all 41 levels and no quota at all.</p>
        <div className="field"><label>ECMWF ensemble for wind spread</label><input type="checkbox" checked={set.useEnsemble} onChange={e => upS("useEnsemble", e.target.checked)} /></div>
        <div className="field"><label>Fallback wind σ <span className="unit">m/s (assumed)</span></label><input type="number" step="0.5" value={set.windSigmaMs} onChange={e => upS("windSigmaMs", +e.target.value)} /></div>
        <div className="field"><label>Monte Carlo runs</label><input type="number" step="50" value={set.mcRuns} onChange={e => upS("mcRuns", +e.target.value)} /></div>
        <div className="field"><label>Fill σ <span className="unit">fraction</span></label><input type="number" step="0.01" value={set.fillSigma} onChange={e => upS("fillSigma", +e.target.value)} /></div>
        <div className="field"><label>Chute Cd spread <span className="unit">± fraction</span></label><input type="number" step="0.05" value={set.chuteCdSpread} onChange={e => upS("chuteCdSpread", +e.target.value)} /></div>
        <div className="field"><label>Burst mean / nominal</label><input type="number" step="0.01" value={set.burstMeanRatio} onChange={e => upS("burstMeanRatio", +e.target.value)} /></div>
        <div className="field"><label>Compare with SondeHub/Tawhiri</label><input type="checkbox" checked={set.compareTawhiri} onChange={e => upS("compareTawhiri", e.target.checked)} /></div>
        <div className="field"><label>Launch-time sweep ±3 h</label><input type="checkbox" checked={set.hourSweep} onChange={e => upS("hourSweep", e.target.checked)} /></div>
        <div className="row" style={{ margin: "12px 0" }}><button className="primary" disabled={busy} onClick={run}>{busy ? "Running…" : "Predict"}</button><span className="status">{status}</span></div>
        {error && <div className="bad">{error}</div>}
        {res && <Summary r={res} inp={inp} tawhiriSep={tawhiriSep} />}
      </div>
      <div className="content">
        <MapView data={mapData} onLaunchMove={lookupElevation} fitKey={fitKey} />
        <div className="charts">
          {res && <ResultCharts r={res} inp={inp} />}
          {!res && <div className="card"><h3>How to read this tool</h3><p className="note">Set the launch, the balloon and the parachute, then Predict. The blue/orange line is this predictor's nominal track on the chosen forecast; purple dots and ellipses are the Monte Carlo landing spread (burst diameter, fill, chute Cd, balloon remnant, and ECMWF ensemble winds); the grey dashed line is the SondeHub/Tawhiri prediction with the same burst altitude, mean ascent rate and sea-level descent rate. Every number in the sidebar states its source in the Method tab.</p></div>}
        </div>
      </div>
    </div>}
  </div>;
}

function Summary({ r, inp, tawhiriSep }: { r: Results; inp: PredictInputs; tawhiriSep: number | null }) {
  const n = r.nominal, p = r.plan;
  return <div>
    {p.warnings.map((w, i) => <div key={i} className="warn">{w}</div>)}
    {n.windClipped && <div className="warn">Part of the flight was above the top wind level of the forecast ({km(r.grid.field.topAltitude)} km); the top wind was held constant there.</div>}
    {r.demError && <div className="warn">Landing ground height could not be read from the DEM ({r.demError.split("(")[0].trim()}); the descent was ended at the pad elevation of {inp.launchAltM.toFixed(0)} m instead.</div>}
    <h2>Fill (for the forecast pad conditions)</h2>
    <div className="kv">
      <span className="k">Neck lift to set with the scale</span><span className="v big">{(p.neckLiftKg * 1000).toFixed(0)} g</span>
      <span className="k">Free lift</span><span className="v">{(p.freeLiftKg * 1000).toFixed(0)} g</span>
      <span className="k">Gas volume / mass at pad ({p.padT.toFixed(0)} K, {(p.padP / 100).toFixed(0)} hPa)</span><span className="v">{p.launchVolumeM3.toFixed(2)} m³ / {p.gasKg.toFixed(3)} kg</span>
      <span className="k">Ascent rate at pad · mean to burst</span><span className="v">{p.padAscentMs.toFixed(2)} · {p.meanAscentMs.toFixed(2)} m/s</span>
      <span className="k">CUSF calculator would say</span><span className="v">{p.cusf.neckLiftG.toFixed(0)} g, burst {p.cusf.burstAltM.toFixed(0)} m, {p.cusf.timeToBurstMin.toFixed(0)} min</span>
    </div>
    <h2>Nominal flight</h2>
    <div className="kv">
      <span className="k">Burst</span><span className="v big">{n.burst.z.toFixed(0)} m · {fl(n.burst.z)}</span>
      <span className="k">Burst after · at</span><span className="v">{hhmm(n.burst.t)} · {km(distanceM(inp.launchLat, inp.launchLon, n.burst.lat, n.burst.lon))} km {compass(bearingDeg(inp.launchLat, inp.launchLon, n.burst.lat, n.burst.lon))}</span>
      <span className="k">Landing</span><span className="v big">{n.landing.lat.toFixed(4)}, {n.landing.lon.toFixed(4)}</span>
      <span className="k">Range · bearing</span><span className="v big">{km(n.rangeM)} km ({nm(n.rangeM)} NM) · {deg(n.bearingDeg)} {compass(n.bearingDeg)}</span>
      <span className="k">Touchdown after · at</span><span className="v">{hhmm(n.durationS)} · {istString(new Date(inp.launchUtc.getTime() + n.durationS * 1000))}</span>
      <span className="k">Ground at landing (DEM, {r.demIterations} refinement{r.demIterations === 1 ? "" : "s"})</span><span className="v">{r.groundAltM.toFixed(0)} m · {ft(r.groundAltM)} ft</span>
      <span className="k">Descent: peak · at touchdown</span><span className="v">{n.maxDescentMs.toFixed(0)} · {n.landing.impactMs.toFixed(1)} m/s</span>
      <span className="k">Ascent · descent time</span><span className="v">{hhmm(n.ascentS)} · {hhmm(n.descentS)}</span>
      <span className="k">Wind data</span><span className="v" style={{ fontSize: 11 }}>{r.grid.field.label}</span>
    </div>
    {r.mc && <><h2>Monte Carlo ({r.mc.landings.length} flights)</h2>
      <div className="kv">
        <span className="k">Wind spread from</span><span className="v">{r.mc.windSource === "ensemble" ? `ECMWF ENS, ${r.ensembleN} members` : r.mc.windSource === "ar1" ? "assumed AR(1) σ" : "none"}</span>
        <span className="k">Range: median · 95th pct · max</span><span className="v">{km(r.mc.medianRangeM)} · {km(r.mc.p95RangeM)} · {km(r.mc.maxRangeM)} km</span>
        <span className="k">Burst altitude 5–50–95%</span><span className="v">{(r.mc.burstAltP5 / 1000).toFixed(1)} · {(r.mc.burstAltP50 / 1000).toFixed(1)} · {(r.mc.burstAltP95 / 1000).toFixed(1)} km</span>
        {r.mc.ellipses.map(e => <span key={e.prob} style={{ display: "contents" }}><span className="k">{(e.prob * 100).toFixed(0)}% ellipse, semi-axes</span><span className="v">{km(e.a)} × {km(e.b)} km, major axis {deg(((90 - e.thetaDeg) % 360 + 360) % 360)}</span></span>)}
        <span className="k">Mean landing</span><span className="v">{r.mc.meanLat.toFixed(4)}, {r.mc.meanLon.toFixed(4)}</span>
      </div></>}
    {r.tawhiri && <><h2>SondeHub / Tawhiri, same parameters</h2>
      <div className="kv">
        <span className="k">Dataset</span><span className="v">GFS {r.tawhiri.dataset.slice(0, 13)}Z</span>
        <span className="k">Landing</span><span className="v">{r.tawhiri.landing.latitude.toFixed(4)}, {(r.tawhiri.landing.longitude > 180 ? r.tawhiri.landing.longitude - 360 : r.tawhiri.landing.longitude).toFixed(4)}</span>
        <span className="k">Separation from this model</span><span className="v big">{tawhiriSep !== null ? km(tawhiriSep) : "–"} km</span>
        <span className="k">Tawhiri duration</span><span className="v">{hhmm((Date.parse(r.tawhiri.landing.datetime) - inp.launchUtc.getTime()) / 1000)}</span>
      </div>
      <p className="note">Tawhiri flies a constant ascent rate and v·1.1045/√ρ descent on the 0.5° GFS; we gave it our burst altitude, mean ascent rate and sea-level descent rate. A separation of a few km is the model difference; more than ~10 km usually means the two GFS runs differ or the ascent profile matters on that day.</p></>}
    {r.tawhiriError && <div className="warn">Tawhiri comparison failed: {r.tawhiriError}</div>}
    {r.hourly && r.hourly.length > 0 && <><h2>If the launch slips</h2>
      <table className="t"><thead><tr><th>launch</th><th>range km</th><th>bearing</th><th>duration</th></tr></thead><tbody>
        {[...r.hourly.filter(h => h.offsetH < 0), { offsetH: 0, rangeM: n.rangeM, bearing: n.bearingDeg, durationS: n.durationS, lat: 0, lon: 0 }, ...r.hourly.filter(h => h.offsetH > 0)].map(h => <tr key={h.offsetH} style={h.offsetH === 0 ? { fontWeight: 600 } : undefined}><td>{istString(new Date(inp.launchUtc.getTime() + h.offsetH * 3600e3)).slice(11, 16)} IST</td><td>{km(h.rangeM)}</td><td>{deg(h.bearing)} {compass(h.bearing)}</td><td>{hhmm(h.durationS)}</td></tr>)}
      </tbody></table></>}
  </div>;
}

function ResultCharts({ r, inp }: { r: Results; inp: PredictInputs }) {
  const n = r.nominal;
  const step = Math.max(1, Math.floor(n.points.length / 300));
  const pts = n.points.filter((_, i) => i % step === 0 || i === n.points.length - 1);
  const track = pts.map(q => { const [e, nn] = eastNorthM(inp.launchLat, inp.launchLon, q.lat, q.lon); return [e / 1000, nn / 1000] as [number, number]; });
  const split = pts.findIndex(q => q.stage === "descent");
  const mcPts = r.mc?.landings.map(l => [l.east / 1000, l.north / 1000] as [number, number]);
  const ell = r.mc?.ellipses.map(e => ellipsePolygon(e, inp.launchLat, inp.launchLon).map(([lo, la]) => { const [x, y] = eastNorthM(inp.launchLat, inp.launchLon, la, lo); return [x / 1000, y / 1000] as [number, number]; }));
  const refs: { x: number; y: number; label: string; color: string }[] = [];
  if (r.tawhiri) { const lo = r.tawhiri.landing.longitude > 180 ? r.tawhiri.landing.longitude - 360 : r.tawhiri.landing.longitude; const [x, y] = eastNorthM(inp.launchLat, inp.launchLon, r.tawhiri.landing.latitude, lo); refs.push({ x: x / 1000, y: y / 1000, label: "Tawhiri", color: "var(--ref)" }); }
  const col = r.grid.launchColumn;
  const speed = col.map(l => [Math.hypot(l.u, l.v), l.z / 1000] as [number, number]);
  // direction the balloon is pushed TOWARD, as a signed angle from north: W = -90 (left), N = 0, E = +90 (right), S = ±180 (edges)
  const towardSigned = (u: number, v: number) => { const toward = (dirSpeedFromUV(u, v)[0] + 180) % 360; return ((toward + 180) % 360) - 180; };
  const dir = col.map(l => [towardSigned(l.u, l.v), l.z / 1000] as [number, number]);
  const uSer = col.map(l => [l.u, l.z / 1000] as [number, number]), vSer = col.map(l => [l.v, l.z / 1000] as [number, number]);
  const asc = n.ascentModel?.track ?? [];
  return <>
    <div className="card"><h3>Plan view</h3>
      <div className="legend"><span><span className="sw" style={{ background: "var(--ascent)" }} />ascent</span><span><span className="sw" style={{ background: "var(--descent)" }} />descent</span><span><span className="dot" style={{ background: "var(--series-7)" }} />Monte Carlo landings, 50/90/95% ellipses</span>{r.tawhiri && <span><span className="dot" style={{ background: "var(--ref)" }} />Tawhiri</span>}</div>
      <PlanView track={track} trackSplit={Math.max(0, split)} mc={mcPts} ellipses={ell} refs={refs} /></div>
    <div className="card"><h3>Altitude vs time</h3>
      <LineChart xLabel="minutes after launch" yLabel="altitude, km" series={[{ name: "ascent", color: "var(--ascent)", points: pts.filter(q => q.stage !== "descent").map(q => [(q.t - n.points[0].t) / 60, q.z / 1000]) }, { name: "descent", color: "var(--descent)", points: pts.filter(q => q.stage === "descent").map(q => [(q.t - n.points[0].t) / 60, q.z / 1000]) }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} hlines={[{ y: 13.716, label: "FL450" }, { y: 22.86, label: "FL750" }]} tooltip={(x, y) => <span>T+{x.toFixed(0)} min, {y.toFixed(1)} km</span>} /></div>
    <div className="card"><h3>Forecast wind at the pad column, launch hour</h3>
      <p className="note">Read all three bottom-to-top: the balloon climbs through these layers in order, ~3 min per km. Left: how hard the wind blows. Middle: which way the balloon is pushed at that height, laid out like the map — west on the left, east on the right (a dot at E means the wind comes from the west and carries the balloon east). Right: the same wind split into east–west and north–south parts, same orientation.</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div><div className="legend"><span><span className="sw" style={{ background: "var(--series-1)" }} />speed</span></div>
          <LineChart xLabel="wind speed, m/s" yLabel="altitude, km" width={300} height={300} series={[{ name: "speed", color: "var(--series-1)", points: speed }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} xDomain={[0, Math.max(30, ...speed.map(q => q[0])) * 1.05]} tooltip={(x, y) => <span>{x.toFixed(1)} m/s at {y.toFixed(1)} km</span>} /></div>
        <div><div className="legend"><span><span className="dot" style={{ background: "var(--series-2)" }} />direction the balloon is pushed TOWARD</span></div>
          <LineChart xLabel="pushed toward:  S · W · N · E · S" yLabel="altitude, km" width={300} height={300} series={[{ name: "toward", color: "var(--series-2)", dots: true, points: dir }]} yFormat={v => v.toFixed(0)} xDomain={[-180, 180]} xTicks={[-180, -90, 0, 90, 180]} xFormat={v => ({ [-180]: "S", [-90]: "W", 0: "N", 90: "E", 180: "S" } as Record<number, string>)[v] ?? ""} vlines={[{ x: 0, label: "" }]} tooltip={(x, y) => { const toward = (x + 360) % 360; return <span>pushed {compass(toward)} (wind from {compass(toward + 180)}) at {y.toFixed(1)} km</span>; }} /></div>
      </div>
      <div className="legend" style={{ marginTop: 6 }}><span><span className="sw" style={{ background: "var(--series-1)" }} />u: east–west (right of the 0 line = pushes the balloon EAST)</span><span><span className="sw" style={{ background: "var(--series-3)" }} />v: north–south (right = pushes NORTH)</span></div>
      <LineChart xLabel="wind component, m/s (negative = toward west / south)" yLabel="altitude, km" series={[{ name: "u east", color: "var(--series-1)", points: uSer }, { name: "v north", color: "var(--series-3)", points: vSer }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} vlines={[{ x: 0, label: "" }]} height={240} tooltip={(x, y, s) => <span>{s.name}: {x.toFixed(1)} m/s at {y.toFixed(1)} km</span>} /></div>
    <div className="card"><h3>Where the drift comes from</h3>
      <p className="note">One row per altitude band. Each bar is the distance the balloon moved while it was inside that band, ascent and descent added together: blue = east–west (left of 0 is west), green = north–south (left of 0 is south). Add up the blue bars and you get the landing's east offset; the green bars, its north offset. Long bars mean strong wind, long time in the band, or both — the table below separates the two.</p>
      <div className="legend"><span><span className="sw" style={{ background: "var(--series-1)" }} />east–west</span><span><span className="sw" style={{ background: "var(--series-3)" }} />north–south</span></div>
      <LayerBars layers={n.layers} />
      <LayerTable layers={n.layers} /></div>
    <TemperatureCard r={r} />
    <WeatherCard r={r} inp={inp} />
    {asc.length > 0 && <div className="card"><h3>Ascent rate profile used ({inp.ascentModel})</h3>
      <LineChart xLabel="ascent rate, m/s" yLabel="altitude, km" series={[{ name: "v", color: "var(--series-1)", points: asc.map(t => [t.v, t.z / 1000]) }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(1)} xDomain={[0, Math.max(...asc.map(t => t.v)) * 1.1]} height={220} />
      <p className="note">Cd curve scale factor {n.ascentModel!.cdScale.toFixed(2)} to hit {r.plan.padAscentMs.toFixed(2)} m/s at the pad.</p></div>}
  </>;
}

/**
 * Projected air temperature: the forecast model's temperature at each pressure level in the pad
 * column at launch hour (same data the density column uses), and the temperature at the balloon's
 * own position and time along the flight (nearest grid column and hour), against the ISA reference.
 */
function TemperatureCard({ r }: { r: Results }) {
  const n = r.nominal;
  const col = r.grid.launchColumn;
  const profile = col.map(l => [l.T - 273.15, l.z / 1000] as [number, number]);
  const zTop = Math.max(35, n.burst.z / 1000 + 2);
  const isaRef: [number, number][] = []; for (let z = 0; z <= zTop * 1000; z += 500) isaRef.push([isa(z).T - 273.15, z / 1000]);
  const step = Math.max(1, Math.floor(n.points.length / 400));
  const along: { t: number; z: number; T: number; stage: string }[] = [];
  for (let i = 0; i < n.points.length; i += step) { const q = n.points[i]; along.push({ t: (q.t - n.points[0].t) / 60, z: q.z, T: r.grid.field.atmosphere(q.lat, q.lon, q.t).state(q.z).T - 273.15, stage: q.stage }); }
  const last = n.points[n.points.length - 1]; along.push({ t: (last.t - n.points[0].t) / 60, z: last.z, T: r.grid.field.atmosphere(last.lat, last.lon, last.t).state(last.z).T - 273.15, stage: last.stage });
  const coldest = along.reduce((a, b) => (b.T < a.T ? b : a), along[0]);
  const dtMin = along.length > 1 ? along[1].t - along[0].t : 0;
  const below = (thr: number) => along.filter(q => q.T <= thr).length * dtMin;
  const padT = along[0].T, burstT = along.find(q => q.stage === "descent")?.T ?? along[along.length - 1].T;
  const tropo = col.reduce((a, b) => (b.T < a.T ? b : a), col[0]);
  const xLo = Math.min(-90, ...profile.map(q => q[0])) - 5, xHi = Math.max(40, ...profile.map(q => q[0])) + 5;
  const padAtmos = r.grid.field.atmosphere(n.points[0].lat, n.points[0].lon, n.points[0].t);
  const pBurst = r.grid.field.atmosphere(n.burst.lat, n.burst.lon, n.points[0].t + n.burst.t).state(n.burst.z).p / 100;
  const pPad = padAtmos.state(n.points[0].z).p / 100;
  return <div className="card"><h3>Projected air temperature and pressure</h3>
    <div className="kv">
      <span className="k">At the pad · at burst</span><span className="v">{padT.toFixed(0)} °C, {pPad.toFixed(0)} hPa · {burstT.toFixed(0)} °C, {pBurst.toFixed(1)} hPa</span>
      <span className="k">Coldest point of the flight</span><span className="v big">{coldest.T.toFixed(0)} °C at {(coldest.z / 1000).toFixed(1)} km, T+{coldest.t.toFixed(0)} min</span>
      <span className="k">Tropopause in the pad column</span><span className="v">{(tropo.T - 273.15).toFixed(0)} °C at {(tropo.z / 1000).toFixed(1)} km</span>
      <span className="k">Time at or below −20 / −40 / −60 °C</span><span className="v">{below(-20).toFixed(0)} / {below(-40).toFixed(0)} / {below(-60).toFixed(0)} min</span>
    </div>
    <div className="legend" style={{ marginTop: 6 }}><span><span className="sw" style={{ background: "var(--series-2)" }} />forecast, pad column at launch hour</span><span><span className="sw" style={{ background: "var(--ref)" }} />ISA reference (dashed)</span></div>
    <LineChart xLabel="air temperature, °C" yLabel="altitude, km" series={[{ name: "forecast", color: "var(--series-2)", points: profile }, { name: "ISA", color: "var(--ref)", dashed: true, points: isaRef }]} xDomain={[xLo, xHi]} yDomain={[0, zTop]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} vlines={[{ x: 0, label: "0 °C" }, { x: -40, label: "−40" }]} hlines={[{ y: n.burst.z / 1000, label: "burst" }]} tooltip={(x, y, s) => <span>{s.name}: {x.toFixed(1)} °C at {y.toFixed(1)} km</span>} />
    <div className="legend" style={{ marginTop: 6 }}><span><span className="sw" style={{ background: "var(--ascent)" }} />ascent</span><span><span className="sw" style={{ background: "var(--descent)" }} />descent</span></div>
    <LineChart xLabel="minutes after launch" yLabel="temperature at the balloon, °C" series={[{ name: "ascent", color: "var(--ascent)", points: along.filter(q => q.stage !== "descent").map(q => [q.t, q.T]) }, { name: "descent", color: "var(--descent)", points: along.filter(q => q.stage === "descent").map(q => [q.t, q.T]) }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} hlines={[{ y: -40, label: "−40 °C" }]} height={220} tooltip={(x, y, s) => <span>{s.name}: {y.toFixed(1)} °C at T+{x.toFixed(0)} min</span>} />
    <details><summary>Pad column at launch hour: pressure level, height, temperature, wind ({col.length} levels)</summary>
      <table className="t"><thead><tr><th>pressure hPa</th><th>height m</th><th>temp °C</th><th>wind m/s</th><th>from</th><th>pushes toward</th></tr></thead><tbody>
        {[...col].reverse().map((l, i) => { const [from, spd] = dirSpeedFromUV(l.u, l.v); return <tr key={i}><td>{(l.p / 100).toFixed(l.p < 10000 ? 1 : 0)}</td><td>{l.z.toFixed(0)}</td><td>{(l.T - 273.15).toFixed(1)}</td><td>{spd.toFixed(1)}</td><td>{deg(from)} {compass(from)}</td><td>{compass(from + 180)}</td></tr>; })}
      </tbody></table>
      <p className="note">Rows are the model's own pressure levels, top of the atmosphere first. The last few rows are the 10–180 m above-ground winds; their pressure is derived hydrostatically from the surface pressure. Height is the model's geopotential height for that level, which is what the balloon's altitude is matched against.</p>
    </details>
    <p className="note">Source: the forecast model's temperature at each pressure level ({r.grid.field.label.split(",")[0]}), interpolated linearly between levels — the same column the ascent and descent use for air density. These are free-air temperatures; the payload box will run warmer in sunlight and cooler in shade, and the batteries' own self-heating is not included. The tropics have a colder, higher tropopause than the ISA, which is why the forecast line bends well below the dashed one near 17 km.</p>
  </div>;
}

/** Interpolate a weather-level property at altitude z (m). */
function wxAt(levels: { z: number; rh: number; cloud: number }[], z: number): { rh: number; cloud: number } | null {
  if (!levels.length) return null;
  if (z <= levels[0].z) return { rh: levels[0].rh, cloud: levels[0].cloud };
  const n = levels.length; if (z >= levels[n - 1].z) return { rh: levels[n - 1].rh, cloud: levels[n - 1].cloud };
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (levels[m].z <= z) lo = m; else hi = m; }
  const f = (z - levels[lo].z) / (levels[hi].z - levels[lo].z);
  return { rh: levels[lo].rh + f * (levels[hi].rh - levels[lo].rh), cloud: levels[lo].cloud + f * (levels[hi].cloud - levels[lo].cloud) };
}
/** Contiguous altitude bands (km) where pred holds along the level list, sampled every 250 m. */
function bands(levels: { z: number; rh: number; cloud: number; T: number }[], pred: (w: { rh: number; cloud: number; T: number }) => boolean): [number, number][] {
  const out: [number, number][] = []; if (!levels.length) return out;
  let start: number | null = null;
  for (let z = levels[0].z; z <= levels[levels.length - 1].z; z += 250) {
    const w = wxAt(levels, z)!; let T = levels[0].T;
    for (let i = 1; i < levels.length; i++) if (levels[i].z >= z) { const a = levels[i - 1], b = levels[i]; T = a.T + ((z - a.z) / (b.z - a.z)) * (b.T - a.T); break; }
    const ok = pred({ ...w, T });
    if (ok && start === null) start = z; if (!ok && start !== null) { out.push([start / 1000, z / 1000]); start = null; }
  }
  if (start !== null) out.push([start / 1000, levels[levels.length - 1].z / 1000]);
  return out;
}
const fmtBands = (b: [number, number][]) => (b.length ? b.map(([a, c]) => `${a.toFixed(1)}–${c.toFixed(1)} km`).join(", ") : "none");

/**
 * Humidity, cloud and rain from the same model as the winds: relative humidity and cloud fraction on
 * every pressure level of the pad column at launch hour; the surface weather series at the pad over the
 * window and at the landing zone around touchdown. Cloud bands, icing-risk bands and time in cloud are
 * derived from the pad column along the nominal flight.
 */
function WeatherCard({ r, inp }: { r: Results; inp: PredictInputs }) {
  const w = r.weather;
  if (!w) return <div className="card"><h3>Humidity, cloud and rain</h3><p className="note">{r.weatherError ? `Not available: ${r.weatherError}` : "Loading…"}</p></div>;
  const n = r.nominal;
  const lv = w.levels;
  const rhSer = lv.map(l => [l.rh, l.z / 1000] as [number, number]), ccSer = lv.map(l => [l.cloud, l.z / 1000] as [number, number]);
  const cloudBands = bands(lv, x => x.cloud >= 50);
  const icingBands = bands(lv, x => x.rh >= 90 && x.T <= 273.15 && x.T >= 253.15);
  // time in cloud along the nominal flight (pad column, cloud fraction >= 50 %)
  const step = Math.max(1, Math.floor(n.points.length / 500));
  let inCloudUp = 0, inCloudDown = 0, dt = 0;
  for (let i = step; i < n.points.length; i += step) { const q = n.points[i]; dt = q.t - n.points[i - step].t; const x = wxAt(lv, q.z); if (x && x.cloud >= 50) { if (q.stage === "descent") inCloudDown += dt; else inCloudUp += dt; } }
  const launchMs = inp.launchUtc.getTime(), touchMs = launchMs + n.durationS * 1000;
  const fmtT = (ms: number) => istString(new Date(ms)).slice(11, 16);
  const padRows = w.surface.filter(s => s.timeMs >= launchMs - 4 * 3600e3 && s.timeMs <= launchMs + 8 * 3600e3);
  const landRows = (r.landingWx ?? []).filter(s => s.timeMs >= touchMs - 2.5 * 3600e3 && s.timeMs <= touchMs + 2.5 * 3600e3);
  const atTouch = (r.landingWx ?? []).reduce<SurfaceWx | null>((best, s) => (!best || Math.abs(s.timeMs - touchMs) < Math.abs(best.timeMs - touchMs) ? s : best), null);
  const atLaunch = w.surface.reduce<SurfaceWx | null>((best, s) => (!best || Math.abs(s.timeMs - launchMs) < Math.abs(best.timeMs - launchMs) ? s : best), null);
  const pct = (v: number | null) => (v == null ? "–" : `${Math.round(v)}%`);
  const mm = (v: number | null) => (v == null ? "–" : v.toFixed(1));
  const cape = (v: number | null) => (v == null ? "–" : `${Math.round(v)} J/kg`);
  const rowsTable = (rows: SurfaceWx[], highlightMs: number) => <table className="t"><thead><tr><th>IST</th><th>rain mm/h</th><th>prob.</th><th>cloud</th><th>low / mid / high</th><th>RH 2 m</th><th>CAPE</th><th>weather</th></tr></thead><tbody>
    {rows.map(s => <tr key={s.timeMs} style={Math.abs(s.timeMs - highlightMs) < 1800e3 ? { fontWeight: 600 } : undefined}><td>{fmtT(s.timeMs)}</td><td>{mm(s.precipMm)}</td><td>{pct(s.precipProb)}</td><td>{pct(s.cloud)}</td><td>{s.cloudLow == null ? "–" : `${Math.round(s.cloudLow)} / ${Math.round(s.cloudMid ?? 0)} / ${Math.round(s.cloudHigh ?? 0)}`}</td><td>{pct(s.rh2m)}</td><td>{cape(s.cape)}</td><td>{s.weatherCode == null ? "–" : weatherCodeText(s.weatherCode)}</td></tr>)}
  </tbody></table>;
  return <div className="card"><h3>Humidity, cloud and rain</h3>
    <div className="kv">
      <span className="k">At launch, pad</span><span className="v">{atLaunch ? `${atLaunch.weatherCode == null ? "" : weatherCodeText(atLaunch.weatherCode) + ", "}cloud ${pct(atLaunch.cloud)}, rain ${mm(atLaunch.precipMm)} mm/h${atLaunch.precipProb == null ? "" : ` (${pct(atLaunch.precipProb)})`}, RH ${pct(atLaunch.rh2m)}, CAPE ${cape(atLaunch.cape)}` : "–"}</span>
      <span className="k">At touchdown, landing zone ({fmtT(touchMs)})</span><span className="v big">{atTouch ? `${atTouch.weatherCode == null ? "" : weatherCodeText(atTouch.weatherCode) + ", "}rain ${mm(atTouch.precipMm)} mm/h${atTouch.precipProb == null ? "" : ` (${pct(atTouch.precipProb)})`}, cloud ${pct(atTouch.cloud)}` : "–"}</span>
      <span className="k">Cloud layers in the pad column (cover ≥ 50%)</span><span className="v">{fmtBands(cloudBands)}</span>
      <span className="k">Time in cloud: ascent · descent</span><span className="v">{(inCloudUp / 60).toFixed(0)} · {(inCloudDown / 60).toFixed(0)} min</span>
      <span className="k">Icing-risk band (RH ≥ 90%, 0 to −20 °C)</span><span className="v">{fmtBands(icingBands)}</span>
    </div>
    <div className="legend" style={{ marginTop: 6 }}><span><span className="sw" style={{ background: "var(--series-1)" }} />relative humidity</span><span><span className="sw" style={{ background: "var(--series-2)" }} />cloud fraction</span></div>
    <LineChart xLabel="percent" yLabel="altitude, km" series={[{ name: "RH", color: "var(--series-1)", points: rhSer }, { name: "cloud", color: "var(--series-2)", points: ccSer }]} xDomain={[0, 100]} yDomain={[0, Math.max(35, n.burst.z / 1000 + 2)]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} vlines={[{ x: 50, label: "" }, { x: 90, label: "90" }]} hlines={[{ y: n.burst.z / 1000, label: "burst" }]} tooltip={(x, y, s) => <span>{s.name} {x.toFixed(0)}% at {y.toFixed(1)} km</span>} />
    <h3 style={{ marginTop: 12 }}>Surface weather at the pad, launch window</h3>
    <div className="legend"><span><span className="sw" style={{ background: "var(--series-2)" }} />cloud cover %</span><span><span className="sw" style={{ background: "var(--series-1)" }} />rain probability %</span></div>
    <LineChart xLabel="hours from launch (IST on the table)" yLabel="percent" series={[{ name: "cloud", color: "var(--series-2)", points: padRows.filter(s => s.cloud != null).map(s => [(s.timeMs - launchMs) / 3600e3, s.cloud!]) }, { name: "rain probability", color: "var(--series-1)", points: padRows.filter(s => s.precipProb != null).map(s => [(s.timeMs - launchMs) / 3600e3, s.precipProb!]) }]} yDomain={[0, 100]} yFormat={v => v.toFixed(0)} xFormat={v => (v > 0 ? "+" : "") + v.toFixed(0)} vlines={[{ x: 0, label: "launch" }, { x: n.durationS / 3600, label: "landing" }]} height={200} />
    <LineChart xLabel="hours from launch" yLabel="rain, mm per hour" series={[{ name: "rain", color: "var(--series-1)", points: padRows.filter(s => s.precipMm != null).map(s => [(s.timeMs - launchMs) / 3600e3, s.precipMm!]) }]} yDomain={[0, Math.max(1, ...padRows.map(s => s.precipMm ?? 0)) * 1.2]} yFormat={v => v.toFixed(1)} xFormat={v => (v > 0 ? "+" : "") + v.toFixed(0)} vlines={[{ x: 0, label: "launch" }]} height={160} />
    <details><summary>Hourly table at the pad ({padRows.length} h)</summary>{rowsTable(padRows, launchMs)}</details>
    {landRows.length > 0 && <details open><summary>Landing zone {n.landing.lat.toFixed(3)}, {n.landing.lon.toFixed(3)} around touchdown ({landRows.length} h)</summary>{rowsTable(landRows, touchMs)}</details>}
    <p className="note">Source: {w.label}. Relative humidity and cloud fraction are the model's values on its pressure levels; the surface rows are the model's hourly precipitation (mm in the hour), probability of precipitation where the model provides it, total and layer cloud, 2 m humidity and CAPE. "Time in cloud" uses the pad column for the whole flight, so it is an estimate; the landing-zone rows are the model column nearest the predicted landing point. A CAPE above ~1000 J/kg with rain probability rising means convective showers are possible; the recovery team should read the landing-zone row for the touchdown hour.</p>
  </div>;
}

/** metres east/north -> "6.0 W / 1.7 N" (km, compass letters instead of signs; 0.0 shown without a letter) */
const fEN = (eastM: number, northM: number) => { const e = eastM / 1000, n = northM / 1000; const fe = Math.abs(e) < 0.05 ? "0.0" : `${Math.abs(e).toFixed(1)} ${e > 0 ? "E" : "W"}`; const fn = Math.abs(n) < 0.05 ? "0.0" : `${Math.abs(n).toFixed(1)} ${n > 0 ? "N" : "S"}`; return `${fe} / ${fn}`; };
function LayerTable({ layers }: { layers: FlightResult["layers"] }) {
  const rows = layers.filter(l => l.ascentTimeS + l.descentTimeS > 0);
  const totE = rows.reduce((s, l) => s + l.ascentEast + l.descentEast, 0), totN = rows.reduce((s, l) => s + l.ascentNorth + l.descentNorth, 0);
  const strat = rows.filter(l => l.zFrom >= 18000), trop = rows.filter(l => l.zTo <= 18000);
  const sE = strat.reduce((s, l) => s + l.ascentEast + l.descentEast, 0), sN = strat.reduce((s, l) => s + l.ascentNorth + l.descentNorth, 0);
  const tE = trop.reduce((s, l) => s + l.ascentEast + l.descentEast, 0), tN = trop.reduce((s, l) => s + l.ascentNorth + l.descentNorth, 0);
  const dot = (sE * tE + sN * tN) / Math.max(1, Math.hypot(tE, tN) ** 2);
  return <>
    <table className="t"><thead><tr><th>layer</th><th>up: min</th><th>up: moved km (E/W · N/S)</th><th>down: min</th><th>down: moved km (E/W · N/S)</th></tr></thead><tbody>
      {rows.map(l => <tr key={l.zFrom}><td>{(l.zFrom / 1000).toFixed(0)}–{(l.zTo / 1000).toFixed(0)} km</td><td>{(l.ascentTimeS / 60).toFixed(1)}</td><td>{fEN(l.ascentEast, l.ascentNorth)}</td><td>{(l.descentTimeS / 60).toFixed(1)}</td><td>{fEN(l.descentEast, l.descentNorth)}</td></tr>)}
      <tr style={{ fontWeight: 600 }}><td>total</td><td /><td colSpan={3}>{fEN(totE, totN)} km</td></tr>
    </tbody></table>
    <p className="note">Below 18 km the flight moved {(Math.hypot(tE, tN) / 1000).toFixed(1)} km; above 18 km it moved {(Math.hypot(sE, sN) / 1000).toFixed(1)} km. {dot < 0 ? `The stratospheric winds ran against the tropospheric drift and undid ${(-dot * 100).toFixed(0)}% of it (a wind reversal pulling the flight back toward the pad).` : `The stratospheric winds ran with the tropospheric drift and added ${(dot * 100).toFixed(0)}% more in the same direction — no reversal on this day.`}</p>
  </>;
}
