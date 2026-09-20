import { useEffect, useMemo, useState } from "react";
import { loadIgra, loadGfs, levelStats, MONTH_NAMES, monthOf, yearOf, type StoredProfile, type IgraBundle, type GfsBundle } from "../data/climatology";
import { planFill, buildFlightConfig, type PredictInputs } from "../physics/predictor";
import { isa } from "../physics/atmosphere";
import { callWorker } from "./worker-client";
import { fetchGfsArchiveProfiles, type ArchiveProfile } from "../data/openmeteo";
import { distanceM } from "../physics/geo";
import { BandChart, PlanView, Histogram, LineChart } from "./charts";
import { km, nm, compass, deg } from "./format";

const ALTS = [500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000, 21000, 22000, 23000, 24000, 25000, 26000, 27000, 28000, 29000, 30000, 31000, 32000];
interface Landing { label: string; date: string; station?: string; lat: number; lon: number; rangeM: number; bearingDeg: number; eastM: number; northM: number; durationS: number; burstZ: number; clipped: boolean; error?: string; layers: any[] }

export function ClimatologyPanel({ inputs }: { inputs: PredictInputs }) {
  const [igra, setIgra] = useState<IgraBundle | null>(null);
  const [gfs, setGfs] = useState<GfsBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<string>("INM00043063");
  const [months, setMonths] = useState<number[]>([10, 11]);
  const [selMode, setSelMode] = useState<"months" | "date">("months");
  const [centreDate, setCentreDate] = useState("10-24");
  const [windowDays, setWindowDays] = useState(10);
  const [yearFrom, setYearFrom] = useState(2016);
  const [yearTo, setYearTo] = useState(2026);
  const [hour, setHour] = useState<"all" | "00" | "12">("all");
  const [landings, setLandings] = useState<Landing[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{ key: string; profiles: ArchiveProfile[] } | null>(null);
  const [liveStatus, setLiveStatus] = useState<string>("");
  const liveKey = `${inputs.launchLat.toFixed(2)},${inputs.launchLon.toFixed(2)}|${selMode === "months" ? months.join(",") : centreDate + "±" + windowDays}|${yearFrom}-${yearTo}`;
  const launchHoursUtc = useMemo(() => { const h = inputs.launchUtc.getUTCHours() + inputs.launchUtc.getUTCMinutes() / 60; return [...new Set([Math.floor(h), Math.ceil(h) % 24])]; }, [inputs.launchUtc]);
  async function fetchLive() {
    setLiveStatus("fetching…"); setLandings(null);
    try {
      const [cm, cd] = centreDate.split("-").map(Number);
      const monthsWanted = selMode === "months" ? months : [...new Set([-1, 0, 1].map(k => { const d = new Date(Date.UTC(2026, cm - 1, cd + k * windowDays)); return d.getUTCMonth() + 1; }))];
      const years = []; for (let y = Math.max(2021, yearFrom); y <= Math.min(yearTo, new Date().getUTCFullYear()); y++) years.push(y);
      const profiles = await fetchGfsArchiveProfiles({ lat: inputs.launchLat, lon: inputs.launchLon, months: monthsWanted, years, hoursUtc: launchHoursUtc, onProgress: (d, t) => setLiveStatus(`fetching month ${d}/${t}…`) });
      setLive({ key: liveKey, profiles }); setLiveStatus(`${profiles.length} launch-hour columns fetched`);
    } catch (e) { setLiveStatus("failed: " + String((e as any).message ?? e)); }
  }
  useEffect(() => { loadIgra().then(setIgra).catch(e => setErr(String(e))); loadGfs().then(setGfs).catch(e => setErr(String(e))); }, []);

  const profiles: StoredProfile[] = useMemo(() => {
    const all: StoredProfile[] = source === "gfs" ? (gfs?.profiles ?? []) : source === "gfs-live" ? (live && live.key === liveKey ? live.profiles : []) : (igra?.profiles.filter(p => p.s === source) ?? []);
    const doy = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(y, 0, 1)) / 864e5); };
    const [cm, cd] = centreDate.split("-").map(Number);
    const target = Number.isFinite(cm) && Number.isFinite(cd) ? doy(`2026-${String(cm).padStart(2, "0")}-${String(cd).padStart(2, "0")}`) : NaN;
    const inSel = (p: StoredProfile) => selMode === "months" ? months.includes(monthOf(p)) : Math.abs(doy("2026" + p.d.slice(4)) - target) <= windowDays;
    return all.filter(p => inSel(p) && yearOf(p) >= yearFrom && yearOf(p) <= yearTo && (hour === "all" || source === "gfs" || String(p.h).padStart(2, "0") === hour));
  }, [igra, gfs, source, months, yearFrom, yearTo, hour, selMode, centreDate, windowDays, live, liveKey]);
  const stats = useMemo(() => levelStats(profiles, 250, ALTS), [profiles]);
  const perMonth = useMemo(() => {
    const all: StoredProfile[] = source === "gfs" ? (gfs?.profiles ?? []) : source === "gfs-live" ? (live?.profiles ?? []) : (igra?.profiles.filter(p => p.s === source) ?? []);
    return MONTH_NAMES.map((nm_, i) => { const ps = all.filter(p => monthOf(p) === i + 1 && yearOf(p) >= yearFrom && yearOf(p) <= yearTo); const s = levelStats(ps, 250, [3000, 12000, 20000, 28000]); return { name: nm_, n: ps.length, s }; });
  }, [igra, gfs, source, yearFrom, yearTo, live]);

  async function fly() {
    setBusy(true); setLandings(null);
    try {
      const plan = planFill(inputs, { state: isa });
      const cfg = buildFlightConfig(inputs, plan, 0);
      const step = 250;
      const msg = { type: "climatology", cfg: { ...cfg, groundAltAt: undefined }, dtS: 10, profiles: profiles.map(p => ({ z: p.uv.map((_, i) => i * step), u: p.uv.map(x => x[0] / 10), v: p.uv.map(x => x[1] / 10), label: `${p.d} ${String(p.h).padStart(2, "0")}Z`, date: p.d, station: p.s, col: p.col ? p.col.map(c => ({ z: c[0], T: c[1] / 10, p: c[2] })) : undefined })) };
      const out = await callWorker<{ results: Landing[] }>(msg);
      setLandings(out.results.filter(l => !l.error));
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }
  const stationName = (id: string) => id === "gfs" ? "GFS at Jejuri (Open-Meteo archive)" : id === "gfs-live" ? `GFS at ${inputs.launchLat.toFixed(3)}, ${inputs.launchLon.toFixed(3)} (fetched)` : igra?.stations[id]?.name ?? id;
  const kmFromPad = (id: string) => igra?.stations[id] ? Math.round(distanceM(inputs.launchLat, inputs.launchLon, igra.stations[id].lat, igra.stations[id].lon) / 1000) : null;
  const ranges = landings?.map(l => l.rangeM / 1000) ?? [];
  const pct = (q: number) => { if (!ranges.length) return 0; const s = [...ranges].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };
  const rose = useMemo(() => { const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]; const c = new Array(8).fill(0); for (const l of landings ?? []) c[Math.floor(((l.bearingDeg + 22.5) % 360) / 45)]++; return names.map((n, i) => ({ n, f: landings?.length ? c[i] / landings.length : 0 })); }, [landings]);
  const yearsAvail = source === "gfs" ? [2022, 2026] : [igra?.stations[source]?.year_from ?? 2016, 2026];
  const gfsVsIgra = useMemo(() => {
    // same-day comparison: GFS 05/06 UTC vs the IGRA 00Z sounding at the selected station (only Pune is close enough to mean anything: 43 km)
    if (!igra || !gfs || source === "gfs") return null;
    const byDate = new Map<string, StoredProfile>(); for (const p of gfs.profiles) if (p.h === 5) byDate.set(p.d, p);
    const pairs = profiles.filter(p => p.h === 0 && byDate.has(p.d)).map(p => [p, byDate.get(p.d)!] as const);
    if (pairs.length < 5) return { n: pairs.length, rows: [] as { z: number; rms: number; bias: number; meanSpd: number }[] };
    const rows = [1000, 3000, 5000, 8000, 12000, 16000, 20000, 24000, 28000].map(z => { const i = z / 250; let se = 0, n = 0, bu = 0, bv = 0, ms = 0; for (const [a, b] of pairs) { const x = a.uv[i], y = b.uv[i]; if (!x || !y) continue; const du = (y[0] - x[0]) / 10, dv = (y[1] - x[1]) / 10; se += du * du + dv * dv; bu += du; bv += dv; ms += Math.hypot(x[0], x[1]) / 10; n++; } return { z, rms: n ? Math.sqrt(se / n) : NaN, bias: n ? Math.hypot(bu / n, bv / n) : NaN, meanSpd: n ? ms / n : NaN }; });
    return { n: pairs.length, rows };
  }, [igra, gfs, source, profiles]);

  return <div className="page">
    {err && <div className="bad">{err}</div>}
    <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 24 }}>
      <div>
        <h2>Data set</h2>
        <div className="field"><label>Source</label><select value={source} onChange={e => { setSource(e.target.value); setLandings(null); }}>
          {igra && Object.entries(igra.stations).sort((a, b) => (kmFromPad(a[0]) ?? 0) - (kmFromPad(b[0]) ?? 0)).map(([id, s]) => <option key={id} value={id}>{s.name} radiosonde — {kmFromPad(id)} km from pad ({s.n_profiles} deep soundings, {s.year_from}–)</option>)}
          <option value="gfs">GFS model column at Jejuri, 05/06 UTC daily, 2022–2026 (bundled)</option>
          <option value="gfs-live">GFS model column at the current pad, launch hour, 2021– (fetched on demand)</option></select></div>
        {source === "gfs-live" && <div className="card" style={{ padding: "8px 10px", margin: "6px 0" }}>
          <div className="note" style={{ margin: 0 }}>Pulls the Open-Meteo GFS archive at {inputs.launchLat.toFixed(3)}, {inputs.launchLon.toFixed(3)} for the selected months and years at {launchHoursUtc.map(h => String(h).padStart(2, "0") + "Z").join(" and ")} (your launch hour). One request per month, ~0.7 MB each; the archive starts April 2021.</div>
          <div className="row" style={{ marginTop: 6 }}><button className="secondary" onClick={fetchLive} disabled={liveStatus.startsWith("fetching")}>Fetch archive for this pad</button><span className="status">{live?.key === liveKey ? liveStatus : (live ? "pad/selection changed — fetch again" : liveStatus)}</span></div>
        </div>}
        <div className="field"><label>Select by</label><select value={selMode} onChange={e => { setSelMode(e.target.value as any); setLandings(null); }}><option value="months">whole months</option><option value="date">a date ± days (all years)</option></select></div>
        {selMode === "months" ? <div className="field"><label>Months</label><div className="row">{MONTH_NAMES.map((m, i) => <label key={m} style={{ fontSize: 12 }}><input type="checkbox" checked={months.includes(i + 1)} onChange={e => setMonths(ms => e.target.checked ? [...ms, i + 1].sort((a, b) => a - b) : ms.filter(x => x !== i + 1))} />{m}</label>)}</div></div>
          : <><div className="field"><label>Date <span className="unit">MM-DD</span></label><input value={centreDate} onChange={e => { setCentreDate(e.target.value); setLandings(null); }} /></div>
            <div className="field"><label>Window <span className="unit">± days</span></label><input type="number" value={windowDays} min={1} max={60} onChange={e => { setWindowDays(+e.target.value); setLandings(null); }} /></div></>}
        <div className="field"><label>Years</label><div className="row"><input type="number" value={yearFrom} min={yearsAvail[0]} max={2026} onChange={e => setYearFrom(+e.target.value)} style={{ width: 70 }} /> – <input type="number" value={yearTo} min={yearsAvail[0]} max={2026} onChange={e => setYearTo(+e.target.value)} style={{ width: 70 }} /></div></div>
        {source !== "gfs" && <div className="field"><label>Sounding hour</label><select value={hour} onChange={e => setHour(e.target.value as any)}><option value="all">00Z and 12Z (05:30 and 17:30 IST)</option><option value="00">00Z only (05:30 IST)</option><option value="12">12Z only (17:30 IST)</option></select></div>}
        <p className="note">{profiles.length} profiles selected. Radiosondes are launched at 00Z and 12Z; an 11:00 IST launch (05:30Z) sits between them. Upper winds change slowly, so both are used; the boundary layer differs, which matters only for the last few km of descent.</p>
        <div className="row"><button className="primary" disabled={busy || !profiles.length} onClick={fly}>{busy ? "Flying…" : `Fly the vehicle on all ${profiles.length} profiles`}</button></div>
        <p className="note">Vehicle: current Predict-tab fill ({inputs.balloonId}, {inputs.payloadKg} kg, {inputs.fillMode === "ascentRate" ? `${inputs.targetAscentMs} m/s` : inputs.fillMode}), ISA atmosphere from {inputs.launchAltM} m, landing at pad elevation. No Monte Carlo here: each dot is one real atmosphere.</p>
        {landings && landings.length > 0 && <>
          <h2>Landing range, {stationName(source)}</h2>
          <div className="kv">
            <span className="k">flights</span><span className="v">{landings.length}</span>
            <span className="k">median</span><span className="v big">{pct(0.5).toFixed(1)} km ({(pct(0.5) * 1000 / 1852).toFixed(1)} NM)</span>
            <span className="k">75th / 90th / 95th pct</span><span className="v">{pct(0.75).toFixed(1)} / {pct(0.9).toFixed(1)} / {pct(0.95).toFixed(1)} km</span>
            <span className="k">99th pct / max</span><span className="v">{pct(0.99).toFixed(1)} / {Math.max(...ranges).toFixed(1)} km</span>
            <span className="k">duration median</span><span className="v">{(landings.reduce((s, l) => s + l.durationS, 0) / landings.length / 60).toFixed(0)} min</span>
            <span className="k">profiles topped out below burst</span><span className="v">{landings.filter(l => l.clipped).length}</span>
          </div>
          <h3>Landing bearing from pad</h3>
          <table className="t"><tbody>{rose.map(r => <tr key={r.n}><td>{r.n}</td><td>{(r.f * 100).toFixed(0)}%</td><td style={{ textAlign: "left" }}><div style={{ background: "var(--series-1)", height: 8, width: `${r.f * 100 * 2}px`, borderRadius: 2 }} /></td></tr>)}</tbody></table>
        </>}
      </div>
      <div>
        <h2>Wind speed by altitude — {stationName(source)}, {selMode === "months" ? months.map(m => MONTH_NAMES[m - 1]).join("/") : `${centreDate} ± ${windowDays} d`} {yearFrom}–{yearTo}</h2>
        <div className="legend"><span><span className="sw" style={{ background: "var(--series-1)" }} />median</span><span><span className="sw" style={{ background: "var(--series-1)", opacity: 0.6 }} />95th pct (dashed) and band</span><span><span className="sw" style={{ background: "var(--series-2)" }} />max</span></div>
        <BandChart rows={stats.filter(s => s.n > 0).map(s => ({ z: s.z, p50: s.p50Speed, p95: s.p95Speed, max: s.maxSpeed, mean: s.meanSpeed }))} xLabel="wind speed, m/s" />
        <h3>Mean wind vector and direction reversal</h3>
        <div className="legend"><span><span className="sw" style={{ background: "var(--series-1)" }} />mean u (east +)</span><span><span className="sw" style={{ background: "var(--series-3)" }} />mean v (north +)</span></div>
        <LineChart xLabel="mean wind component, m/s" yLabel="altitude, km" series={[{ name: "mean u", color: "var(--series-1)", points: stats.filter(s => s.n > 0).map(s => [s.meanU, s.z / 1000]) }, { name: "mean v", color: "var(--series-3)", points: stats.filter(s => s.n > 0).map(s => [s.meanV, s.z / 1000]) }]} vlines={[{ x: 0, label: "" }]} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} height={280} />
        <table className="t"><thead><tr><th>altitude</th><th>n</th><th>mean speed</th><th>median</th><th>p95</th><th>max</th><th>mean from</th><th>% blowing eastward</th></tr></thead><tbody>
          {stats.filter(s => s.n > 0 && [1000, 2000, 3000, 5000, 7000, 10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000, 26000, 28000, 30000, 32000].includes(s.z)).map(s => <tr key={s.z}><td>{(s.z / 1000).toFixed(0)} km</td><td>{s.n}</td><td>{s.meanSpeed.toFixed(1)}</td><td>{s.p50Speed.toFixed(1)}</td><td>{s.p95Speed.toFixed(1)}</td><td>{s.maxSpeed.toFixed(1)}</td><td>{deg(s.meanFromDeg)} {compass(s.meanFromDeg)}</td><td>{(s.fracEast * 100).toFixed(0)}%</td></tr>)}
        </tbody></table>
        <p className="note">"Reverse" layer: where the mean u changes sign the balloon is carried back. Over Pune in October–November the low troposphere blows from the east/north-east (post-monsoon), the upper troposphere from the west (subtropical jet building from ~10 km), and the stratosphere above ~20 km from the east again while the summer easterlies persist — so a flight typically goes west on the way up through the jet and is pulled back east above 20 km and on the first part of the descent.</p>
        <h3>Month by month ({yearFrom}–{yearTo}, {stationName(source)})</h3>
        <table className="t"><thead><tr><th>month</th><th>n</th><th>3 km: mean, from</th><th>12 km: mean, from</th><th>20 km: mean, from</th><th>28 km: mean, from</th></tr></thead><tbody>
          {perMonth.map(m => <tr key={m.name}><td>{m.name}</td><td>{m.n}</td>{m.s.map(s => <td key={s.z}>{s.n ? `${s.meanSpeed.toFixed(1)} m/s ${compass(s.meanFromDeg)}` : "–"}</td>)}</tr>)}
        </tbody></table>
        {gfsVsIgra && <><h3>Model check: GFS column at Jejuri (05Z) vs this station's 00Z radiosonde, same days</h3>
          {gfsVsIgra.rows.length ? <><table className="t"><thead><tr><th>altitude</th><th>vector RMS diff m/s</th><th>mean vector bias m/s</th><th>mean measured speed m/s</th></tr></thead><tbody>
            {gfsVsIgra.rows.map(r => <tr key={r.z}><td>{(r.z / 1000).toFixed(0)} km</td><td>{r.rms.toFixed(1)}</td><td>{r.bias.toFixed(1)}</td><td>{r.meanSpd.toFixed(1)}</td></tr>)}</tbody></table>
            <p className="note">{gfsVsIgra.n} paired days. This mixes a 5-hour time difference and the station-to-pad distance ({source === "INM00043063" ? "43 km for Pune" : "over 100 km for this station, so expect larger differences"}) with true model error, so it is an upper bound on the wind error the predictor inherits from the model.</p></> : <p className="note">Fewer than 5 paired days in this selection.</p>}</>}
        {landings && landings.length > 0 && <>
          <h2>Where this vehicle would have landed, one dot per real atmosphere</h2>
          <PlanView track={[]} trackSplit={0} extra={[{ name: "landing", color: "var(--series-3)", pts: landings.map(l => [l.eastM / 1000, l.northM / 1000] as [number, number]) }]} tooltip={(x, y) => { const l = landings.find(q => Math.abs(q.eastM / 1000 - x) < 1e-6 && Math.abs(q.northM / 1000 - y) < 1e-6); return l ? <span>{l.label}: {km(l.rangeM)} km {compass(l.bearingDeg)}</span> : null; }} />
          <Histogram values={ranges} binW={5} xLabel="landing range, km" marks={[{ x: pct(0.5), label: "median" }, { x: pct(0.95), label: "95%" }]} />
          <p className="note">Range distribution: median {pct(0.5).toFixed(1)} km, 95th percentile {pct(0.95).toFixed(1)} km ({nm(pct(0.95) * 1000)} NM), worst {Math.max(...ranges).toFixed(1)} km over {landings.length} measured atmospheres.</p>
        </>}
      </div>
    </div>
  </div>;
}
