/// <reference lib="webworker" />
/**
 * Web worker: Monte Carlo and climatology flights off the main thread.
 * Messages: { type: "mc", id, timesS, columns, label, cfg, mc, groundAltM }
 *           { type: "climatology", id, profiles: {z[],u[],v[],label,col?}[], cfg, dtS }
 */
import { GridWindField, ProfileWindField } from "./wind";
import { runMonteCarlo } from "./montecarlo";
import { flyTrajectory, type FlightConfig } from "./trajectory";
import { Column } from "./atmosphere";

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === "mc") {
      const field = new GridWindField(m.timesS, m.columns, m.label);
      const cfg: FlightConfig = { ...m.cfg, groundAltAt: () => m.groundAltM };
      let last = 0;
      const res = runMonteCarlo(field, cfg, m.mc, i => { if (i - last >= 25) { last = i; (self as any).postMessage({ type: "progress", id: m.id, i }); } });
      (self as any).postMessage({ type: "mc", id: m.id, result: res });
    } else if (m.type === "climatology") {
      const out: any[] = [];
      for (const p of m.profiles) {
        const col = p.col ? new Column(p.col) : undefined;
        const f = new ProfileWindField(p.z, p.u, p.v, p.label, col);
        try {
          const r = flyTrajectory(f, { ...m.cfg, groundAltAt: () => m.cfg.launchAltM, dtS: m.dtS });
          out.push({ label: p.label, date: p.date, station: p.station, lat: r.landing.lat, lon: r.landing.lon, rangeM: r.rangeM, bearingDeg: r.bearingDeg, eastM: r.eastM, northM: r.northM, durationS: r.durationS, burstZ: r.burst.z, clipped: r.windClipped, layers: r.layers });
        } catch (e) { out.push({ label: p.label, date: p.date, station: p.station, error: String(e) }); }
      }
      (self as any).postMessage({ type: "climatology", id: m.id, results: out });
    }
  } catch (e) {
    (self as any).postMessage({ type: "error", id: m.id, error: String(e) });
  }
};
