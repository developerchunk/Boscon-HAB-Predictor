/**
 * CUSF Tawhiri via SondeHub (https://api.v2.sondehub.org/tawhiri) — the reference predictor
 * every HAB group uses. We call it with the same launch parameters so the user can see where
 * the two models diverge. Tawhiri: GFS 0.5°/3 h, 47 levels to 1 hPa, RK4 dt = 60 s, constant
 * ascent rate, descent v = v_sl*1.1045/sqrt(rho_NASA), landing on a 15" DEM (ruaumoko).
 */
export interface TawhiriPoint { latitude: number; longitude: number; altitude: number; datetime: string }
export interface TawhiriResult {
  dataset: string;
  ascent: TawhiriPoint[]; descent: TawhiriPoint[];
  burst: TawhiriPoint; landing: TawhiriPoint;
  warnings: Record<string, { count: number; description: string }>;
}
export async function fetchTawhiri(o: { lat: number; lon: number; altM: number; launch: Date; ascentMs: number; burstAltM: number; descentMs: number; signal?: AbortSignal }): Promise<TawhiriResult> {
  const lon = ((o.lon % 360) + 360) % 360; // API wants 0..360
  const url = `https://api.v2.sondehub.org/tawhiri?launch_latitude=${o.lat}&launch_longitude=${lon}&launch_altitude=${o.altM.toFixed(1)}&launch_datetime=${o.launch.toISOString()}&ascent_rate=${o.ascentMs.toFixed(3)}&burst_altitude=${o.burstAltM.toFixed(0)}&descent_rate=${o.descentMs.toFixed(3)}&profile=standard_profile`;
  const resp = await fetch(url, { signal: o.signal });
  const d = await resp.json();
  if (!resp.ok || d.error) throw new Error(`Tawhiri: ${d.error?.description ?? resp.status}`);
  const asc = d.prediction.find((s: any) => s.stage === "ascent").trajectory as TawhiriPoint[];
  const des = d.prediction.find((s: any) => s.stage === "descent").trajectory as TawhiriPoint[];
  return { dataset: d.request.dataset, ascent: asc, descent: des, burst: asc[asc.length - 1], landing: des[des.length - 1], warnings: d.warnings ?? {} };
}
