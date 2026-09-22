import { useEffect, useMemo, useState } from "react";
import { BALLOONS, balloonById, simulateAscent, neckLiftForAscentRate, cusfBurstCalc, type Gas, type CdModel } from "../physics/balloon";
import { isa } from "../physics/atmosphere";
import { terminalVelocity } from "../physics/descent";
import { RHO_SL } from "../physics/constants";
import { LineChart } from "./charts";
import { ft, fl } from "./format";

export interface BurstCalcSnapshot { balloonId: string; gas: Gas; payload: number; mode: "ascentRate" | "neckLift"; target: number; neck: number; siteAlt: number; chuteD: number; chuteCd: number; factor: number }
export function BurstCalcPanel(p: { siteAltM: number; initial?: BurstCalcSnapshot; onSnapshot?: (s: BurstCalcSnapshot) => void }) {
  const i = p.initial;
  const [balloonId, setBalloon] = useState(i?.balloonId ?? "k1200");
  const [gas, setGas] = useState<Gas>(i?.gas ?? "hydrogen");
  const [payload, setPayload] = useState(i?.payload ?? 2.0);
  const [mode, setMode] = useState<"ascentRate" | "neckLift">(i?.mode ?? "ascentRate");
  const [target, setTarget] = useState(i?.target ?? 5.0);
  const [neck, setNeck] = useState(i?.neck ?? 3.2);
  const [siteAlt, setSiteAlt] = useState(i?.siteAlt ?? p.siteAltM);
  const [chuteD, setChuteD] = useState(i?.chuteD ?? 1.2);
  const [chuteCd, setChuteCd] = useState(i?.chuteCd ?? 0.75);
  const [factor, setFactor] = useState(i?.factor ?? 1.0);
  useEffect(() => { p.onSnapshot?.({ balloonId, gas, payload, mode, target, neck, siteAlt, chuteD, chuteCd, factor }); }, [balloonId, gas, payload, mode, target, neck, siteAlt, chuteD, chuteCd, factor]);

  type Calc = { error: string } | { b: ReturnType<typeof balloonById>; nl: number; pad: number; runs: { id: CdModel; name: string; run: ReturnType<typeof simulateAscent> }[]; cusf: ReturnType<typeof cusfBurstCalc>; desc: { massKg: number; chuteDiameterM: number; cd: number }; sens: { f: number; nl: number; pad: number; burst: number; t: number }[]; sensD: { fd: number; d: number; burst: number; t: number }[]; vSL: number; vSite: number; vBurst: number };
  const calc = useMemo((): Calc | null => {
    const b = balloonById(balloonId);
    const base = { balloonMassKg: b.massG / 1000, payloadKg: payload, gas, burstDiameterM: b.burstDiameterM * factor, cdModel: "constant" as CdModel, cdConstant: b.cdCusf, launchAltM: siteAlt, atmosphere: { state: isa } };
    let nl: number;
    try { nl = mode === "ascentRate" ? neckLiftForAscentRate(base, target) : neck; } catch { return null; }
    if (nl <= payload) return { error: "Neck lift is below the payload mass — it will not lift off." };
    const pad = simulateAscent({ ...base, neckLiftKg: nl, maxAltM: siteAlt + 100 }).track[0].v;
    const models: { id: CdModel; name: string }[] = [{ id: "gallice", name: "Gallice 2011 Cd(Re), anchored to pad rate (default)" }, { id: "constant", name: `constant Cd ${b.cdCusf} (CUSF / rho^-1/6)` }, { id: "astra", name: "ASTRA Cd(Re), anchored" }];
    const runs = models.map(mo => ({ ...mo, run: simulateAscent({ ...base, neckLiftKg: nl, cdModel: mo.id, padAscentMs: pad }) }));
    const cusf = cusfBurstCalc({ balloonMassKg: b.massG / 1000, payloadKg: payload, gas, burstDiameterM: b.burstDiameterM * factor, cd: b.cdCusf, targetAscentMs: pad });
    const desc = { massKg: payload, chuteDiameterM: chuteD, cd: chuteCd };
    const sens = [-0.1, -0.05, 0, 0.05, 0.1].map(f => { const rr = simulateAscent({ ...base, neckLiftKg: nl * (1 + f), cdModel: "gallice", padAscentMs: undefined }); return { f, nl: nl * (1 + f), pad: rr.track[0].v, burst: rr.burstAltM, t: rr.burstTimeS / 60 }; });
    const sensD = [0.9, 0.95, 1.0, 1.05, 1.1].map(fd => { const rr = simulateAscent({ ...base, burstDiameterM: b.burstDiameterM * fd, neckLiftKg: nl, cdModel: "gallice", padAscentMs: pad }); return { fd, d: b.burstDiameterM * fd, burst: rr.burstAltM, t: rr.burstTimeS / 60 }; });
    return { b, nl, pad, runs, cusf, desc, sens, sensD, vSL: terminalVelocity(RHO_SL, desc), vSite: terminalVelocity(isa(siteAlt).rho, desc), vBurst: terminalVelocity(isa(runs[0].run.burstAltM).rho, desc) };
  }, [balloonId, gas, payload, mode, target, neck, siteAlt, chuteD, chuteCd, factor]);
  const errorMsg = calc && "error" in calc ? calc.error : null;
  const r = calc && !("error" in calc) ? calc : null;
  const main = r ? r.runs[0].run : null;
  return <div className="page">
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 24 }}>
      <div>
        <h2>Balloon &amp; fill</h2>
        <div className="field"><label>Balloon</label><select value={balloonId} onChange={e => setBalloon(e.target.value)}>{BALLOONS.map(b => <option key={b.id} value={b.id}>{b.maker} {b.massG} g — burst {b.burstDiameterM} m</option>)}</select></div>
        <div className="field"><label>Gas</label><select value={gas} onChange={e => setGas(e.target.value as Gas)}><option value="hydrogen">Hydrogen</option><option value="helium">Helium</option></select></div>
        <div className="field"><label>Mass under balloon <span className="unit">kg</span></label><input type="number" step="0.05" value={payload} onChange={e => setPayload(+e.target.value)} /></div>
        <div className="field"><label>Site elevation <span className="unit">m AMSL</span></label><input type="number" step="1" value={siteAlt} onChange={e => setSiteAlt(+e.target.value)} /></div>
        <div className="field"><label>Specify</label><select value={mode} onChange={e => setMode(e.target.value as any)}><option value="ascentRate">target ascent rate at pad</option><option value="neckLift">neck lift (spring scale)</option></select></div>
        {mode === "ascentRate" ? <div className="field"><label>Target ascent rate <span className="unit">m/s</span></label><input type="number" step="0.1" value={target} onChange={e => setTarget(+e.target.value)} /></div>
          : <div className="field"><label>Neck lift <span className="unit">kg</span></label><input type="number" step="0.05" value={neck} onChange={e => setNeck(+e.target.value)} /></div>}
        <div className="field"><label>Burst diameter × <span className="unit">(1 = maker nominal)</span></label><input type="number" step="0.01" value={factor} onChange={e => setFactor(+e.target.value)} /></div>
        <h2>Parachute</h2>
        <div className="field"><label>Canopy constructed diameter <span className="unit">m</span></label><input type="number" step="0.05" value={chuteD} onChange={e => setChuteD(+e.target.value)} /></div>
        <div className="field"><label>Cd (on constructed area)</label><input type="number" step="0.05" value={chuteCd} onChange={e => setChuteCd(+e.target.value)} /></div>
        <p className="note">Knacke (NWC TP 6575) Cd on nominal area: flat circular 0.75–0.80, hemispherical 0.62–0.77, cross 0.60–0.85. The repo's earlier figure of 4.8 m/s used Cd = 1.5 on a 1.2 m circle, which is a projected-area coefficient; on a constructed-diameter basis the same canopy gives ~6.6 m/s at sea level. Measure it on the first test flight.</p>
      </div>
      <div>
        {errorMsg && <div className="bad">{errorMsg}</div>}
        {main && r && <>
          <h2>Result — physical model (USSA76 atmosphere from site elevation)</h2>
          <div className="kv">
            <span className="k">Neck lift to measure at the pad</span><span className="v big">{(r.nl * 1000).toFixed(0)} g</span>
            <span className="k">Free lift (neck lift − mass under balloon)</span><span className="v">{(main.freeLiftKg * 1000).toFixed(0)} g</span>
            <span className="k">Gas at pad conditions</span><span className="v">{main.launchVolumeM3.toFixed(2)} m³ = {main.gasKg.toFixed(3)} kg {gas}, Ø {main.launchDiameterM.toFixed(2)} m</span>
            <span className="k">Ascent rate at pad</span><span className="v">{r.pad.toFixed(2)} m/s</span>
            <span className="k">Burst altitude (diameter {r.b.burstDiameterM * factor} m reached)</span><span className="v big">{main.burstAltM.toFixed(0)} m — {ft(main.burstAltM)} ft — {fl(main.burstAltM)}</span>
            <span className="k">Time to burst (Gallice Cd(Re) profile)</span><span className="v">{(main.burstTimeS / 60).toFixed(0)} min, mean {main.meanAscentMs.toFixed(2)} m/s</span>
            <span className="k">Time to burst (constant Cd, ρ^-1/6 profile)</span><span className="v">{(r.runs[1].run.burstTimeS / 60).toFixed(0)} min, mean {r.runs[1].run.meanAscentMs.toFixed(2)} m/s</span>
            <span className="k">Descent: sea level / site / at burst</span><span className="v">{r.vSL.toFixed(1)} / {r.vSite.toFixed(1)} / {r.vBurst.toFixed(0)} m/s</span>
          </div>
          <h2>CUSF / SondeHub calculator, same inputs</h2>
          <div className="kv">
            <span className="k">Neck lift</span><span className="v">{r.cusf.neckLiftG.toFixed(0)} g</span>
            <span className="k">Burst altitude</span><span className="v">{r.cusf.burstAltitudeM.toFixed(0)} m</span>
            <span className="k">Time to burst</span><span className="v">{r.cusf.timeToBurstMin.toFixed(0)} min</span>
            <span className="k">Launch volume</span><span className="v">{r.cusf.launchVolumeM3.toFixed(2)} m³</span>
          </div>
          <p className="note">CUSF uses sea-level air density 1.2050 kg/m³ whatever the site elevation, an exponential atmosphere with 7238.3 m scale height, and a constant ascent rate. At a 744 m pad the air is 7% thinner, so the same neck lift needs more gas and the balloon is larger at launch; the ISA-integrated burst altitude also differs from the exponential fit by up to ~1 km. Verified: this transcription reproduces sondehub.org/calc to the metre (see tests).</p>
          <h2>Ascent rate versus altitude — the three drag models</h2>
          <div className="legend"><span><span className="sw" style={{ background: "var(--series-1)" }} />Gallice 2011 Cd(Re), TX1200 fit</span><span><span className="sw" style={{ background: "var(--series-2)" }} />constant Cd (ρ^-1/6)</span><span><span className="sw" style={{ background: "var(--series-3)" }} />ASTRA Cd(Re)</span></div>
          <LineChart xLabel="ascent rate, m/s" yLabel="altitude, km" xDomain={[0, Math.max(...r.runs.map(x => Math.max(...x.run.track.map(t => t.v)))) * 1.05]} series={r.runs.map((x, i) => ({ name: x.name, color: ["var(--series-1)", "var(--series-2)", "var(--series-3)"][i], points: x.run.track.map(t => [t.v, t.z / 1000] as [number, number]) }))} yFormat={v => v.toFixed(0)} xFormat={v => v.toFixed(0)} />
          <p className="note">All three are anchored to the same pad ascent rate; only the change with altitude differs. Radiosonde statistics (Seidel et al. 2011: 10 hPa reached at a median 1.71 h; Voggenberger et al. 2024: a constant 5 m/s "sufficient") support the nearly flat Gallice profile, not the doubling that constant Cd predicts. Burst altitude does not depend on this choice; time to burst and therefore drift do.</p>
          <h2>Sensitivity</h2>
          <table className="t"><thead><tr><th>neck lift</th><th>pad rate m/s</th><th>burst m</th><th>time min</th></tr></thead><tbody>
            {r.sens.map(s => <tr key={s.f}><td>{(s.nl * 1000).toFixed(0)} g ({s.f >= 0 ? "+" : ""}{(s.f * 100).toFixed(0)}%)</td><td>{s.pad.toFixed(2)}</td><td>{s.burst.toFixed(0)}</td><td>{s.t.toFixed(0)}</td></tr>)}
          </tbody></table>
          <table className="t" style={{ marginTop: 8 }}><thead><tr><th>burst diameter</th><th>burst m</th><th>time min</th></tr></thead><tbody>
            {r.sensD.map(s => <tr key={s.fd}><td>{s.d.toFixed(2)} m (×{s.fd.toFixed(2)})</td><td>{s.burst.toFixed(0)}</td><td>{s.t.toFixed(0)}</td></tr>)}
          </tbody></table>
          <p className="note">Burst-diameter scatter is the dominant unknown: ASTRA's Weibull fit (k = 14.36) implies ~8.5% 1σ in diameter, i.e. about ±1.5 km in burst altitude, consistent with Gallice's ±1.5 km from drag variability. Real Hwoyee 1200 flights in the UKHAS database burst 0.1–6 km above the Totex-model prediction; Kaymont/Totex flights burst up to 3 km below it. A Pawan CPR-1200 is rated 8.0 m / 31 km at 1 kg payload — roughly 1.5 km lower than a Totex for the same fill.</p>
        </>}
      </div>
    </div>
  </div>;
}
