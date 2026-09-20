import { describe, it, expect } from "vitest";
import { isa, isaAltitudeForPressure, geopotential, geometric, Column, viscosity } from "../atmosphere";

// USSA76 published layer-base values at GEOPOTENTIAL height H (Table 4 / Table I).
// Tolerances: 0.05% on p, 0.05 K on T. We convert H to geometric before calling isa().
const TABLE: [number, number, number][] = [
  [0, 101325, 288.15],
  [11000, 22632.06, 216.65],
  [20000, 5474.889, 216.65],
  [32000, 868.0187, 228.65],
  [47000, 110.9063, 270.65],
  [51000, 66.93887, 270.65],
  [71000, 3.956420, 214.65],
];
describe("USSA76", () => {
  it.each(TABLE)("H=%d m -> p=%f Pa, T=%f K", (H, p, T) => {
    const s = isa(geometric(H));
    expect(Math.abs(s.p / p - 1)).toBeLessThan(5e-4);
    expect(Math.abs(s.T - T)).toBeLessThan(0.05);
  });
  it("sea-level density is 1.2250 kg/m3", () => expect(isa(0).rho).toBeCloseTo(1.2250, 3));
  it("geopotential of 11019 m geometric is 11000 m", () => expect(geopotential(11019)).toBeCloseTo(11000, 0));
  it("inverse pressure lookup round-trips", () => {
    for (const z of [500, 7000, 15000, 25000, 31000]) expect(isaAltitudeForPressure(isa(z).p)).toBeCloseTo(z, 1);
  });
  it("Sutherland viscosity at 288.15 K is 1.789e-5 Pa s", () => expect(viscosity(288.15)).toBeCloseTo(1.789e-5, 8));
});
describe("Column", () => {
  it("reproduces ISA when built from ISA levels", () => {
    const zs = [0, 1000, 3000, 5000, 7000, 10000, 12000, 14000, 16000, 18000, 20000, 24000, 28000, 32000];
    const col = new Column(zs.map(z => ({ z, ...isa(z) })));
    for (const z of [400, 2500, 9000, 13000, 19000, 26000, 31000]) {
      expect(Math.abs(col.state(z).rho / isa(z).rho - 1)).toBeLessThan(2e-3);
    }
  });
});
