/**
 * Downloaded GFS archives for the climatology tab: the Open-Meteo historical-forecast archive
 * (GFS, 23 levels) at one point, one request per calendar month, stored raw in IndexedDB so every
 * later selection (months, date window, years, launch hour) is served offline. The download runs
 * in this module, not in a component, so it carries on while the user looks at other tabs; the
 * Climatology tab subscribes to its state. Months already stored are skipped, and every month is
 * written as soon as it arrives, so a cancelled or quota-stopped download resumes where it stopped.
 */
import { ARCHIVE_FIRST_YM, archiveMonthToProfiles, fetchArchiveMonth, QuotaError, type ArchiveMonth, type ArchiveProfile } from "./openmeteo";
import { archiveLocKey, deleteArchiveLocation, getArchiveLocation, getArchiveMonth, listArchiveLocations, putArchiveMonth, renameArchiveLocation, type ArchiveLoc } from "./store";

export { archiveLocKey, listArchiveLocations, deleteArchiveLocation, renameArchiveLocation, type ArchiveLoc };

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
  total: number; done: number; skipped: number; bytes: number;
  startedAt: number; current: string; error: string | null; cancelled: boolean; finishedAt: number | null;
  /** measured mean wall time per fetched month this download, ms; 0 until the first month lands */
  msPerMonth: number;
}
const idle = (): DownloadState => ({ loc: null, name: "", running: false, total: 0, done: 0, skipped: 0, bytes: 0, startedAt: 0, current: "", error: null, cancelled: false, finishedAt: null, msPerMonth: 0 });

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
