/**
 * Shared result/settings types and the (de)serialisation of a prediction for saving.
 * The only non-plain object in a result is the GridWindField; it is stored as its raw parts
 * (times, columns, label) and rebuilt on load. Functions (surfaceAt) are dropped; the landing-zone
 * weather they produced is kept as data.
 */
import { GridWindField } from "../physics/wind";
import type { FlightResult } from "../physics/trajectory";
import type { McResult } from "../physics/montecarlo";
import type { TawhiriResult } from "../data/tawhiri";
import type { GridFetchResult, ModelId, WeatherColumn, SurfaceWx } from "../data/openmeteo";
import type { planFill, PredictInputs } from "../physics/predictor";
import { SAVED_FORMAT, SAVED_VERSION, newId, type SavedPrediction, type SavedMeta } from "./store";

export type GridDensity = "dense" | "standard" | "light";
export const GRID_PRESETS: Record<GridDensity, { step: number; half: number; label: string }> = {
  dense: { step: 0.25, half: 1.0, label: "full — 9×9 columns at 0.25° (±110 km, the model's native spacing)" },
  standard: { step: 0.5, half: 1.0, label: "5×5 columns at 0.5° (±110 km, Tawhiri's resolution)" },
  light: { step: 0.75, half: 0.75, label: "3×3 columns at 0.75° (±80 km) — only if the API is throttling" },
};
export interface Settings { model: ModelId; mcRuns: number; useEnsemble: boolean; compareTawhiri: boolean; windSigmaMs: number; burstMeanRatio: number; fillSigma: number; chuteCdSpread: number; remnant: boolean; hourSweep: boolean; grid: GridDensity }
export const DEFAULT_SETTINGS: Settings = { model: "gfs_seamless", mcRuns: 300, useEnsemble: true, compareTawhiri: true, windSigmaMs: 2.5, burstMeanRatio: 1.0, fillSigma: 0.05, chuteCdSpread: 0.2, remnant: true, hourSweep: true, grid: "dense" };

export interface Results {
  grid: GridFetchResult; plan: ReturnType<typeof planFill>; nominal: FlightResult; groundAltM: number; demIterations: number;
  mc?: McResult; ensembleN: number; tawhiri?: TawhiriResult; tawhiriError?: string;
  hourly?: { offsetH: number; lat: number; lon: number; rangeM: number; bearing: number; durationS: number }[];
  computedAt: Date;
  demError?: string;
  weather?: WeatherColumn;
  landingWx?: SurfaceWx[];
  weatherError?: string;
}

/** Per-tab UI state that is saved with a prediction. */
export interface TabSnapshots { burstCalc?: any; climatology?: any; flight3d?: any }

export function serializeResults(r: Results): any {
  const f = r.grid.field as any;
  const grid = { timesS: f.timesS, columns: (f.cols as any[][]).flat(), label: f.label, epochMs: r.grid.epochMs, lats: r.grid.lats, lons: r.grid.lons, launchColumn: r.grid.launchColumn, surfaceElevationM: r.grid.surfaceElevationM, generatedAtMs: r.grid.generatedAtMs, model: r.grid.model, weather: r.grid.weather };
  const { grid: _g, computedAt, ...rest } = r;
  return { ...rest, grid, computedAt: computedAt.toISOString() };
}
export function deserializeResults(s: any): Results {
  const field = new GridWindField(s.grid.timesS, s.grid.columns, s.grid.label);
  const grid: GridFetchResult = { field, epochMs: s.grid.epochMs, lats: s.grid.lats, lons: s.grid.lons, launchColumn: s.grid.launchColumn, surfaceElevationM: s.grid.surfaceElevationM, generatedAtMs: s.grid.generatedAtMs, model: s.grid.model, weather: s.grid.weather };
  const { grid: _g, computedAt, ...rest } = s;
  return { ...rest, grid, computedAt: new Date(computedAt) } as Results;
}

export function buildSaved(o: { id?: string; name: string; place?: string; inputs: PredictInputs; settings: Settings; results: Results | null; tabs: TabSnapshots }): SavedPrediction {
  const n = o.results?.nominal;
  const meta: SavedMeta = {
    id: o.id ?? newId(), name: o.name, savedAt: new Date().toISOString(), launchUtc: o.inputs.launchUtc.toISOString(),
    padLat: o.inputs.launchLat, padLon: o.inputs.launchLon, padAltM: o.inputs.launchAltM, place: o.place, model: o.settings.model,
    landingLat: n?.landing.lat, landingLon: n?.landing.lon, rangeM: n?.rangeM, bearingDeg: n?.bearingDeg, durationS: n?.durationS, burstAltM: n?.burst.z, bytes: 0,
  };
  return { format: SAVED_FORMAT, version: SAVED_VERSION, meta, inputs: { ...o.inputs, launchUtc: o.inputs.launchUtc.toISOString() }, settings: o.settings, results: o.results ? serializeResults(o.results) : null, burstCalc: o.tabs.burstCalc, climatology: o.tabs.climatology, flight3d: o.tabs.flight3d };
}
export function restoreSaved(rec: SavedPrediction): { inputs: PredictInputs; settings: Settings; results: Results | null; tabs: TabSnapshots } {
  const inputs: PredictInputs = { ...rec.inputs, launchUtc: new Date(rec.inputs.launchUtc) };
  const settings: Settings = { ...DEFAULT_SETTINGS, ...rec.settings };
  const results = rec.results ? deserializeResults(rec.results) : null;
  return { inputs, settings, results, tabs: { burstCalc: rec.burstCalc, climatology: rec.climatology, flight3d: rec.flight3d } };
}
