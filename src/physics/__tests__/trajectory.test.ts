import { describe, it, expect } from "vitest";
import { flyTrajectory } from "../trajectory";
import { ProfileWindField } from "../wind";
import { isa } from "../atmosphere";
import { fromSeaLevelRate, terminalVelocity } from "../descent";
import { RHO_SL } from "../constants";

describe("trajectory integrator", () => {
  it("uniform wind, constant ascent, steady descent: displacement = U * (t_up + t_down) to within 0.5%", () => {
    const U = 10; // m/s eastward
    const field = new ProfileWindField([0, 40000], [U, U], [0, 0], "uniform");
    const desc = fromSeaLevelRate(5, 2);
    const r = flyTrajectory(field, {
      launchLat: 18.286293, launchLon: 74.123039, launchAltM: 744.4, launchTimeS: 0,
      ascent: { balloonMassKg: 1.2, payloadKg: 2, gas: "hydrogen", burstDiameterM: 8.63, cdModel: "constant", cdConstant: 0.25, neckLiftKg: 3 },
      constantAscentMs: 5, burstAltOverrideM: 30744.4, descent: desc, dtS: 5,
    });
    const tUp = 30000 / 5;
    // steady descent time: integrate dz / v(z) numerically with the same law
    let tDown = 0;
    for (let z = 30744.4; z > 744.4; z -= 10) tDown += 10 / terminalVelocity(isa(z - 5).rho, desc);
    const expected = U * (tUp + tDown);
    expect(Math.abs(r.eastM / expected - 1)).toBeLessThan(0.005);
    expect(Math.abs(r.northM)).toBeLessThan(50);
    expect(Math.abs(r.durationS / (tUp + tDown) - 1)).toBeLessThan(0.005);
    expect(r.burst.z).toBeCloseTo(30744.4, 0);
    expect(r.landing.z).toBeCloseTo(744.4, 1);
  });
  it("quasi-steady descent: impact speed is the ground terminal speed, peak speed is the burst-altitude terminal speed", () => {
    const field = new ProfileWindField([0, 40000], [0, 0], [0, 0], "calm");
    const desc = { massKg: 2.2, chuteDiameterM: 1.2, cd: 1.5 };
    const r = flyTrajectory(field, {
      launchLat: 18, launchLon: 74, launchAltM: 744.4, launchTimeS: 0,
      ascent: { balloonMassKg: 1.2, payloadKg: 2.2, gas: "hydrogen", burstDiameterM: 8.63, cdModel: "constant", cdConstant: 0.25, neckLiftKg: 3.2 },
      constantAscentMs: 5, burstAltOverrideM: 31000, descent: desc, dtS: 2,
    });
    const vSteadyGround = terminalVelocity(isa(744.4).rho, desc);
    expect(Math.abs(r.landing.impactMs / vSteadyGround - 1)).toBeLessThan(0.01);
    expect(r.maxDescentMs).toBeGreaterThan(30); // thin air at 31 km
    expect(Math.abs(r.maxDescentMs / terminalVelocity(isa(31000).rho, desc) - 1)).toBeLessThan(0.03);
    const sl = terminalVelocity(RHO_SL, desc);
    expect(sl).toBeGreaterThan(4); expect(sl).toBeLessThan(5); // 4.6 m/s per tools/flight_profile.py assumptions
  });
  it("wind reversal cancels drift: +U below 15 km, -U above, equal time -> small net", () => {
    const field = new ProfileWindField([0, 14999, 15001, 40000], [10, 10, -10, -10], [0, 0, 0, 0], "reversal");
    const r = flyTrajectory(field, {
      launchLat: 18, launchLon: 74, launchAltM: 0, launchTimeS: 0,
      ascent: { balloonMassKg: 1.2, payloadKg: 2, gas: "hydrogen", burstDiameterM: 8.63, cdModel: "constant", cdConstant: 0.25, neckLiftKg: 3 },
      constantAscentMs: 5, burstAltOverrideM: 30000, descent: fromSeaLevelRate(5, 2), dtS: 5,
    });
    const low = r.layers.filter(l => l.zTo <= 15000).reduce((s, l) => s + l.ascentEast + l.descentEast, 0);
    const high = r.layers.filter(l => l.zFrom >= 15000).reduce((s, l) => s + l.ascentEast + l.descentEast, 0);
    expect(low).toBeGreaterThan(0); expect(high).toBeLessThan(0);
    expect(Math.abs(r.eastM)).toBeLessThan(Math.abs(low) * 0.5);
  });
});
