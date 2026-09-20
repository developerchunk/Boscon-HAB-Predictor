import { NM_M, FT_PER_M } from "../physics/constants";
export const km = (m: number, d = 1) => (m / 1000).toFixed(d);
export const nm = (m: number, d = 1) => (m / NM_M).toFixed(d);
export const ft = (m: number) => Math.round(m * FT_PER_M).toLocaleString();
export const fl = (m: number) => "FL" + Math.round((m * FT_PER_M) / 100);
export const min = (s: number) => (s / 60).toFixed(0);
export const hhmm = (s: number) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return `${h}h ${String(m).padStart(2, "0")}m`; };
export const deg = (d: number) => `${Math.round(d).toString().padStart(3, "0")}°`;
export const compass = (d: number) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round((d % 360) / 22.5) % 16];
export const istString = (d: Date) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().replace("T", " ").slice(0, 16) + " IST";
export const utcString = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
/** IST wall-clock (yyyy-mm-dd, hh:mm) -> Date (UTC instant) */
export const istToDate = (date: string, time: string) => new Date(Date.parse(`${date}T${time}:00+05:30`));
export const dateToIstParts = (d: Date) => { const s = new Date(d.getTime() + 5.5 * 3600e3).toISOString(); return { date: s.slice(0, 10), time: s.slice(11, 16) }; };
