/**
 * Parachute descent.
 *
 * Steady state:  m g = 0.5 rho v^2 Cd S0   ->   v(z) = sqrt(2 m g / (rho(z) Cd S0))
 *   S0 = pi D0^2 / 4 is the canopy's NOMINAL (constructed, laid-flat) area and Cd is
 *   referenced to it. Knacke's Parachute Recovery Systems Design Manual gives Cd(S0)
 *   0.75-0.80 for a solid flat circular canopy, 0.62-0.77 hemispherical, 0.60-0.85 cross.
 *   If you instead know the sea-level descent rate v_sl from a previous flight, use
 *   `fromSeaLevelRate`, which is the Tawhiri/SondeHub convention: v(z) = v_sl sqrt(rho_sl/rho(z)).
 *
 * Transient: the vertical relaxation time tau = m / (rho v Cd S0) is ~2 s at 31 km and
 * ~0.3 s near the ground, so the payload is at terminal speed within ~10 s of burst
 * (Renegar, UMD: video shows canopies inflated "within a few seconds"; Conner's flight data:
 * vertical accelerations rarely > 0.008 m/s^2). We therefore use the quasi-steady terminal
 * speed everywhere (as Knacke, Sirks 2020 and Tawhiri do); the neglected transient is < 150 m
 * of fall. Sirks et al. (2020, 26 stratospheric descents) found sqrt(rho0/rho) scaling
 * over-predicts descent speed by 3.7% +- 0.4% with 20% flight-to-flight scatter — chute
 * opening, tangling with balloon remains and oscillation are random (Ingleby 2022) and are
 * covered by the Monte Carlo Cd spread, not by the deterministic model.
 * Balloon remnants (latex still tied to the train) add mass. ASTRA samples a remnant mass
 * fraction of 3-100% of the envelope; we expose it as a parameter.
 */
import { G0, RHO_SL } from "./constants";

export interface DescentConfig {
  /** mass under canopy, kg: payload + chute + rigging + balloon remnant */
  massKg: number;
  /** canopy nominal (constructed) diameter, m */
  chuteDiameterM: number;
  /** drag coefficient referenced to nominal area */
  cd: number;
}

export function terminalVelocity(rho: number, c: DescentConfig): number {
  const S0 = (Math.PI * c.chuteDiameterM ** 2) / 4;
  return Math.sqrt((2 * c.massKg * G0) / (rho * c.cd * S0));
}

/** Equivalent DescentConfig for a stated sea-level descent rate (Tawhiri convention). */
export function fromSeaLevelRate(vSeaLevelMs: number, massKg = 2): DescentConfig {
  // choose chute diameter 1 m and solve Cd so that terminalVelocity(RHO_SL) == vSeaLevel
  const S0 = Math.PI / 4;
  const cd = (2 * massKg * G0) / (RHO_SL * vSeaLevelMs ** 2 * S0);
  return { massKg, chuteDiameterM: 1, cd };
}

/** Tawhiri's descent law (models.py make_drag_descent) with its NASA "atmosmet" density, for cross-checks. */
export function tawhiriDescentRate(altM: number, seaLevelRate: number): number {
  let temp: number, pressure: number;
  if (altM > 25000) { temp = -131.21 + 0.00299 * altM; pressure = 2.488 * Math.pow((temp + 273.1) / 216.6, -11.388); }
  else if (altM > 11000) { temp = -56.46; pressure = 22.65 * Math.exp(1.73 - 0.000157 * altM); }
  else { temp = 15.04 - 0.00649 * altM; pressure = 101.29 * Math.pow((temp + 273.1) / 288.08, 5.256); }
  const density = pressure / (0.2869 * (temp + 273.1));
  return (seaLevelRate * 1.1045) / Math.sqrt(density);
}
