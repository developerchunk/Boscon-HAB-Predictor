/**
 * Saved predictions. One self-contained record per prediction, stored in the browser's IndexedDB
 * (two object stores: "meta" for the list, "blobs" for the full record) and exportable as a
 * `.habpred.json` file. The record holds everything needed to restore every tab: inputs,
 * settings, the wind grid (columns, times, label), the nominal flight, Monte Carlo, Tawhiri,
 * hourly sweep, temperature/humidity columns, landing-zone weather, plus the burst-calculator,
 * climatology and 3-D view state. Format version 1.
 */
export const SAVED_FORMAT = "boscon-hab-prediction";
export const SAVED_VERSION = 1;
export const SAVED_EXT = ".habpred.json";

export interface SavedMeta {
  id: string; name: string; savedAt: string;
  launchUtc: string; padLat: number; padLon: number; padAltM: number; place?: string;
  model: string; landingLat?: number; landingLon?: number; rangeM?: number; bearingDeg?: number; durationS?: number; burstAltM?: number;
  bytes: number;
}
export interface SavedPrediction {
  format: typeof SAVED_FORMAT; version: number;
  meta: SavedMeta;
  inputs: any; settings: any;
  results: any | null;
  burstCalc?: any; climatology?: any; flight3d?: any;
}

const DB = "boscon-hab-predictor", VER = 1;
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" }); if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode); let out: T | undefined;
    const r = fn(t); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out as T); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}

export async function listSaved(): Promise<SavedMeta[]> {
  const db = await openDb();
  const all = await tx<SavedMeta[]>(db, ["meta"], "readonly", t => t.objectStore("meta").getAll());
  db.close();
  return (all ?? []).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
export async function putSaved(rec: SavedPrediction): Promise<void> {
  const text = JSON.stringify(rec); rec.meta.bytes = text.length;
  const db = await openDb();
  await tx(db, ["meta", "blobs"], "readwrite", t => { t.objectStore("meta").put(rec.meta); t.objectStore("blobs").put({ id: rec.meta.id, text }); });
  db.close();
}
export async function getSaved(id: string): Promise<SavedPrediction | null> {
  const db = await openDb();
  const row = await tx<{ id: string; text: string } | undefined>(db, ["blobs"], "readonly", t => t.objectStore("blobs").get(id));
  db.close();
  return row ? (JSON.parse(row.text) as SavedPrediction) : null;
}
export async function deleteSaved(id: string): Promise<void> {
  const db = await openDb();
  await tx(db, ["meta", "blobs"], "readwrite", t => { t.objectStore("meta").delete(id); t.objectStore("blobs").delete(id); });
  db.close();
}
export async function renameSaved(id: string, name: string): Promise<void> {
  const db = await openDb();
  const meta = await tx<SavedMeta | undefined>(db, ["meta"], "readonly", t => t.objectStore("meta").get(id));
  const row = await tx<{ id: string; text: string } | undefined>(db, ["blobs"], "readonly", t => t.objectStore("blobs").get(id));
  if (meta && row) {
    meta.name = name;
    const rec = JSON.parse(row.text) as SavedPrediction; rec.meta.name = name;
    const text = JSON.stringify(rec);
    await tx(db, ["meta", "blobs"], "readwrite", t => { t.objectStore("meta").put(meta); t.objectStore("blobs").put({ id, text }); });
  }
  db.close();
}
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try { const e = await navigator.storage?.estimate?.(); return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null; } catch { return null; }
}

/** Parse and validate a file's text. Throws with a readable message on anything unexpected. */
export function parseSavedFile(text: string): SavedPrediction {
  let rec: any;
  try { rec = JSON.parse(text); } catch { throw new Error("not a JSON file"); }
  if (rec?.format !== SAVED_FORMAT) throw new Error(`not a ${SAVED_EXT} prediction file (format field missing)`);
  if (typeof rec.version !== "number" || rec.version > SAVED_VERSION) throw new Error(`file version ${rec.version} is newer than this app understands (${SAVED_VERSION})`);
  if (!rec.meta?.id || !rec.inputs) throw new Error("file is missing its meta or inputs");
  return rec as SavedPrediction;
}
/** "17.722, 75.842 · 2026-09-23 11:00 IST · NOAA GFS (0.25°…)" → "17.722-75.842-2026-09-23-11-00-IST-NOAA-GFS-0.25" */
export function safeFileName(name: string): string {
  const s = name.normalize("NFKD").replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").replace(/\.+$/, "");
  return (s || "prediction").slice(0, 80).replace(/-+$/, "");
}
export function downloadSaved(rec: SavedPrediction): void {
  const text = JSON.stringify(rec);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `${safeFileName(rec.meta.name)}${SAVED_EXT}`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export const newId = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} kB`);
