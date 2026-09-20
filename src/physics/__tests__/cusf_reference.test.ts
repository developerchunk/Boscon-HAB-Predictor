import { describe, it, expect } from "vitest";
import { cusfBurstCalc, balloonById } from "../balloon";
/**
 * Reference values read from the LIVE SondeHub burst calculator (https://sondehub.org/calc/)
 * on 2026-09-20 by driving its own calc_update() in a browser. Constants on the page:
 * rho_a 1.2050, rho_H2 0.0899, rho_He 0.1786, adm 7238.3, g 9.80665, Cd 0.25 for all 1200 g.
 * The page rounds burst altitude to 1 m, time to 1 min, neck lift to 1 g, volume to 0.01 m3.
 */
const cases = [
  { id: "k1200", mp: 2.0, gas: "hydrogen", tar: 5, burst: 32264, ttb: 108, neck: 3151, vol: 3.90 },
  { id: "h1200", mp: 2.0, gas: "hydrogen", tar: 5, burst: 33415, ttb: 111, neck: 3151, vol: 3.90 },
  { id: "p1200", mp: 2.0, gas: "hydrogen", tar: 5, burst: 30618, ttb: 102, neck: 3151, vol: 3.90 },
  { id: "k1200", mp: 2.2, gas: "hydrogen", tar: 5, burst: 31871, ttb: 106, neck: 3393, vol: 4.12 },
  { id: "k1200", mp: 2.0, gas: "helium", tar: 5, burst: 31531, ttb: 105, neck: 3231, vol: 4.32 },
] as const;
describe("cusfBurstCalc reproduces the live SondeHub calculator", () => {
  it.each(cases)("%s payload %s kg %s @ %s m/s", (c) => {
    const b = balloonById(c.id);
    const r = cusfBurstCalc({ balloonMassKg: 1.2, payloadKg: c.mp, gas: c.gas, burstDiameterM: b.burstDiameterM, cd: b.cdCusf, targetAscentMs: c.tar });
    expect(Math.round(r.burstAltitudeM)).toBe(c.burst);
    expect(Math.round(r.timeToBurstMin)).toBe(c.ttb);
    expect(Math.round(r.neckLiftG)).toBe(c.neck);
    expect(r.launchVolumeM3).toBeCloseTo(c.vol, 2);
  });
  it("target-burst mode: k1200, 2 kg, H2, 31300 m -> 5.93 m/s, 88 min, 3770 g, 4.46 m3", () => {
    const b = balloonById("k1200");
    const r = cusfBurstCalc({ balloonMassKg: 1.2, payloadKg: 2.0, gas: "hydrogen", burstDiameterM: b.burstDiameterM, cd: b.cdCusf, targetBurstAltM: 31300 });
    expect(r.ascentRateMs).toBeCloseTo(5.93, 2);
    expect(Math.round(r.timeToBurstMin)).toBe(88);
    expect(Math.round(r.neckLiftG)).toBe(3770);
    expect(r.launchVolumeM3).toBeCloseTo(4.46, 2);
  });
});
