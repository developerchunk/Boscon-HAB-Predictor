import { useEffect, useRef, useState } from "react";
import { listSaved, getSaved, deleteSaved, renameSaved, putSaved, parseSavedFile, downloadSaved, storageEstimate, fmtBytes, SAVED_EXT, type SavedMeta, type SavedPrediction } from "../data/store";
import { istString, km, compass } from "./format";
import { MODEL_LABEL, type ModelId } from "../data/openmeteo";

export function SavedPanel(p: { version: number; currentId: string | null; onLoad: (rec: SavedPrediction) => void; onSaveCurrent: (name: string) => Promise<string | null>; hasCurrent: boolean; suggestedName: string }) {
  const [rows, setRows] = useState<SavedMeta[]>([]);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [name, setName] = useState(p.suggestedName);
  const file = useRef<HTMLInputElement>(null);
  const refresh = async () => { setRows(await listSaved()); setEst(await storageEstimate()); };
  useEffect(() => { refresh(); }, [p.version]);
  useEffect(() => { setName(p.suggestedName); }, [p.suggestedName]);

  async function onImport(f: File) {
    try {
      const rec = parseSavedFile(await f.text());
      const existing = rows.find(r => r.id === rec.meta.id);
      if (existing) { rec.meta.id = rec.meta.id + "_" + Date.now().toString(36); rec.meta.name = rec.meta.name + " (imported)"; }
      await putSaved(rec); await refresh(); p.onLoad(rec); setMsg(`Imported and loaded "${rec.meta.name}".`);
    } catch (e: any) { setMsg(`Import failed: ${e.message ?? e}`); }
  }
  return <div className="page">
    <h2>Saved predictions</h2>
    <p className="note">Every completed prediction is saved here automatically, in this browser (IndexedDB), with everything needed to bring back all tabs: inputs, settings, the wind grid, flight, Monte Carlo, Tawhiri, weather, the burst-calculator and climatology state and the 3-D view. Download gives a <code>{SAVED_EXT}</code> file you can keep, share or import on another machine. {est ? `Storage used by this site: ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)} available.` : ""}</p>
    <div className="card" style={{ margin: "8px 0" }}>
      <div className="row">
        <input value={name} onChange={e => setName(e.target.value)} style={{ minWidth: 320 }} placeholder="name for the current prediction" />
        <button className="primary" disabled={!p.hasCurrent} onClick={async () => { const id = await p.onSaveCurrent(name.trim() || p.suggestedName); setMsg(id ? "Saved." : "Nothing to save yet — run a prediction first."); await refresh(); }}>Save current prediction</button>
        <button className="secondary" onClick={() => file.current?.click()}>Import {SAVED_EXT} file…</button>
        <input ref={file} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; }} />
        <span className="status">{msg}</span>
      </div>
    </div>
    {rows.length === 0 ? <p className="note">No saved predictions yet.</p> : <table className="t"><thead><tr><th>name</th><th>saved</th><th>launch (IST)</th><th>pad</th><th>source</th><th>landing</th><th>size</th><th></th></tr></thead><tbody>
      {rows.map(r => <tr key={r.id} style={r.id === p.currentId ? { fontWeight: 600 } : undefined}>
        <td><input defaultValue={r.name} style={{ width: 260 }} onBlur={async e => { const v = e.target.value.trim(); if (v && v !== r.name) { await renameSaved(r.id, v); await refresh(); } }} /></td>
        <td>{istString(new Date(r.savedAt))}</td>
        <td>{istString(new Date(r.launchUtc))}</td>
        <td>{r.place ? r.place + " · " : ""}{r.padLat.toFixed(4)}, {r.padLon.toFixed(4)}, {Math.round(r.padAltM)} m</td>
        <td style={{ maxWidth: 220 }}>{(MODEL_LABEL[r.model as ModelId] ?? r.model).split(" — ")[0].replace(" via Open-Meteo", "")}</td>
        <td>{r.rangeM != null ? `${km(r.rangeM)} km ${compass(r.bearingDeg ?? 0)} · burst ${((r.burstAltM ?? 0) / 1000).toFixed(1)} km` : "–"}</td>
        <td>{fmtBytes(r.bytes)}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <button className="secondary" onClick={async () => { const rec = await getSaved(r.id); if (rec) { p.onLoad(rec); setMsg(`Loaded "${rec.meta.name}".`); } }}>Load</button>{" "}
          <button className="secondary" onClick={async () => { const rec = await getSaved(r.id); if (rec) downloadSaved(rec); }}>Download</button>{" "}
          <button className="secondary" onClick={async () => { if (confirm(`Delete "${r.name}" from this browser? A downloaded file is not affected.`)) { await deleteSaved(r.id); await refresh(); setMsg("Deleted."); } }}>Delete</button>
        </td>
      </tr>)}
    </tbody></table>}
  </div>;
}
