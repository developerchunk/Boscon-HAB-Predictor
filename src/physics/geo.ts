/** Spherical-earth geodesy. Distances over the ~100 km scale of a flight are accurate to ~0.3% vs WGS84. */
import { R_EARTH_MEAN } from "./constants";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** Great-circle distance in metres (haversine). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH_MEAN * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** Initial bearing from point 1 to point 2, degrees clockwise from true north. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}
/** East/north offsets in metres of point 2 relative to point 1 (local tangent plane). */
export function eastNorthM(lat1: number, lon1: number, lat2: number, lon2: number): [number, number] {
  const east = (lon2 - lon1) * D2R * R_EARTH_MEAN * Math.cos(0.5 * (lat1 + lat2) * D2R);
  const north = (lat2 - lat1) * D2R * R_EARTH_MEAN;
  return [east, north];
}
/** Point at (east, north) metres from (lat, lon). */
export function offsetLatLon(lat: number, lon: number, eastM: number, northM: number): [number, number] {
  const dlat = (northM / R_EARTH_MEAN) * R2D;
  const dlon = (eastM / (R_EARTH_MEAN * Math.cos(lat * D2R))) * R2D;
  return [lat + dlat, lon + dlon];
}
/** Wind FROM direction (met convention, deg) and speed (m/s) -> (u east, v north) m/s. */
export function uvFromDirSpeed(dirFromDeg: number, speed: number): [number, number] {
  const r = dirFromDeg * D2R;
  return [-speed * Math.sin(r), -speed * Math.cos(r)];
}
/** (u, v) -> [direction the wind blows FROM in deg, speed m/s]. */
export function dirSpeedFromUV(u: number, v: number): [number, number] {
  const spd = Math.hypot(u, v);
  if (spd < 1e-9) return [0, 0];
  return [(Math.atan2(-u, -v) * R2D + 360) % 360, spd];
}
/** Direction the wind blows TOWARD, deg. */
export function towardDeg(u: number, v: number): number {
  return (Math.atan2(u, v) * R2D + 360) % 360;
}
