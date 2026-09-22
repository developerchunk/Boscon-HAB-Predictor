import { useEffect, useMemo, useState } from "react";
import { deleteArchiveLocation, deleteArchiveMonth, deleteDatabase, deleteSaved, fmtBytes, listArchiveLocations, listArchiveMonths, listSaved, storageEstimate, type ArchiveLoc, type SavedMeta } from "../data/store";
import { cacheEntries, clearCache } from "../data/openmeteo";
import { clearTileCache, tileCacheStats } from "../data/terrainrgb";
import { archiveDownloader } from "../data/archive";
import { istString } from "./format";

/**
 * Everything this site keeps in the browser, with a delete for each item, a multi-select, and a
 * delete-all. Items live in four places: IndexedDB (saved predictions, downloaded GFS archives),
 * localStorage (small settings), this page's memory (Open-Meteo responses, decoded terrain tiles;
 * gone on reload anyway) and the browser's own HTTP cache (map tiles, fonts, the bundled data
 * files), which a page cannot enumerate or clear — only report from the resource timing API.
 */
type Item = { id: string; kind: "pred" | "arch" | "month" | "cache" | "tiles" | "ls"; bytes: number };

export function StoragePanel(p: { currentId: string | null; onPredictionsDeleted: (ids: string[]) => void }) {
  const [preds, setPreds] = useState<SavedMeta[]>([]);
  const [archs, setArchs] = useState<ArchiveLoc[]>([]);
  const [months, setMonths] = useState<Record<string, { ym: string; bytes: number; fetchedAt: string }[]>>({});
  const [openArch, setOpenArch] = useState<Set<string>>(new Set());
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [ps, as, e] = await Promise.all([listSaved(), listArchiveLocations(), storageEstimate()]);
    setPreds(ps); setArchs(as); setEst(e);
    const m: Record<string, { ym: string; bytes: number; fetchedAt: string }[]> = {};
    for (const a of as) m[a.loc] = await listArchiveMonths(a.loc);
    setMonths(m); setTick(t => t + 1);
    const lsKeys = new Set<string>(); try { for (let i = 0; i < localStorage.length; i++) lsKeys.add(`ls:${localStorage.key(i)}`); } catch { /* blocked */ }
    const cacheKeys = new Set(cacheEntries().map(c => `cache:${c.key}`));
    setSel(s => new Set([...s].filter(id => ps.some(x => `pred:${x.id}` === id) || as.some(a => `arch:${a.loc}` === id) || Object.entries(m).some(([loc, ms]) => ms.some(x => `month:${loc}|${x.ym}` === id)) || cacheKeys.has(id) || lsKeys.has(id) || (id === "tiles" && tileCacheStats().count > 0))));
  };
  useEffect(() => { refresh().catch(e => setMsg(String(e))); }, []);
  const cache = useMemo(() => cacheEntries().sort((a, b) => b.bytes - a.bytes), [tick]);
  const tiles = useMemo(() => tileCacheStats(), [tick]);
  const ls = useMemo(() => { const out: { key: string; value: string; bytes: number }[] = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; const v = localStorage.getItem(k) ?? ""; out.push({ key: k, value: v, bytes: (k.length + v.length) * 2 }); } } catch { /* blocked */ } return out; }, [tick]);
  const resources = useMemo(() => {
    const byOrigin = new Map<string, { n: number; transferred: number; fromCache: number }>();
    try {
      for (const r of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
        let origin = "this site"; try { const u = new URL(r.name); origin = u.host.includes("mapbox") ? "Mapbox (tiles, styles, fonts, terrain)" : u.host.includes("open-meteo") ? "Open-Meteo API" : u.host.includes("localhost:8787") ? "NOMADS bridge (local)" : u.host === location.host ? "this site (code and bundled data)" : u.host; } catch { /* ignore */ }
        const e = byOrigin.get(origin) ?? { n: 0, transferred: 0, fromCache: 0 };
        e.n++; e.transferred += r.transferSize || 0; if (!r.transferSize && r.decodedBodySize) e.fromCache++;
        byOrigin.set(origin, e);
      }
    } catch { /* ignore */ }
    return [...byOrigin.entries()].sort((a, b) => b[1].transferred - a[1].transferred);
  }, [tick]);

  const items: Item[] = useMemo(() => [
    ...preds.map(x => ({ id: `pred:${x.id}`, kind: "pred" as const, bytes: x.bytes })),
    ...archs.map(a => ({ id: `arch:${a.loc}`, kind: "arch" as const, bytes: a.bytes })),
    ...Object.entries(months).flatMap(([loc, ms]) => ms.map(m => ({ id: `month:${loc}|${m.ym}`, kind: "month" as const, bytes: m.bytes }))),
    ...cache.map(c => ({ id: `cache:${c.key}`, kind: "cache" as const, bytes: c.bytes })),
    ...(tiles.count ? [{ id: "tiles", kind: "tiles" as const, bytes: tiles.bytes }] : []),
    ...ls.map(l => ({ id: `ls:${l.key}`, kind: "ls" as const, bytes: l.bytes })),
  ], [preds, archs, months, cache, tiles, ls]);
  const totals = { preds: preds.reduce((s, x) => s + x.bytes, 0), archs: archs.reduce((s, a) => s + a.bytes, 0), cache: cache.reduce((s, c) => s + c.bytes, 0), ls: ls.reduce((s, l) => s + l.bytes, 0) };
  const selBytes = items.filter(i => sel.has(i.id)).reduce((s, i) => s + i.bytes, 0);
  const toggle = (id: string, on: boolean) => setSel(s => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const running = archiveDownloader.getState().running;

  async function deleteItems(ids: string[]) {
    setBusy(true);
    try {
      const predIds: string[] = [];
      const archLocs = ids.filter(i => i.startsWith("arch:")).map(i => i.slice(5));
      for (const id of ids) {
        if (id.startsWith("pred:")) { await deleteSaved(id.slice(5)); predIds.push(id.slice(5)); }
        else if (id.startsWith("arch:")) await deleteArchiveLocation(id.slice(5));
        else if (id.startsWith("month:")) { const [loc, ym] = id.slice(6).split("|"); if (!archLocs.includes(loc)) await deleteArchiveMonth(loc, ym); }
        else if (id.startsWith("cache:")) clearCache([id.slice(6)]);
        else if (id === "tiles") clearTileCache();
        else if (id.startsWith("ls:")) { try { localStorage.removeItem(id.slice(3)); } catch { /* ignore */ } }
      }
      if (predIds.length) p.onPredictionsDeleted(predIds);
      setMsg(`Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}.`);
    } catch (e: any) { setMsg("Delete failed: " + String(e?.message ?? e)); }
    finally { setBusy(false); await refresh(); }
  }
  async function deleteEverything() {
    if (!confirm(`Delete everything this site stores in this browser: ${preds.length} saved prediction${preds.length === 1 ? "" : "s"} (${fmtBytes(totals.preds)}), ${archs.length} downloaded archive${archs.length === 1 ? "" : "s"} (${fmtBytes(totals.archs)}), settings and in-memory caches? Downloaded .habpred.json files on disk are not affected.`)) return;
    setBusy(true);
    try {
      const ids = preds.map(x => x.id);
      await deleteDatabase();
      clearCache(); clearTileCache();
      try { localStorage.clear(); } catch { /* ignore */ }
      try { if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
      if (ids.length) p.onPredictionsDeleted(ids);
      setMsg("Everything deleted. The browser's own HTTP cache (map tiles, fonts) is cleared from the browser's settings, not from here.");
    } catch (e: any) { setMsg("Delete failed: " + String(e?.message ?? e)); }
    finally { setBusy(false); setSel(new Set()); await refresh(); }
  }

  const cb = (id: string) => <input type="checkbox" checked={sel.has(id)} onChange={e => toggle(id, e.target.checked)} />;
  const del = (id: string, label = "Delete", disabled = false) => <button className="secondary" disabled={busy || disabled} onClick={() => { if (confirm(`${label} this item?`)) deleteItems([id]); }}>{label}</button>;
  return <div className="page">
    <h2>Storage</h2>
    <p className="note">Everything this site keeps in this browser, and where. IndexedDB holds the saved predictions and downloaded GFS archives (they survive reloads); localStorage holds small settings; this page's memory holds Open-Meteo responses and decoded terrain tiles until the tab is closed. The browser's own HTTP cache (map tiles, fonts, the two bundled data files, about 11.5 MB) is managed by the browser and can only be cleared from its settings; the last table reports what was loaded this session.</p>
    <div className="kv" style={{ maxWidth: 560 }}>
      <span className="k">browser estimate for this site</span><span className="v">{est ? `${fmtBytes(est.usage)} used of ${fmtBytes(est.quota)} available` : "not available"}</span>
      <span className="k">saved predictions</span><span className="v">{preds.length} · {fmtBytes(totals.preds)}</span>
      <span className="k">downloaded GFS archives</span><span className="v">{archs.length} · {fmtBytes(totals.archs)}</span>
      <span className="k">settings (localStorage)</span><span className="v">{ls.length} · {fmtBytes(totals.ls)}</span>
      <span className="k">in memory, this page load</span><span className="v">{cache.length} responses · {fmtBytes(totals.cache)}; {tiles.count} tiles · {fmtBytes(tiles.bytes)}</span>
    </div>
    <div className="row" style={{ margin: "10px 0" }}>
      <button className="secondary" disabled={busy || !items.length} onClick={() => setSel(new Set(items.map(i => i.id)))}>Select all</button>
      <button className="secondary" disabled={busy || !sel.size} onClick={() => setSel(new Set())}>Clear selection</button>
      <button className="primary" disabled={busy || !sel.size || running} onClick={() => { if (confirm(`Delete the ${sel.size} selected item${sel.size === 1 ? "" : "s"} (${fmtBytes(selBytes)})?`)) deleteItems([...sel]); }}>Delete selected ({sel.size}, {fmtBytes(selBytes)})</button>
      <button className="secondary" disabled={busy || running} onClick={deleteEverything} style={{ borderColor: "var(--bad-border)" }}>Delete everything</button>
      <button className="secondary" disabled={busy} onClick={() => refresh()}>Refresh</button>
      <span className="status">{running ? "an archive download is running — finish or cancel it in the Climatology tab before deleting" : msg}</span>
    </div>

    <h3>Saved predictions ({preds.length}, {fmtBytes(totals.preds)})</h3>
    {preds.length ? <table className="t"><thead><tr><th /><th>name</th><th>saved</th><th>launch (IST)</th><th>size</th><th /></tr></thead><tbody>
      {preds.map(x => <tr key={x.id}><td>{cb(`pred:${x.id}`)}</td><td>{x.name}{x.id === p.currentId ? " (loaded now)" : ""}</td><td>{istString(new Date(x.savedAt))}</td><td>{istString(new Date(x.launchUtc))}</td><td>{fmtBytes(x.bytes)}</td><td>{del(`pred:${x.id}`)}</td></tr>)}
    </tbody></table> : <p className="note">none</p>}

    <h3>Downloaded GFS archives ({archs.length}, {fmtBytes(totals.archs)})</h3>
    {archs.length ? <table className="t"><thead><tr><th /><th>archive</th><th>point</th><th>months</th><th>size</th><th /></tr></thead><tbody>
      {archs.flatMap(a => [
        <tr key={a.loc}><td>{cb(`arch:${a.loc}`)}</td><td><button className="secondary" style={{ padding: "2px 8px" }} onClick={() => setOpenArch(s => { const n = new Set(s); if (n.has(a.loc)) n.delete(a.loc); else n.add(a.loc); return n; })}>{openArch.has(a.loc) ? "▾" : "▸"}</button> {a.name}</td><td>{a.loc}</td><td>{a.months[0]} – {a.months[a.months.length - 1]} ({a.months.length})</td><td>{fmtBytes(a.bytes)}</td><td>{del(`arch:${a.loc}`, "Delete", running)}</td></tr>,
        ...(openArch.has(a.loc) ? (months[a.loc] ?? []).map(m => <tr key={`${a.loc}|${m.ym}`} style={{ color: "var(--text-2)" }}><td>{cb(`month:${a.loc}|${m.ym}`)}</td><td style={{ paddingLeft: 36 }}>{m.ym}</td><td /><td>fetched {istString(new Date(m.fetchedAt))}</td><td>{fmtBytes(m.bytes)}</td><td>{del(`month:${a.loc}|${m.ym}`, "Delete", running)}</td></tr>) : []),
      ])}
    </tbody></table> : <p className="note">none</p>}

    <h3>In memory, this page load ({cache.length} responses, {fmtBytes(totals.cache)}; {tiles.count} terrain tiles, {fmtBytes(tiles.bytes)})</h3>
    <p className="note">Open-Meteo responses are kept so a re-run within their lifetime (grid and ensemble 30 min, elevation and archive months 24 h) costs no quota; decoded Terrain-RGB tiles serve the landing height and the 3-D terrain. Both vanish when the tab is closed.</p>
    {cache.length || tiles.count ? <table className="t"><thead><tr><th /><th>entry</th><th>age</th><th>size</th><th /></tr></thead><tbody>
      {tiles.count > 0 && <tr><td>{cb("tiles")}</td><td>{tiles.count} decoded terrain tiles (256 × 256 px each)</td><td /><td>{fmtBytes(tiles.bytes)}</td><td>{del("tiles", "Clear")}</td></tr>}
      {cache.map(c => <tr key={c.key}><td>{cb(`cache:${c.key}`)}</td><td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{c.key}</td><td>{Math.round((Date.now() - c.at) / 60000)} min</td><td>{fmtBytes(c.bytes)}</td><td>{del(`cache:${c.key}`, "Forget")}</td></tr>)}
    </tbody></table> : <p className="note">empty</p>}

    <h3>Settings (localStorage, {ls.length}, {fmtBytes(totals.ls)})</h3>
    {ls.length ? <table className="t"><thead><tr><th /><th>key</th><th>value</th><th>size</th><th /></tr></thead><tbody>
      {ls.map(l => <tr key={l.key}><td>{cb(`ls:${l.key}`)}</td><td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{l.key}</td><td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{l.value.length > 60 ? l.value.slice(0, 60) + "…" : l.value}</td><td>{fmtBytes(l.bytes)}</td><td>{del(`ls:${l.key}`)}</td></tr>)}
    </tbody></table> : <p className="note">none</p>}

    <h3>Loaded this session (browser HTTP cache — report only)</h3>
    {resources.length ? <table className="t"><thead><tr><th>origin</th><th>requests</th><th>transferred</th><th>served from the browser cache</th></tr></thead><tbody>
      {resources.map(([o, r]) => <tr key={o}><td>{o}</td><td>{r.n}</td><td>{fmtBytes(r.transferred)}</td><td>{r.fromCache}</td></tr>)}
    </tbody></table> : <p className="note">nothing recorded</p>}
    <p className="note">Transferred bytes are what the network delivered this page load; a request served from the browser's cache transfers 0 bytes. An origin that shows 0 B for every request (Open-Meteo, SondeHub) does not let pages read its sizes (no Timing-Allow-Origin header) — the data still arrived. The browser keeps these under its own rules; clear them from the browser's site-data settings.</p>
  </div>;
}
