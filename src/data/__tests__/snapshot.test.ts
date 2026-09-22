import { describe, it, expect } from "vitest";
import { GridWindField } from "../../physics/wind";
import { flyTrajectory } from "../../physics/trajectory";
import { isa } from "../../physics/atmosphere";
import { serializeResults, deserializeResults, buildSaved, restoreSaved, DEFAULT_SETTINGS, type Results } from "../snapshot";
import { parseSavedFile, safeFileName, SAVED_FORMAT } from "../store";
import { DEFAULT_INPUTS } from "../../physics/defaults";

// a small synthetic 2x2 grid over the pad with two hours and an ISA column with a uniform 8 m/s westerly
function grid(): GridWindField {
  const levels = [0, 1000, 3000, 6000, 10000, 15000, 20000, 25000, 30000, 35000].map(z => ({ z, u: 8, v: 0, T: isa(z).T, p: isa(z).p }));
  const cols = [];
  for (const lat of [17.5, 18.0]) for (const lon of [75.5, 76.0]) cols.push({ lat, lon, times: [levels, levels] });
  return new GridWindField([0, 3600], cols, "synthetic");
}
const cfg = (launchLat: number, launchLon: number, launchAltM: number) => ({ launchLat, launchLon, launchAltM, launchTimeS: 0, ascent: { balloonMassKg: 1.2, payloadKg: 2, gas: "hydrogen" as const, burstDiameterM: 8.63, cdModel: "gallice" as const, cdConstant: 0.25, neckLiftKg: 3.1, padAscentMs: 5 }, descent: { massKg: 2.3, chuteDiameterM: 1.2, cd: 0.75 }, dtS: 10 });
describe("saved prediction round trip", () => {
  it("serialises results to plain JSON and restores an identical flight", () => {
    const field = grid();
    const inputs = { ...DEFAULT_INPUTS, launchUtc: new Date("2026-10-24T05:30:00Z") };
    const nominal = flyTrajectory(field, cfg(inputs.launchLat, inputs.launchLon, inputs.launchAltM));
    const results: Results = { grid: { field, epochMs: 0, lats: [17.5, 18], lons: [75.5, 76], launchColumn: (field as any).cols[0][0].times[0], surfaceElevationM: 490, generatedAtMs: 1, model: "gfs_seamless" }, plan: {} as any, nominal, groundAltM: 490, demIterations: 1, ensembleN: 0, computedAt: new Date("2026-09-22T03:00:00Z") };
    const rec = buildSaved({ name: "test", inputs, settings: DEFAULT_SETTINGS, results, tabs: { burstCalc: { payload: 2 }, climatology: { source: "gfs" }, flight3d: { exag: 1 } } });
    const text = JSON.stringify(rec);
    expect(text).not.toContain("function");
    const parsed = parseSavedFile(text);
    expect(parsed.format).toBe(SAVED_FORMAT);
    const back = restoreSaved(parsed);
    expect(back.inputs.launchUtc.toISOString()).toBe("2026-10-24T05:30:00.000Z");
    expect(back.results!.nominal.landing.lat).toBeCloseTo(nominal.landing.lat, 9);
    expect(back.results!.computedAt.getTime()).toBe(results.computedAt.getTime());
    expect(back.tabs.climatology.source).toBe("gfs");
    const again = flyTrajectory(back.results!.grid.field, cfg(inputs.launchLat, inputs.launchLon, inputs.launchAltM));
    expect(again.rangeM).toBeCloseTo(nominal.rangeM, 6);
    const s = serializeResults(results); const d = deserializeResults(s);
    expect(d.grid.field.label).toBe("synthetic"); expect(s.grid.columns.length).toBe(4);
  });
  it("rejects files that are not predictions", () => {
    expect(() => parseSavedFile("not json")).toThrow(/JSON/);
    expect(() => parseSavedFile(JSON.stringify({ hello: 1 }))).toThrow(/format/);
    expect(() => parseSavedFile(JSON.stringify({ format: SAVED_FORMAT, version: 99, meta: { id: "x" }, inputs: {} }))).toThrow(/version/);
  });
});

describe("safeFileName", () => {
  it("turns the display name into a portable file name", () => {
    expect(safeFileName("17.722, 75.842 · 2026-09-23 11:00 IST · NOAA GFS (0.25°, 23 levels to 10 hPa ≈ 31 km)"))
      .toBe("17.722-75.842-2026-09-23-11-00-IST-NOAA-GFS-0.25-23-levels-to-10-hPa-31-km");
    expect(safeFileName("···")).toBe("prediction");
    expect(safeFileName("Nashik.")).toBe("Nashik");
  });
});
