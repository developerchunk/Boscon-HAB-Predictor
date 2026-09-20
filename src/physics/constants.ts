/**
 * Physical constants. Every value carries its source so a reader can check it.
 * Units are SI unless the name says otherwise.
 */

/** Standard gravity, m/s^2. US Standard Atmosphere 1976 (USSA76), Table 2. */
export const G0 = 9.80665;
/** Universal gas constant used by USSA76, J/(mol K). (CODATA 2018 is 8.314462618; USSA76 keeps 8.31432 for internal consistency of its tables.) */
export const R_STAR = 8.31432;
/** Mean molar mass of dry air, kg/mol. USSA76. */
export const M_AIR = 0.0289644;
/** Specific gas constant of dry air, J/(kg K) = R_STAR / M_AIR. */
export const R_AIR = R_STAR / M_AIR; // 287.053
/** Molar masses of lift gases, kg/mol. CRC Handbook / NIST. */
export const M_H2 = 0.00201588;
export const M_HE = 0.0040026;
/** Sea-level ISA density, kg/m^3, from USSA76 (T=288.15 K, p=101325 Pa). */
export const RHO_SL = 101325 / (R_AIR * 288.15); // 1.2250
/** Effective Earth radius for the geopotential conversion, m. USSA76 uses 6356.766 km. */
export const R_EARTH_GEOPOT = 6356766;
/** Mean Earth radius for horizontal stepping, m. Same value as CUSF Tawhiri (models.py: R = 6371009 + alt). */
export const R_EARTH_MEAN = 6371009;
/** Sutherland's law for dynamic viscosity of air: mu = BETA * T^1.5 / (T + S). USSA76 eq. 51. */
export const SUTHERLAND_BETA = 1.458e-6; // kg/(m s K^0.5)
export const SUTHERLAND_S = 110.4; // K
/** Nautical mile in metres. */
export const NM_M = 1852;
/** Feet per metre. */
export const FT_PER_M = 3.280839895;
