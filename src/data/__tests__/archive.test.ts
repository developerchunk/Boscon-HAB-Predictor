import { describe, expect, it } from "vitest";
import { monthsBetween, monthsToFetch, parseArchiveBundle, ymValid, ARCHIVE_FORMAT } from "../archive";
import { isMonthComplete } from "../store";
import fetchScript from "../../../scripts/fetch_archive.ts?raw";
import { archiveMonthToProfiles, MODEL_LEVELS, type ArchiveMonth } from "../openmeteo";

describe("monthsBetween", () => {
  it("lists inclusive months and clips to the archive's April 2021 start and the current month", () => {
    expect(monthsBetween("2025-10", "2025-12", "2026-09")).toEqual(["2025-10", "2025-11", "2025-12"]);
    expect(monthsBetween("2020-01", "2021-05", "2026-09")).toEqual(["2021-04", "2021-05"]);
    expect(monthsBetween("2026-08", "2027-03", "2026-09")).toEqual(["2026-08", "2026-09"]);
    expect(monthsBetween("2026-10", "2026-12", "2026-09")).toEqual([]);
    expect(monthsBetween("2021-04", "2026-09", "2026-09")).toHaveLength(66);
    expect(monthsBetween("2025-13", "2026-01")).toEqual([]);
    expect(ymValid("2025-07")).toBe(true); expect(ymValid("2025-7")).toBe(false);
  });
});

describe("archiveMonthToProfiles", () => {
  it("keeps only the wanted hours and builds a 250 m profile to the top level", () => {
    const levels = MODEL_LEVELS.gfs_seamless;
    const time = ["2025-10-01T05:00", "2025-10-01T06:00", "2025-10-01T12:00"];
    const vars: Record<string, number[]> = {};
    levels.forEach((p, k) => {
      const z = 31000 * (k / (levels.length - 1)); // 0 .. 31 km, monotone in level order irrespective of p
      vars[`geopotential_height_${p}hPa`] = time.map(() => z);
      vars[`wind_speed_${p}hPa`] = time.map(() => 10);
      vars[`wind_direction_${p}hPa`] = time.map(() => 270); // from the west → u = +10
      vars[`temperature_${p}hPa`] = time.map(() => 20 - 0.0065 * z);
    });
    const m: ArchiveMonth = { time, vars };
    const out = archiveMonthToProfiles(m, [5, 6]);
    expect(out.map(p => p.h)).toEqual([5, 6]);
    expect(out[0].d).toBe("2025-10-01");
    expect(out[0].uv).toHaveLength(Math.floor(31000 / 250) + 1);
    expect(out[0].uv[40]).toEqual([100, 0]); // 10 m/s eastward in 0.1 m/s
    expect(out[0].col).toHaveLength(levels.length);
  });
});

describe("archive bundles", () => {
  it("parseArchiveBundle accepts the script's shape and rejects others", () => {
    const good = { format: ARCHIVE_FORMAT, version: 1, loc: "17.72,75.84", lat: 17.721666, lon: 75.84237, name: "Solapur pad", fetchedAt: "2026-09-22T00:00:00Z", months: { "2025-10": { time: ["2025-10-01T00:00"], vars: { wind_speed_500hPa: [1] } } } };
    expect(parseArchiveBundle(JSON.stringify(good)).name).toBe("Solapur pad");
    expect(() => parseArchiveBundle("nope")).toThrow(/JSON/);
    expect(() => parseArchiveBundle(JSON.stringify({ hello: 1 }))).toThrow(/format/);
    expect(() => parseArchiveBundle(JSON.stringify({ ...good, version: 9 }))).toThrow(/version/);
    expect(() => parseArchiveBundle(JSON.stringify({ ...good, months: { "2025-13": { time: [], vars: {} } } }))).toThrow(/malformed/);
  });
  it("scripts/fetch_archive.ts uses the same GFS levels as the app", () => {
    const m = fetchScript.match(/const GFS_LEVELS = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    expect(m![1].split(",").map(Number)).toEqual(MODEL_LEVELS.gfs_seamless);
  });
});

describe("incomplete months", () => {
  it("a month fetched before its last day is not complete", () => {
    expect(isMonthComplete("2026-09", "2026-09-22T03:30:00Z")).toBe(false);
    expect(isMonthComplete("2026-08", "2026-09-22T03:30:00Z")).toBe(true);
    expect(isMonthComplete("2026-09", "2026-10-01T00:00:00Z")).toBe(true);
    expect(isMonthComplete("2026-09", "2026-09-30T23:59:59Z")).toBe(false);
  });
  it("monthsToFetch refetches stored months that were incomplete", () => {
    const stored = { months: ["2026-07", "2026-08", "2026-09"], incomplete: ["2026-09"] };
    expect(monthsToFetch(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"], stored)).toEqual(["2026-06", "2026-09", "2026-10"]);
    expect(monthsToFetch(["2026-08"], null)).toEqual(["2026-08"]);
  });
});
