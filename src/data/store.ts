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

const DB = "boscon-hab-predictor", VER = 2;
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
      // v2: downloaded GFS archives, one row per location and one row per month of raw hourly data
      if (!db.objectStoreNames.contains("archLocs")) db.createObjectStore("archLocs", { keyPath: "loc" });
      if (!db.objectStoreNames.contains("archMonths")) db.createObjectStore("archMonths", { keyPath: "key" });
    };
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
export const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} kB` : `${Math.round(b)} B`);

/* ------------------------------------------------------------------ downloaded GFS archives */
/** One downloaded location: which months are present and how much they take. */
export interface ArchiveLoc { loc: string; lat: number; lon: number; name: string; months: string[]; bytes: number; updatedAt: string }
export interface ArchiveMonthRow { key: string; loc: string; ym: string; text: string; bytes: number; fetchedAt: string }
export const archiveLocKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
export async function listArchiveLocations(): Promise<ArchiveLoc[]> {
  const db = await openDb();
  const all = await tx<ArchiveLoc[]>(db, ["archLocs"], "readonly", t => t.objectStore("archLocs").getAll());
  db.close();
  return (all ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function getArchiveLocation(loc: string): Promise<ArchiveLoc | null> {
  const db = await openDb();
  const row = await tx<ArchiveLoc | undefined>(db, ["archLocs"], "readonly", t => t.objectStore("archLocs").get(loc));
  db.close();
  return row ?? null;
}
/** Store one month and update the location row (creating it if needed). Returns the updated location. */
export async function putArchiveMonth(o: { lat: number; lon: number; name: string; ym: string; text: string }): Promise<ArchiveLoc> {
  const loc = archiveLocKey(o.lat, o.lon);
  const db = await openDb();
  const prev = await tx<ArchiveLoc | undefined>(db, ["archLocs"], "readonly", t => t.objectStore("archLocs").get(loc));
  const old = await tx<ArchiveMonthRow | undefined>(db, ["archMonths"], "readonly", t => t.objectStore("archMonths").get(`${loc}|${o.ym}`));
  const row: ArchiveMonthRow = { key: `${loc}|${o.ym}`, loc, ym: o.ym, text: o.text, bytes: o.text.length, fetchedAt: new Date().toISOString() };
  const months = [...new Set([...(prev?.months ?? []), o.ym])].sort();
  const rec: ArchiveLoc = { loc, lat: o.lat, lon: o.lon, name: o.name || prev?.name || loc, months, bytes: (prev?.bytes ?? 0) - (old?.bytes ?? 0) + row.bytes, updatedAt: row.fetchedAt };
  await tx(db, ["archLocs", "archMonths"], "readwrite", t => { t.objectStore("archMonths").put(row); t.objectStore("archLocs").put(rec); });
  db.close();
  return rec;
}
export async function getArchiveMonth(loc: string, ym: string): Promise<ArchiveMonthRow | null> {
  const db = await openDb();
  const row = await tx<ArchiveMonthRow | undefined>(db, ["archMonths"], "readonly", t => t.objectStore("archMonths").get(`${loc}|${ym}`));
  db.close();
  return row ?? null;
}
export async function renameArchiveLocation(loc: string, name: string): Promise<void> {
  const db = await openDb();
  const rec = await tx<ArchiveLoc | undefined>(db, ["archLocs"], "readonly", t => t.objectStore("archLocs").get(loc));
  if (rec) { rec.name = name; await tx(db, ["archLocs"], "readwrite", t => t.objectStore("archLocs").put(rec)); }
  db.close();
}
export async function deleteArchiveLocation(loc: string): Promise<void> {
  const db = await openDb();
  const rec = await tx<ArchiveLoc | undefined>(db, ["archLocs"], "readonly", t => t.objectStore("archLocs").get(loc));
  await tx(db, ["archLocs", "archMonths"], "readwrite", t => { for (const ym of rec?.months ?? []) t.objectStore("archMonths").delete(`${loc}|${ym}`); t.objectStore("archLocs").delete(loc); });
  db.close();
}
/** Remove one stored month; the location row is updated, and removed when no month is left. */
export async function deleteArchiveMonth(loc: string, ym: string): Promise<void> {
  const db = await openDb();
  const rec = await tx<ArchiveLoc | undefined>(db, ["archLocs"], "readonly", t => t.objectStore("archLocs").get(loc));
  const row = await tx<ArchiveMonthRow | undefined>(db, ["archMonths"], "readonly", t => t.objectStore("archMonths").get(`${loc}|${ym}`));
  await tx(db, ["archLocs", "archMonths"], "readwrite", t => {
    t.objectStore("archMonths").delete(`${loc}|${ym}`);
    if (rec) {
      const months = rec.months.filter(m => m !== ym);
      if (months.length) t.objectStore("archLocs").put({ ...rec, months, bytes: Math.max(0, rec.bytes - (row?.bytes ?? 0)), updatedAt: new Date().toISOString() });
      else t.objectStore("archLocs").delete(loc);
    }
  });
  db.close();
}
export async function listArchiveMonths(loc: string): Promise<{ ym: string; bytes: number; fetchedAt: string }[]> {
  const rec = await getArchiveLocation(loc);
  if (!rec) return [];
  const db = await openDb();
  const out: { ym: string; bytes: number; fetchedAt: string }[] = [];
  for (const ym of rec.months) { const row = await tx<ArchiveMonthRow | undefined>(db, ["archMonths"], "readonly", t => t.objectStore("archMonths").get(`${loc}|${ym}`)); if (row) out.push({ ym, bytes: row.bytes, fetchedAt: row.fetchedAt }); }
  db.close();
  return out;
}
/** Drop the whole IndexedDB database (saved predictions and archives). Resolves when the browser has removed it. */
export function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); r.onblocked = () => resolve(); });
}
