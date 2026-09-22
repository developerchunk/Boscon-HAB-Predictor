import { describe, expect, it } from "vitest";
import { monthsBetween, ymValid } from "../archive";
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
