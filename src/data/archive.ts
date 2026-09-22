/**
 * Downloaded GFS archives for the climatology tab: the Open-Meteo historical-forecast archive
 * (GFS, 23 levels) at one point, one request per calendar month, stored raw in IndexedDB so every
 * later selection (months, date window, years, launch hour) is served offline. The download runs
 * in this module, not in a component, so it carries on while the user looks at other tabs; the
 * Climatology tab subscribes to its state. Months already stored are skipped, and every month is
 * written as soon as it arrives, so a cancelled or quota-stopped download resumes where it stopped.
 */
import { ARCHIVE_FIRST_YM, archiveMonthToProfiles, fetchArchiveMonth, QuotaError, type ArchiveMonth, type ArchiveProfile } from "./openmeteo";
import { archiveLocKey, deleteArchiveLocation as deleteArchiveLocationRaw, getArchiveLocation, getArchiveMonth, listArchiveLocations, putArchiveMonth, renameArchiveLocation, safeFileName, type ArchiveLoc } from "./store";

export { archiveLocKey, listArchiveLocations, renameArchiveLocation, type ArchiveLoc };
/** Delete a stored archive; if it is one bundled with the site, also stop it from installing itself again. */
export async function deleteArchiveLocation(loc: string): Promise<void> { await deleteArchiveLocationRaw(loc); if (BUNDLED_ARCHIVES.some(b => b.loc === loc)) setBundledAutoInstall(loc, false); }

/* ------------------------------------------------------------------ bundled and portable archives */
/** A whole archive in one file: the raw months exactly as fetched. Written by scripts/fetch_archive.ts, by Export, and read by Import / install. */
export const ARCHIVE_FORMAT = "boscon-hab-archive";
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_EXT = ".habarchive.json.gz";
export interface ArchiveBundle { format: typeof ARCHIVE_FORMAT; version: number; loc: string; lat: number; lon: number; name: string; fetchedAt: string; source?: string; months: Record<string, ArchiveMonth> }
/** Archives shipped with the site (public/data/archives), installed into the browser with no Open-Meteo request. */
export interface BundledArchive { file: string; loc: string; lat: number; lon: number; name: string; from: string; to: string; monthCount: number; gzBytes: number; rawBytes: number; fetched: string }
export const BUNDLED_ARCHIVES: BundledArchive[] = [
  { file: "data/archives/solapur.habarchive.json.gz", loc: "17.72,75.84", lat: 17.721666, lon: 75.84237, name: "Solapur pad", from: "2021-04", to: "2026-09", monthCount: 66, gzBytes: 5822708, rawBytes: 23861426, fetched: "2026-09-22" },
];
/** A bundled archive the user deleted is not re-installed by itself; Install brings it back. */
const NOAUTO = (loc: string) => `hab.archive.noauto.${loc}`;
export const bundledAutoInstallAllowed = (loc: string) => { try { return !localStorage.getItem(NOAUTO(loc)); } catch { return true; } };
export const setBundledAutoInstall = (loc: string, allowed: boolean) => { try { if (allowed) localStorage.removeItem(NOAUTO(loc)); else localStorage.setItem(NOAUTO(loc), "1"); } catch { /* ignore */ } };
export function parseArchiveBundle(text: string): ArchiveBundle {
  let b: any;
  try { b = JSON.parse(text); } catch { throw new Error("not a JSON archive"); }
  if (b?.format !== ARCHIVE_FORMAT) throw new Error(`not a ${ARCHIVE_EXT} archive (format field missing)`);
  if (typeof b.version !== "number" || b.version > ARCHIVE_VERSION) throw new Error(`archive version ${b.version} is newer than this app understands (${ARCHIVE_VERSION})`);
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lon) || !b.months || typeof b.months !== "object") throw new Error("archive is missing its point or months");
  for (const [ym, m] of Object.entries<any>(b.months)) if (!ymValid(ym) || !Array.isArray(m?.time) || !m?.vars) throw new Error(`month ${ym} is malformed`);
  return b as ArchiveBundle;
}
const isGzip = (u: Uint8Array) => u.length > 2 && u[0] === 0x1f && u[1] === 0x8b;
async function gunzipToText(bytes: Uint8Array): Promise<string> {
  if (!isGzip(bytes)) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot decompress gzip (DecompressionStream missing)");
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}
async function gzipText(text: string): Promise<Blob> {
  if (typeof CompressionStream === "undefined") return new Blob([text], { type: "application/json" });
  const cs = new CompressionStream("gzip");
  const stream = new Blob([text]).stream().pipeThrough(cs);
  return await new Response(stream).blob();
}
/** Fetch a URL with byte progress (content-length when the server sends it). */
async function fetchBytes(url: string, signal: AbortSignal, onProgress: (received: number, total: number) => void, rawBytes = 0): Promise<Uint8Array> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  // A server that sends the .gz with Content-Encoding: gzip (Vite does) hands the page the decompressed
  // bytes, so content-length is the compressed size; the caller's rawBytes is the total in that case.
  const total = r.headers.get("content-encoding") ? rawBytes : +(r.headers.get("content-length") ?? 0);
  if (!r.body) { const b = new Uint8Array(await r.arrayBuffer()); onProgress(b.length, b.length); return b; }
  const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let received = 0;
  for (; ;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); received += value.length; onProgress(received, total); }
  const out = new Uint8Array(received); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
/** Build the portable file for a stored archive (same shape as the bundled ones) and hand it to the browser as a download. */
export async function exportArchive(loc: string): Promise<void> {
  const rec = await getArchiveLocation(loc);
  if (!rec) throw new Error("archive not found");
  const months: Record<string, ArchiveMonth> = {};
  for (const ym of rec.months) { const row = await getArchiveMonth(loc, ym); if (row) months[ym] = JSON.parse(row.text); }
  const bundle: ArchiveBundle = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, loc, lat: rec.lat, lon: rec.lon, name: rec.name, fetchedAt: rec.updatedAt, source: "Open-Meteo historical forecast API, models=gfs_seamless, hourly, 23 pressure levels 1000..10 hPa", months };
  const blob = await gzipText(JSON.stringify(bundle));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `${safeFileName(rec.name)}-${rec.months[0]}-${rec.months[rec.months.length - 1]}${ARCHIVE_EXT}`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const ymNow = () => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
export const ymValid = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
/** Every "YYYY-MM" from `from` to `to` inclusive, clipped to what the archive can have (April 2021 .. this month). */
export function monthsBetween(from: string, to: string, now = ymNow()): string[] {
  if (!ymValid(from) || !ymValid(to)) return [];
  const lo = from < ARCHIVE_FIRST_YM ? ARCHIVE_FIRST_YM : from, hi = to > now ? now : to;
  const out: string[] = [];
  let [y, m] = lo.split("-").map(Number);
  for (; ;) { const ym = `${y}-${String(m).padStart(2, "0")}`; if (ym > hi) break; out.push(ym); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

export interface DownloadState {
  loc: string | null; name: string; running: boolean;
  /** "fetch": month by month from Open-Meteo; "install": a bundled or imported archive file being written to the browser */
  mode: "fetch" | "install";
  /** install mode: what is happening now ("downloading file", "decompressing", "writing months") */
  phase: string;
  /** install mode: file bytes received so far and the file size (0 when the server did not say) */
  fileReceived: number; fileTotal: number;
  total: number; done: number; skipped: number; bytes: number;
  startedAt: number; current: string; error: string | null; cancelled: boolean; finishedAt: number | null;
  /** measured mean wall time per fetched month this download, ms; 0 until the first month lands */
  msPerMonth: number;
}
const idle = (): DownloadState => ({ loc: null, name: "", running: false, mode: "fetch", phase: "", fileReceived: 0, fileTotal: 0, total: 0, done: 0, skipped: 0, bytes: 0, startedAt: 0, current: "", error: null, cancelled: false, finishedAt: null, msPerMonth: 0 });

const MS_KEY = "hab.archive.msPerMonth";
/** Last measured time per month from any earlier download in this browser (ms), or null. */
export function rememberedMsPerMonth(): number | null { try { const v = +(localStorage.getItem(MS_KEY) ?? ""); return v > 0 ? v : null; } catch { return null; } }

let state: DownloadState = idle();
let abort: AbortController | null = null;
const subs = new Set<() => void>();
const notify = () => { for (const f of subs) f(); };
const set = (patch: Partial<DownloadState>) => { state = { ...state, ...patch }; notify(); };

export const archiveDownloader = {
  getState: () => state,
  subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; },
  /** Start (or resume) the download of `months` at a location. Ignored while another download runs. */
  async start(o: { lat: number; lon: number; name: string; months: string[] }): Promise<void> {
    if (state.running) return;
    const loc = archiveLocKey(o.lat, o.lon);
    const have = new Set((await getArchiveLocation(loc))?.months ?? []);
    const jobs = o.months.filter(ym => !have.has(ym));
    abort = new AbortController();
    state = { ...idle(), loc, name: o.name, running: true, total: o.months.length, skipped: o.months.length - jobs.length, done: o.months.length - jobs.length, startedAt: Date.now() }; notify();
    let fetched = 0, fetchMs = 0;
    try {
      for (const ym of jobs) {
        const [y, mo] = ym.split("-").map(Number);
        set({ current: ym });
        const t0 = Date.now();
        const m = await fetchArchiveMonth({ lat: o.lat, lon: o.lon, y, mo, signal: abort.signal });
        const text = JSON.stringify(m);
        await putArchiveMonth({ lat: o.lat, lon: o.lon, name: o.name, ym, text });
        fetched++; fetchMs += Date.now() - t0;
        try { localStorage.setItem(MS_KEY, String(Math.round(fetchMs / fetched))); } catch { /* ignore */ }
        set({ done: state.done + 1, bytes: state.bytes + text.length, msPerMonth: fetchMs / fetched });
      }
      set({ running: false, current: "", finishedAt: Date.now() });
    } catch (e: any) {
      const cancelled = e?.name === "AbortError";
      set({ running: false, current: "", finishedAt: Date.now(), cancelled, error: cancelled ? null : (e instanceof QuotaError ? `stopped by the Open-Meteo quota at ${state.current}: ${e.message}` : `failed at ${state.current}: ${String(e?.message ?? e)}`) });
    } finally { abort = null; }
  },
  /** Install an archive file (bundled with the site, or one the user picked) into the browser; months already stored are skipped. */
  async install(src: { url?: string; file?: File; label: string; rawBytes?: number }): Promise<void> {
    if (state.running) return;
    abort = new AbortController();
    state = { ...idle(), name: src.label, running: true, mode: "install", phase: src.url ? "downloading file" : "reading file", startedAt: Date.now() }; notify();
    try {
      let bytes: Uint8Array;
      if (src.url) bytes = await fetchBytes(src.url, abort.signal, (r, t) => set({ fileReceived: r, fileTotal: t, bytes: r }), src.rawBytes);
      else if (src.file) { bytes = new Uint8Array(await src.file.arrayBuffer()); set({ fileReceived: bytes.length, fileTotal: bytes.length, bytes: bytes.length }); }
      else throw new Error("nothing to install");
      set({ phase: "decompressing" });
      const bundle = parseArchiveBundle(await gunzipToText(bytes));
      const loc = archiveLocKey(bundle.lat, bundle.lon);
      const have = new Set((await getArchiveLocation(loc))?.months ?? []);
      const yms = Object.keys(bundle.months).sort();
      const jobs = yms.filter(ym => !have.has(ym));
      set({ loc, name: bundle.name || src.label, phase: "writing months", total: yms.length, skipped: yms.length - jobs.length, done: yms.length - jobs.length });
      for (const ym of jobs) {
        if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
        set({ current: ym });
        await putArchiveMonth({ lat: bundle.lat, lon: bundle.lon, name: bundle.name || src.label, ym, text: JSON.stringify(bundle.months[ym]) });
        set({ done: state.done + 1 });
        await new Promise(r => setTimeout(r, 0));
      }
      set({ running: false, current: "", phase: "installed", finishedAt: Date.now() });
    } catch (e: any) {
      const cancelled = e?.name === "AbortError";
      set({ running: false, current: "", finishedAt: Date.now(), cancelled, error: cancelled ? null : `install failed: ${String(e?.message ?? e)}` });
    } finally { abort = null; }
  },
  cancel() { abort?.abort(); },
  reset() { if (!state.running) { state = idle(); notify(); } },
};

/** Profiles at the wanted UTC hours from every stored month of a location; yields between months so the page stays responsive. */
export async function loadArchiveProfiles(loc: string, hoursUtc: number[], onProgress?: (done: number, total: number) => void): Promise<{ rec: ArchiveLoc; profiles: ArchiveProfile[] } | null> {
  const rec = await getArchiveLocation(loc);
  if (!rec) return null;
  const profiles: ArchiveProfile[] = [];
  let i = 0;
  for (const ym of rec.months) {
    const row = await getArchiveMonth(loc, ym);
    if (row) profiles.push(...archiveMonthToProfiles(JSON.parse(row.text) as ArchiveMonth, hoursUtc));
    i++; onProgress?.(i, rec.months.length);
    await new Promise(r => setTimeout(r, 0));
  }
  return { rec, profiles };
}
