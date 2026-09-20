/**
 * Small SVG charts, no library. Colours come from CSS tokens so light/dark both work.
 * Every chart: thin marks, one y-axis, recessive grid, direct labels where useful, hover tooltips.
 */
import { useState, type ReactNode } from "react";

export interface Series { name: string; color: string; points: [number, number][]; dashed?: boolean; dots?: boolean }

function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => (hi - lo) / s <= n + 1) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: ReactNode } | null>(null);
  const el = tip ? <div className="tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>{tip.text}</div> : null;
  return { setTip, el };
}

/** Generic x-y line chart. */
export function LineChart(p: { series: Series[]; xLabel: string; yLabel: string; width?: number; height?: number; xDomain?: [number, number]; yDomain?: [number, number]; xFormat?: (v: number) => string; yFormat?: (v: number) => string; markers?: { x: number; y: number; label: string; color: string }[]; vlines?: { x: number; label: string }[]; hlines?: { y: number; label: string }[]; tooltip?: (x: number, y: number, s: Series) => ReactNode; xTicks?: number[] }) {
  const W = p.width ?? 520, H = p.height ?? 260, m = { l: 52, r: 14, t: 12, b: 34 };
  const all = p.series.flatMap(s => s.points).filter(q => Number.isFinite(q[0]) && Number.isFinite(q[1]));
  if (!all.length && !(p.xDomain && p.yDomain)) return <p className="note">no data</p>;
  const xs = all.map(q => q[0]), ys = all.map(q => q[1]);
  const [x0, x1] = p.xDomain ?? [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = p.yDomain ?? [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const sy = (y: number) => H - m.b - ((y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const xf = p.xFormat ?? (v => String(v)), yf = p.yFormat ?? (v => String(v));
  const { setTip, el } = useTooltip();
  return (
    <div style={{ position: "relative" }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setTip(null)}>
        <g className="grid">{niceTicks(y0, y1).map(t => <line key={t} x1={m.l} x2={W - m.r} y1={sy(t)} y2={sy(t)} />)}</g>
        <g className="axis"><line x1={m.l} x2={m.l} y1={m.t} y2={H - m.b} /><line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} /></g>
        {niceTicks(y0, y1).map(t => <text key={"y" + t} x={m.l - 6} y={sy(t) + 4} textAnchor="end">{yf(t)}</text>)}
        {(p.xTicks ?? niceTicks(x0, x1, 6)).map(t => <text key={"x" + t} x={sx(t)} y={H - m.b + 14} textAnchor="middle">{xf(t)}</text>)}
        <text x={(m.l + W - m.r) / 2} y={H - 4} textAnchor="middle">{p.xLabel}</text>
        <text transform={`translate(12 ${(m.t + H - m.b) / 2}) rotate(-90)`} textAnchor="middle">{p.yLabel}</text>
        {p.vlines?.map(v => <g key={"v" + v.x}><line x1={sx(v.x)} x2={sx(v.x)} y1={m.t} y2={H - m.b} stroke="var(--ref)" strokeDasharray="3 3" /><text x={sx(v.x) + 3} y={m.t + 10}>{v.label}</text></g>)}
        {p.hlines?.map(v => <g key={"h" + v.y}><line x1={m.l} x2={W - m.r} y1={sy(v.y)} y2={sy(v.y)} stroke="var(--ref)" strokeDasharray="3 3" /><text x={W - m.r - 3} y={sy(v.y) - 3} textAnchor="end">{v.label}</text></g>)}
        {p.series.map(s => {
          const pts = s.points.filter(q => Number.isFinite(q[0]) && Number.isFinite(q[1]));
          const d = pts.map((q, i) => `${i ? "L" : "M"}${sx(q[0]).toFixed(1)} ${sy(q[1]).toFixed(1)}`).join(" ");
          return <g key={s.name}>
            {!s.dots && <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" />}
            {pts.map((q, i) => <circle key={i} cx={sx(q[0])} cy={sy(q[1])} r={s.dots ? 3 : 6} fill={s.dots ? s.color : "transparent"} stroke={s.dots ? "var(--surface)" : "none"} strokeWidth={1}
              onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: p.tooltip ? p.tooltip(q[0], q[1], s) : <span>{s.name}: {xf(q[0])}, {yf(q[1])}</span> })} />)}
          </g>;
        })}
        {p.markers?.map(mk => <g key={mk.label}><circle cx={sx(mk.x)} cy={sy(mk.y)} r={4.5} fill={mk.color} stroke="var(--surface)" strokeWidth={1.5} /><text x={sx(mk.x) + 7} y={sy(mk.y) + 4}>{mk.label}</text></g>)}
      </svg>
      {el}
    </div>
  );
}

/** Plan view: east/north km scatter with a nominal track, MC points, ellipses and reference points. */
export function PlanView(p: { track: [number, number][]; trackSplit: number; mc?: [number, number][]; ellipses?: [number, number][][]; refs?: { x: number; y: number; label: string; color: string }[]; extra?: { pts: [number, number][]; color: string; name: string }[]; size?: number; tooltip?: (x: number, y: number) => ReactNode }) {
  const S = p.size ?? 420, m = 34;
  const all = [...p.track, ...(p.mc ?? []), ...(p.ellipses ?? []).flat(), ...(p.refs ?? []).map(r => [r.x, r.y] as [number, number]), ...(p.extra ?? []).flatMap(e => e.pts), [0, 0] as [number, number]];
  const ext = Math.max(2, ...all.map(q => Math.max(Math.abs(q[0]), Math.abs(q[1])))) * 1.1;
  const sx = (x: number) => m + ((x + ext) / (2 * ext)) * (S - 2 * m), sy = (y: number) => S - m - ((y + ext) / (2 * ext)) * (S - 2 * m);
  const ticks = niceTicks(-ext, ext, 6);
  const { setTip, el } = useTooltip();
  const path = (pts: [number, number][]) => pts.map((q, i) => `${i ? "L" : "M"}${sx(q[0]).toFixed(1)} ${sy(q[1]).toFixed(1)}`).join(" ");
  return <div style={{ position: "relative" }}>
    <svg className="chart" viewBox={`0 0 ${S} ${S}`} onMouseLeave={() => setTip(null)}>
      <g className="grid">{ticks.map(t => <g key={t}><line x1={sx(t)} x2={sx(t)} y1={m} y2={S - m} /><line x1={m} x2={S - m} y1={sy(t)} y2={sy(t)} /></g>)}</g>
      <line x1={sx(0)} x2={sx(0)} y1={m} y2={S - m} stroke="var(--border)" /><line x1={m} x2={S - m} y1={sy(0)} y2={sy(0)} stroke="var(--border)" />
      {ticks.map(t => <text key={"t" + t} x={sx(t)} y={S - m + 13} textAnchor="middle">{t}</text>)}
      {ticks.map(t => <text key={"u" + t} x={m - 5} y={sy(t) + 4} textAnchor="end">{t}</text>)}
      <text x={S / 2} y={S - 4} textAnchor="middle">east of launch, km</text>
      <text transform={`translate(10 ${S / 2}) rotate(-90)`} textAnchor="middle">north of launch, km</text>
      {p.extra?.map(e => e.pts.map((q, i) => <circle key={e.name + i} cx={sx(q[0])} cy={sy(q[1])} r={2.5} fill={e.color} fillOpacity={0.55} onMouseMove={ev => setTip({ x: ev.clientX, y: ev.clientY, text: p.tooltip ? p.tooltip(q[0], q[1]) : `${e.name}: ${q[0].toFixed(1)}, ${q[1].toFixed(1)} km` })} />))}
      {p.mc?.map((q, i) => <circle key={i} cx={sx(q[0])} cy={sy(q[1])} r={2} fill="var(--series-7)" fillOpacity={0.5} />)}
      {p.ellipses?.filter(e => e.length > 2).map((e, i) => <path key={i} d={path(e) + " Z"} fill="none" stroke="var(--series-7)" strokeWidth={i === 0 ? 2 : 1.2} strokeDasharray={i === 0 ? undefined : "4 3"} />)}
      {p.track.length > 1 && <path d={path(p.track.slice(0, p.trackSplit + 1))} fill="none" stroke="var(--ascent)" strokeWidth={2.5} />}
      {p.track.length > p.trackSplit + 1 && <path d={path(p.track.slice(p.trackSplit))} fill="none" stroke="var(--descent)" strokeWidth={2.5} />}
      <circle cx={sx(0)} cy={sy(0)} r={5} fill="var(--text)" stroke="var(--surface)" strokeWidth={1.5} />
      {p.refs?.map(r => <g key={r.label}><circle cx={sx(r.x)} cy={sy(r.y)} r={5} fill={r.color} stroke="var(--surface)" strokeWidth={1.5} /><text x={sx(r.x) + 7} y={sy(r.y) + 4}>{r.label}</text></g>)}
    </svg>{el}</div>;
}

/** Horizontal bars per layer: east and north displacement, ascent vs descent. */
export function LayerBars(p: { layers: { zFrom: number; zTo: number; ascentEast: number; ascentNorth: number; descentEast: number; descentNorth: number }[] }) {
  const rows = p.layers.filter(l => Math.abs(l.ascentEast) + Math.abs(l.ascentNorth) + Math.abs(l.descentEast) + Math.abs(l.descentNorth) > 1);
  const W = 520, rowH = 16, m = { l: 74, r: 14, t: 22, b: 26 }, H = m.t + rows.length * rowH + m.b;
  const ext = Math.max(1, ...rows.flatMap(l => [Math.abs(l.ascentEast + l.descentEast), Math.abs(l.ascentNorth + l.descentNorth)])) / 1000 * 1.1;
  const sx = (x: number) => m.l + ((x + ext) / (2 * ext)) * (W - m.l - m.r);
  const ticks = niceTicks(-ext, ext, 6);
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
    <g className="grid">{ticks.map(t => <line key={t} x1={sx(t)} x2={sx(t)} y1={m.t - 4} y2={H - m.b} />)}</g>
    <line x1={sx(0)} x2={sx(0)} y1={m.t - 4} y2={H - m.b} stroke="var(--border)" />
    {ticks.map(t => <text key={"t" + t} x={sx(t)} y={H - m.b + 13} textAnchor="middle">{t}</text>)}
    <text x={(m.l + W - m.r) / 2} y={H - 3} textAnchor="middle">net displacement while in the layer, km (blue = east–west, green = north–south)</text>
    {rows.map((l, i) => {
      const y = m.t + i * rowH, e = (l.ascentEast + l.descentEast) / 1000, n = (l.ascentNorth + l.descentNorth) / 1000;
      return <g key={i}>
        <text x={m.l - 6} y={y + 11} textAnchor="end">{(l.zFrom / 1000).toFixed(0)}–{(l.zTo / 1000).toFixed(0)} km</text>
        <rect x={Math.min(sx(0), sx(e))} y={y + 1} width={Math.abs(sx(e) - sx(0))} height={6} fill="var(--series-1)" rx={2} />
        <rect x={Math.min(sx(0), sx(n))} y={y + 8} width={Math.abs(sx(n) - sx(0))} height={6} fill="var(--series-3)" rx={2} />
      </g>;
    })}
  </svg>;
}

/** Percentile band chart of speed vs altitude (climatology). */
export function BandChart(p: { rows: { z: number; p50: number; p95: number; max: number; mean: number }[]; xLabel: string; refLine?: { name: string; points: [number, number][] } }) {
  const W = 520, H = 320, m = { l: 48, r: 14, t: 10, b: 34 };
  if (!p.rows.length) return <p className="note">no profiles in this selection</p>;
  const zmax = Math.max(...p.rows.map(r => r.z)), xmax = Math.max(1, ...p.rows.map(r => r.max), ...(p.refLine?.points.map(q => q[0]) ?? [])) * 1.05;
  const sx = (x: number) => m.l + (x / xmax) * (W - m.l - m.r), sy = (z: number) => H - m.b - (z / zmax) * (H - m.t - m.b);
  const line = (k: "p50" | "p95" | "max" | "mean") => p.rows.map((r, i) => `${i ? "L" : "M"}${sx(r[k]).toFixed(1)} ${sy(r.z).toFixed(1)}`).join(" ");
  const band = p.rows.map((r, i) => `${i ? "L" : "M"}${sx(0)} ${sy(r.z)}`).join(" ") + " " + [...p.rows].reverse().map(r => `L${sx(r.p95)} ${sy(r.z)}`).join(" ") + " Z";
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
    <g className="grid">{niceTicks(0, xmax, 6).map(t => <line key={t} x1={sx(t)} x2={sx(t)} y1={m.t} y2={H - m.b} />)}</g>
    <g className="axis"><line x1={m.l} x2={m.l} y1={m.t} y2={H - m.b} /><line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} /></g>
    {niceTicks(0, xmax, 6).map(t => <text key={"x" + t} x={sx(t)} y={H - m.b + 14} textAnchor="middle">{t}</text>)}
    {niceTicks(0, zmax / 1000, 6).map(t => <text key={"y" + t} x={m.l - 6} y={sy(t * 1000) + 4} textAnchor="end">{t}</text>)}
    <text x={(m.l + W - m.r) / 2} y={H - 4} textAnchor="middle">{p.xLabel}</text>
    <text transform={`translate(12 ${(m.t + H - m.b) / 2}) rotate(-90)`} textAnchor="middle">altitude, km</text>
    <path d={band} fill="var(--series-1)" fillOpacity={0.15} />
    <path d={line("p50")} fill="none" stroke="var(--series-1)" strokeWidth={2} />
    <path d={line("p95")} fill="none" stroke="var(--series-1)" strokeWidth={1.2} strokeDasharray="4 3" />
    <path d={line("max")} fill="none" stroke="var(--series-2)" strokeWidth={1.2} strokeDasharray="2 3" />
    {p.refLine && <path d={p.refLine.points.map((q, i) => `${i ? "L" : "M"}${sx(q[0]).toFixed(1)} ${sy(q[1]).toFixed(1)}`).join(" ")} fill="none" stroke="var(--series-3)" strokeWidth={2} />}
  </svg>;
}

/** Simple histogram. */
export function Histogram(p: { values: number[]; binW: number; xLabel: string; color?: string; marks?: { x: number; label: string }[] }) {
  const W = 520, H = 200, m = { l: 40, r: 14, t: 12, b: 34 };
  if (!p.values.length) return null;
  const max = Math.max(...p.values), nb = Math.ceil(max / p.binW) + 1;
  const bins = new Array(nb).fill(0); for (const v of p.values) bins[Math.min(nb - 1, Math.floor(v / p.binW))]++;
  const ymax = Math.max(...bins);
  const sx = (x: number) => m.l + (x / (nb * p.binW)) * (W - m.l - m.r), sy = (y: number) => H - m.b - (y / ymax) * (H - m.t - m.b);
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
    <g className="axis"><line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} /></g>
    {bins.map((c, i) => <rect key={i} x={sx(i * p.binW) + 1} y={sy(c)} width={Math.max(1, sx(p.binW) - sx(0) - 2)} height={H - m.b - sy(c)} fill={p.color ?? "var(--series-1)"} rx={2} />)}
    {niceTicks(0, nb * p.binW, 8).map(t => <text key={t} x={sx(t)} y={H - m.b + 14} textAnchor="middle">{t}</text>)}
    {niceTicks(0, ymax, 4).map(t => <text key={"y" + t} x={m.l - 5} y={sy(t) + 4} textAnchor="end">{t}</text>)}
    {p.marks?.map(mk => <g key={mk.label}><line x1={sx(mk.x)} x2={sx(mk.x)} y1={m.t} y2={H - m.b} stroke="var(--ref)" strokeDasharray="3 3" /><text x={sx(mk.x) + 3} y={m.t + 10}>{mk.label}</text></g>)}
    <text x={(m.l + W - m.r) / 2} y={H - 4} textAnchor="middle">{p.xLabel}</text>
  </svg>;
}
