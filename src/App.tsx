import { useCallback, useMemo, useRef, useState } from "react";
import { MapView, type MapData } from "./ui/MapView";
import { BurstCalcPanel } from "./ui/BurstCalcPanel";
import { ClimatologyPanel } from "./ui/ClimatologyPanel";
import { MethodPanel } from "./ui/MethodPanel";
import { LineChart, PlanView, LayerBars } from "./ui/charts";
import { km, nm, ft, fl, hhmm, deg, compass, istString, utcString, istToDate, dateToIstParts } from "./ui/format";
import { BALLOONS, balloonById } from "./physics/balloon";
import { planFill, buildFlightConfig, flyWithTerrain, type PredictInputs } from "./physics/predictor";
import { flyTrajectory, type FlightResult } from "./physics/trajectory";
import { ellipsePolygon, type McResult } from "./physics/montecarlo";
import { eastNorthM, distanceM, bearingDeg, dirSpeedFromUV } from "./physics/geo";
import { fetchGridField, fetchEnsemblePerturbations, fetchElevations, geocode, MODEL_LABEL, type ModelId, type GridFetchResult, type GeocodeHit } from "./data/openmeteo";
import { fetchTawhiri, type TawhiriResult } from "./data/tawhiri";
import { callWorker } from "./ui/worker-client";

type Tab = "predict" | "burst" | "climatology" | "method";

import { DEFAULT_INPUTS } from "./physics/defaults";
interface Settings { model: ModelId; mcRuns: number; useEnsemble: boolean; compareTawhiri: boolean; windSigmaMs: number; burstMeanRatio: number; fillSigma: number; chuteCdSpread: number; remnant: boolean; hourSweep: boolean }
const DEFAULT_SETTINGS: Settings = { model: "gfs_seamless", mcRuns: 300, useEnsemble: true, compareTawhiri: true, windSigmaMs: 2.5, burstMeanRatio: 1.0, fillSigma: 0.05, chuteCdSpread: 0.2, remnant: true, hourSweep: true };

interface Results {
  grid: GridFetchResult; plan: ReturnType<typeof planFill>; nominal: FlightResult; groundAltM: number; demIterations: number;
  mc?: McResult; ensembleN: number; tawhiri?: TawhiriResult; tawhiriError?: string;
  hourly?: { offsetH: number; lat: number; lon: number; rangeM: number; bearing: number; durationS: number }[];
  computedAt: Date;
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
      log(`Fetching ${MODEL_LABEL[set.model]} — 25 columns, ${set.hourSweep ? 15 : 10} hours…`);
      const grid = await fetchGridField({ lat: inp.launchLat, lon: inp.launchLon, model: set.model, launch: inp.launchUtc, hoursBefore: set.hourSweep ? 4 : 1, hoursAfter: set.hourSweep ? 11 : 8, signal: ac.signal });
      const launchTimeS = (inp.launchUtc.getTime() - grid.epochMs) / 1000;
      const atmos = grid.field.atmosphere(inp.launchLat, inp.launchLon, launchTimeS);
      const plan = planFill(inp, atmos);
      log("Flying nominal trajectory and looking up terrain at the landing point…");
      const cfg = buildFlightConfig(inp, plan, launchTimeS);
      const { result: nominal, groundAltM, iterations } = await flyWithTerrain(grid.field, cfg, pts => fetchElevations(pts, ac.signal));
      const partial: Results = { grid, plan, nominal, groundAltM, demIterations: iterations, ensembleN: 0, computedAt: new Date() };
      setRes({ ...partial }); setFitKey(String(Date.now()));
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
      log(`Done at ${istString(new Date())}.`);
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
      <div className="tabs">{(["predict", "burst", "climatology", "method"] as Tab[]).map(t => <button key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>{{ predict: "Predict", burst: "Burst calculator", climatology: "Climatology", method: "Method & sources" }[t]}</button>)}</div>
    </div>
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
        <div className="field"><label>Forecast model</label><select value={set.model} onChange={e => upS("model", e.target.value as ModelId)}>{(Object.keys(MODEL_LABEL) as ModelId[]).map(m => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}</select></div>
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
  const dir = col.map(l => [dirSpeedFromUV(l.u, l.v)[0], l.z / 1000] as [number, number]);
  const uSer = col.map(l => [l.u, l.z / 1000] as [number, number]), vSer = col.map(l => [l.v, l.z / 1000] as [number, number]);
  const asc = n.ascentModel?.track ?? [];
  return <>
    <div className="card"><h3>Plan view</h3>
      <div className="legend"><span><span className="sw" style={{ background: "var(--ascent)" }} />ascent</span><span><span className="sw" style={{ background: "var(--descent)" }} />descent</span><span><span className="dot" style={{ background: "var(--series-7)" }} />Monte Carlo landings, 50/90/95% ellipses</span>{r.tawhiri && <span><span className="dot" style={{ background: "var(--ref)" }} />Tawhiri</span>}</div>
      <PlanView track={track} trackSplit={Math.max(0, split)} mc={mcPts} ellipses={ell} refs={refs} /></div>
    <div className="card"><h3>Altitude vs time</h3>
      <LineChart xLabel="minutes after launch" yLabel="altitude, km" series={[{ name: "ascent", color: "var(--ascent)", points: pts.filter(q => q.stage !== "descent").map(q => [(q.t - n.points[0].t) / 60, q.z / 1000]) }, { name: "descent", color: "var(--descent)", points: pts.filter(q => q.stage === "descent").map(q => [(q.t - n.points[0].t) / 60, q.z / 1000]) }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} hlines={[{ y: 13.716, label: "FL450" }, { y: 22.86, label: "FL750" }]} tooltip={(x, y) => <span>T+{x.toFixed(0)} min, {y.toFixed(1)} km</span>} /></div>
    <div className="card"><h3>Forecast wind at the pad column, launch hour</h3>
      <div className="legend"><span><span className="sw" style={{ background: "var(--series-1)" }} />speed m/s</span><span><span className="dot" style={{ background: "var(--series-2)" }} />direction wind blows FROM, °</span></div>
      <LineChart xLabel="speed, m/s (line) · direction from, ° (dots, ×0.1)" yLabel="altitude, km" series={[{ name: "speed", color: "var(--series-1)", points: speed }, { name: "from ° ÷10", color: "var(--series-2)", dots: true, points: dir.map(q => [q[0] / 10, q[1]]) }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} xDomain={[0, Math.max(36, ...speed.map(q => q[0])) * 1.05]} tooltip={(x, y, s) => <span>{s.name === "speed" ? `${x.toFixed(1)} m/s` : `from ${(x * 10).toFixed(0)}°`} at {y.toFixed(1)} km</span>} />
      <div className="legend"><span><span className="sw" style={{ background: "var(--series-1)" }} />u (east +)</span><span><span className="sw" style={{ background: "var(--series-3)" }} />v (north +)</span></div>
      <LineChart xLabel="wind component, m/s" yLabel="altitude, km" series={[{ name: "u east", color: "var(--series-1)", points: uSer }, { name: "v north", color: "var(--series-3)", points: vSer }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} vlines={[{ x: 0, label: "" }]} height={220} /></div>
    <div className="card"><h3>Where the drift comes from</h3>
      <div className="legend"><span><span className="sw" style={{ background: "var(--series-1)" }} />east</span><span><span className="sw" style={{ background: "var(--series-3)" }} />north</span></div>
      <LayerBars layers={n.layers} />
      <LayerTable layers={n.layers} /></div>
    {asc.length > 0 && <div className="card"><h3>Ascent rate profile used ({inp.ascentModel})</h3>
      <LineChart xLabel="ascent rate, m/s" yLabel="altitude, km" series={[{ name: "v", color: "var(--series-1)", points: asc.map(t => [t.v, t.z / 1000]) }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(1)} xDomain={[0, Math.max(...asc.map(t => t.v)) * 1.1]} height={220} />
      <p className="note">Cd curve scale factor {n.ascentModel!.cdScale.toFixed(2)} to hit {r.plan.padAscentMs.toFixed(2)} m/s at the pad.</p></div>}
  </>;
}

const f1 = (m: number) => { const v = m / 1000; return (Math.abs(v) < 0.05 ? 0 : v).toFixed(1); };
function LayerTable({ layers }: { layers: FlightResult["layers"] }) {
  const rows = layers.filter(l => l.ascentTimeS + l.descentTimeS > 0);
  const totE = rows.reduce((s, l) => s + l.ascentEast + l.descentEast, 0), totN = rows.reduce((s, l) => s + l.ascentNorth + l.descentNorth, 0);
  const strat = rows.filter(l => l.zFrom >= 18000), trop = rows.filter(l => l.zTo <= 18000);
  const sE = strat.reduce((s, l) => s + l.ascentEast + l.descentEast, 0), sN = strat.reduce((s, l) => s + l.ascentNorth + l.descentNorth, 0);
  const tE = trop.reduce((s, l) => s + l.ascentEast + l.descentEast, 0), tN = trop.reduce((s, l) => s + l.ascentNorth + l.descentNorth, 0);
  const dot = (sE * tE + sN * tN) / Math.max(1, Math.hypot(tE, tN) ** 2);
  return <>
    <table className="t"><thead><tr><th>layer</th><th>up: min</th><th>up: E/N km</th><th>down: min</th><th>down: E/N km</th></tr></thead><tbody>
      {rows.map(l => <tr key={l.zFrom}><td>{(l.zFrom / 1000).toFixed(0)}–{(l.zTo / 1000).toFixed(0)} km</td><td>{(l.ascentTimeS / 60).toFixed(1)}</td><td>{f1(l.ascentEast)} / {f1(l.ascentNorth)}</td><td>{(l.descentTimeS / 60).toFixed(1)}</td><td>{f1(l.descentEast)} / {f1(l.descentNorth)}</td></tr>)}
      <tr style={{ fontWeight: 600 }}><td>total</td><td /><td colSpan={3}>{(totE / 1000).toFixed(1)} / {(totN / 1000).toFixed(1)} km</td></tr>
    </tbody></table>
    <p className="note">Below 18 km the flight moved {(Math.hypot(tE, tN) / 1000).toFixed(1)} km; above 18 km it moved {(Math.hypot(sE, sN) / 1000).toFixed(1)} km. {dot < 0 ? `The stratospheric winds ran against the tropospheric drift and undid ${(-dot * 100).toFixed(0)}% of it (a wind reversal pulling the flight back toward the pad).` : `The stratospheric winds ran with the tropospheric drift and added ${(dot * 100).toFixed(0)}% more in the same direction — no reversal on this day.`}</p>
  </>;
}
