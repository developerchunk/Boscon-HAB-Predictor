import type { PredictInputs } from "./predictor";

const tomorrow0530Z = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(5, 30, 0, 0); return d; };

/**
 * HAB-1 default vehicle and pad. Pad 17.721666 N, 75.84237 E is 9 km north-west of Solapur;
 * its ground height is 491.5 m from the Mapbox Terrain-RGB DEM (Copernicus GLO-90 says 487 m),
 * read on 2026-09-22. Kaymont 1200 g, hydrogen, 2.0 kg under the balloon, 5 m/s at the pad, 1.2 m chute.
 */
export const DEFAULT_INPUTS: PredictInputs = {
  launchLat: 17.721666, launchLon: 75.84237, launchAltM: 491.5, launchUtc: tomorrow0530Z(),
  balloonId: "k1200", gas: "hydrogen", payloadKg: 2.0,
  fillMode: "ascentRate", targetAscentMs: 5.0, neckLiftKg: 3.2, targetBurstAltM: 31000,
  ascentModel: "gallice", burstDiameterFactor: 1.0,
  descentMode: "chute", chuteDiameterM: 1.2, chuteCd: 0.75, seaLevelDescentMs: 5.0, remnantKg: 0.3,
  floatMinutes: 0, dtS: 5,
};
