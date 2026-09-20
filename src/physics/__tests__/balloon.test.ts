import { describe, it, expect } from "vitest";
import { cusfBurstCalc, simulateAscent, neckLiftForAscentRate, balloonById, sampleBurstDiameter, BURST_WEIBULL_K } from "../balloon";
import { isa } from "../atmosphere";

describe("CUSF burst calculator transcription", () => {
  // Reference: sondehub.org/calc run by hand with mb=k1200, mp=2000 g, tar=5 m/s, H2.
  // (The expected numbers below are pinned in cusf_reference.test.ts once verified against the live page.)
  it("target ascent and target burst modes agree with each other", () => {
    const b = balloonById("k1200");
    const r1 = cusfBurstCalc({ balloonMassKg: 1.2, payloadKg: 2.0, gas: "hydrogen", burstDiameterM: b.burstDiameterM, cd: b.cdCusf, targetAscentMs: 5 });
    expect(r1.ascentRateMs).toBeCloseTo(5, 6);
    const r2 = cusfBurstCalc({ balloonMassKg: 1.2, payloadKg: 2.0, gas: "hydrogen", burstDiameterM: b.burstDiameterM, cd: b.cdCusf, targetBurstAltM: r1.burstAltitudeM });
    expect(r2.ascentRateMs).toBeCloseTo(5, 4);
    expect(r2.neckLiftG).toBeCloseTo(r1.neckLiftG, 1);
  });
  it("hydrogen needs less volume than helium for the same lift", () => {
    const b = balloonById("k1200");
    const h2 = cusfBurstCalc({ balloonMassKg: 1.2, payloadKg: 2.0, gas: "hydrogen", burstDiameterM: b.burstDiameterM, cd: b.cdCusf, targetAscentMs: 5 });
    const he = cusfBurstCalc({ balloonMassKg: 1.2, payloadKg: 2.0, gas: "helium", burstDiameterM: b.burstDiameterM, cd: b.cdCusf, targetAscentMs: 5 });
    expect(h2.launchVolumeM3).toBeLessThan(he.launchVolumeM3);
    expect(h2.burstAltitudeM).toBeGreaterThan(he.burstAltitudeM);
  });
});

describe("physical ascent model", () => {
  const b = balloonById("k1200");
  const base = { balloonMassKg: 1.2, payloadKg: 2.2, gas: "hydrogen" as const, burstDiameterM: b.burstDiameterM, cdModel: "constant" as const, cdConstant: 0.25, launchAltM: 744.4, atmosphere: { state: isa } };
  it("free lift is neck lift minus payload, ascent rate at pad matches the solver target", () => {
    const nl = neckLiftForAscentRate(base, 5.0);
    const r = simulateAscent({ ...base, neckLiftKg: nl });
    expect(r.freeLiftKg).toBeCloseTo(nl - 2.2, 9);
    expect(r.track[0].v).toBeCloseTo(5.0, 2);
  });
  it("constant-Cd ascent rate scales as rho^(-1/6) (free lift constant, balloon expands)", () => {
    const nl = neckLiftForAscentRate(base, 5.0);
    const r = simulateAscent({ ...base, neckLiftKg: nl });
    const p0 = r.track[0];
    const p = r.track.find(x => x.z > 20000)!;
    const expected = p0.v * Math.pow(p0.rho / p.rho, 1 / 6);
    expect(Math.abs(p.v / expected - 1)).toBeLessThan(0.01);
  });
  it("burst happens on diameter and matches the repo's flight_profile.py (31.3 km for this vehicle)", () => {
    // tools/flight_profile.py: payload 2.20 kg, 1200 g, H2, Cd 0.25, 5 m/s at sea level, burst dia 8.63 -> 31.3 km
    const sl = { ...base, launchAltM: 0 };
    const nl = neckLiftForAscentRate(sl, 5.0);
    const r = simulateAscent({ ...sl, neckLiftKg: nl });
    expect(r.burst).toBe(true);
    expect(r.burstDiameterM).toBeGreaterThanOrEqual(8.63);
    expect(r.burstAltM).toBeGreaterThan(30800);
    expect(r.burstAltM).toBeLessThan(31800);
  });
  it("more gas bursts lower", () => {
    const a = simulateAscent({ ...base, neckLiftKg: 3.5 }), c = simulateAscent({ ...base, neckLiftKg: 4.5 });
    expect(c.burstAltM).toBeLessThan(a.burstAltM);
    expect(c.track[0].v).toBeGreaterThan(a.track[0].v);
  });
  it("astra Cd(Re) model slows the stratospheric ascent relative to constant Cd", () => {
    const nl = neckLiftForAscentRate(base, 5.0);
    const rc = simulateAscent({ ...base, neckLiftKg: nl });
    const ra = simulateAscent({ ...base, neckLiftKg: nl, cdModel: "astra" });
    const vc = rc.track.find(x => x.z > 25000)!.v, va = ra.track.find(x => x.z > 25000)!.v;
    expect(va).toBeLessThan(vc);
  });
  it("Weibull burst-diameter sampler has the requested mean", () => {
    let s = 0; const N = 20000;
    for (let i = 0; i < N; i++) s += sampleBurstDiameter(8.63, 1.0, (i + 0.5) / N);
    expect(s / N).toBeCloseTo(8.63, 2);
    expect(BURST_WEIBULL_K).toBeCloseTo(14.3577, 4);
  });
});

describe("Gallice (2011) drag curve", () => {
  it("gives 0.26-0.32 at Re 5e5-8e5 (radius-based), rising to ~1 at Re 3e4", async () => {
    const { galliceCd } = await import("../balloon");
    expect(galliceCd(8e5)).toBeGreaterThan(0.24); expect(galliceCd(8e5)).toBeLessThan(0.30);
    expect(galliceCd(5e5)).toBeGreaterThan(0.29); expect(galliceCd(5e5)).toBeLessThan(0.35);
    expect(galliceCd(3e4)).toBeGreaterThan(0.9); expect(galliceCd(3e4)).toBeLessThan(1.3);
  });
  it("anchored Gallice ascent is nearly constant with height (within +-25% of pad rate to 30 km) while constant-Cd nearly doubles", () => {
    const b = balloonById("k1200");
    const base = { balloonMassKg: 1.2, payloadKg: 2.2, gas: "hydrogen" as const, burstDiameterM: b.burstDiameterM, cdModel: "constant" as const, cdConstant: 0.25, launchAltM: 744.4, atmosphere: { state: isa } };
    const nl = neckLiftForAscentRate(base, 5.0);
    const g = simulateAscent({ ...base, neckLiftKg: nl, cdModel: "gallice", padAscentMs: 5.0 });
    const cc = simulateAscent({ ...base, neckLiftKg: nl });
    expect(g.track[0].v).toBeCloseTo(5.0, 2);
    const g30 = g.track.find(x => x.z > 30000)!.v, c30 = cc.track.find(x => x.z > 30000)!.v;
    expect(g30).toBeGreaterThan(3.75); expect(g30).toBeLessThan(6.25);
    expect(c30).toBeGreaterThan(9);
    // burst altitude is independent of the drag model
    expect(Math.abs(g.burstAltM - cc.burstAltM)).toBeLessThan(30);
    // and the time to burst differs by tens of minutes — this is the number the NOTAM profile depends on
    expect(g.burstTimeS - cc.burstTimeS).toBeGreaterThan(15 * 60);
  });
});
