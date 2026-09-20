export function MethodPanel() {
  return <div className="page method">
    <h2>What this predictor computes, and where every number comes from</h2>
    <p>Everything below is implemented in <code>src/physics/</code> and covered by <code>npm test</code>. "Verified" means a test exists that would fail if the statement were wrong; "assumed" means it is a stated choice, not a measurement. The full write-up with citations is in <code>README.md</code>.</p>

    <h3>1. Atmosphere</h3>
    <p>US Standard Atmosphere 1976, seven layers to 86 km, with geometric↔geopotential conversion (r₀ = 6356.766 km). Verified against the published layer-base pressures (22632.06 Pa at 11 km, 5474.889 Pa at 20 km, 868.0187 Pa at 32 km, 110.9063 Pa at 47 km) to 0.05%. For a live prediction the density column is built from the forecast's own temperature and geopotential height at every pressure level (ρ = p/RT, hydrostatic between levels), so the ascent and the parachute see the real tropical atmosphere, which at 30 km is warmer and ~10% denser than the ISA. Air viscosity from Sutherland's law (USSA76 eq. 51).</p>

    <h3>2. Fill and ascent</h3>
    <pre>{`Neck lift (what the spring scale reads with the payload detached):  L_neck = V0 (ρ_air − ρ_gas) − m_balloon
Free lift:                                                             L_free = L_neck − m_under_balloon
Volume at any height (latex is unstressed, gas at ambient p, T):       V(z)   = n R T(z) / p(z)
Force balance (quasi-steady, Gallice 2011 eq. 3 / Renegar eq. 19):    v(z)   = sqrt( 2 g L_free / (ρ(z) C_D(Re) A(z)) ),  A = π D²/4
Burst:                                                                  D(z) ≥ D_burst (manufacturer's nominal × factor)`}</pre>
    <p>The fill is planned with the constant C_D that the CUSF/SondeHub calculator uses (0.25 for 1200 g and up, 0.30 for 600–1000 g), because that is what the manufacturers' free-lift tables and a decade of launch practice are calibrated to. The transcription of that calculator is verified against the live sondehub.org/calc page to the metre (five cases). The flight then uses the drag curve fitted by Gallice et al. (2011, Atmos. Meas. Tech. 4, 2235) to ten Totex TX1200 flights, C_D = 0.04808 (ln Re)² − 1.406 ln Re + 10.49 with radius-based Re, scaled by one constant so that the pad ascent rate matches. Because the fitted per-balloon offset is multiplicative (±25%), anchoring removes it without changing the curve's altitude dependence. Result: ascent rate stays within ±25% of the pad value all the way to 30 km, which matches the radiosonde statistics (Seidel et al. 2011 median 1.71 h to 10 hPa ≈ 5.05 m/s average; Voggenberger et al. 2024), whereas constant C_D makes the balloon climb twice as fast at 30 km and shortens the climb by 25–30 minutes. Burst altitude does not depend on this choice. The gas-temperature lag (Gallice's diffusion model) and the tropopause dip are not implemented.</p>

    <h3>3. Descent</h3>
    <pre>{`v(z) = sqrt( 2 m g / (ρ(z) C_D0 S0) ),   S0 = π D0² / 4 on the CONSTRUCTED canopy diameter (Knacke, NWC TP 6575)`}</pre>
    <p>Quasi-steady terminal speed everywhere: the vertical relaxation time is ~2 s at 31 km and 0.3 s near the ground, so the neglected post-burst transient is under 150 m of fall. Knacke's C_D0 on nominal area: flat circular 0.75–0.80, hemispherical 0.62–0.77, cross 0.60–0.85. Sirks et al. (2020, 26 stratospheric descents) found the √(ρ₀/ρ) law over-predicts descent speed by 3.7% ± 0.4% with 20% flight-to-flight scatter, which the Monte Carlo covers with a ±20% C_D spread. The repo's earlier 4.8 m/s figure used C_D = 1.5 on a 1.2 m circle; on a constructed-area basis the same canopy is ~6.6 m/s at sea level. Measure it on the first test flight and enter the sea-level rate directly.</p>

    <h3>4. Wind and trajectory</h3>
    <p>Horizontal motion is pure advection (a balloon has no airspeed; Renegar: it follows the wind within ~30 s). Winds come from Open-Meteo: GFS with 23 pressure levels from 1000 to 10 hPa (≈31 km) plus 10/80/120/180 m above-ground winds for the boundary layer, on a 5×5 grid of columns at 0.5° spacing (±110 km) and hourly in time; ICON (to 30 hPa) and ECMWF IFS (14 levels) are alternatives. Interpolation is bilinear in latitude/longitude, linear in time and linear in altitude between the model's geopotential heights, the same scheme as CUSF Tawhiri. Above the top level the top wind is held and the run is flagged. The integrator is classical RK4 with a 5 s step on (lat, lon, z) using Tawhiri's spherical stepping (R = 6371009 m + z). Verified: on the same measured Pune sounding it reproduces the repo's independent Python drift simulation (tools/drift_sim.py) to 0.04% in range; a uniform-wind analytic case to 0.5%; a wind-reversal case cancels as expected.</p>
    <p>Terrain: the descent ends at the Copernicus DEM GLO-90 elevation of the landing point (Open-Meteo elevation API), re-flown until the ground height converges within 15 m. Tawhiri uses a 15-arc-second DEM; ASTRA stops at 0 m; CUSF's calculator ignores site elevation entirely.</p>

    <h3>5. Uncertainty (Monte Carlo)</h3>
    <ul>
      <li>Burst diameter: Weibull with shape k = 14.36 (ASTRA's fit to observed radiosonde bursts; ≈8.5% 1σ in diameter ≈ ±1.5 km in burst altitude), mean = nominal × a factor you set (1.0 default). Hwoyee flights in the UKHAS database burst above the Totex model by 0.1–6 km; Kaymont/Totex below it by up to 3 km.</li>
      <li>Fill: Gaussian 5% on neck lift (spring scale in wind); payload mass 3%; chute C_D uniform ±20%; balloon remnant 3–100% of the envelope mass carried down (all ASTRA defaults).</li>
      <li>Wind: each run takes one of the 50 ECMWF ensemble members' deviations from the control (a real, flow-dependent spread, 14 levels). If the ensemble is unavailable, an assumed AR(1) perturbation with σ = 2.5 m/s and 2 km vertical correlation is used and labelled as such.</li>
      <li>Output: 50/90/95% covariance ellipses (χ², 2 d.o.f.). Practitioners' rule of thumb for comparison: a 5-mile radius plus 5% of distance travelled (Akerman); a 10 × 5 km oval for a 50 km flight (Randall).</li>
    </ul>

    <h3>6. Climatology</h3>
    <p>Measured radiosondes from NOAA IGRA v2: Pune (43 km from the pad) 2016–2026, Mumbai and Nagpur 2022–2026 (Pune's own record is thin in 2021–2024), Goa and Hyderabad. Only soundings with wind to ≥30 km and ≥20 levels are used; wind-only levels without a height are placed by interpolating the sounding's own pressure–height pairs. Plus a daily 05/06 UTC GFS column at Jejuri from Open-Meteo's forecast archive, January 2022 to August 2026, which is a model, not a measurement, and is compared against the Pune radiosonde on the same days in the Climatology tab.</p>

    <h3>7. What is not done, and known limits</h3>
    <ul>
      <li>No forecast is reliable beyond ~7 days (Akerman, Wyoming Space Grant: night-before SondeHub predictions land within 8 km ~70% of the time). GFS reaches 16 days; the climatology is for planning beyond that.</li>
      <li>The ECMWF ensemble has only 14 levels, three of them in the stratosphere; its spread above 20 km is coarse.</li>
      <li>GFS's top level (10 hPa) is ≈31 km; a burst above that uses the held 10 hPa wind. Tawhiri has levels to 1 hPa and is shown for comparison.</li>
      <li>Parachute opening, tangling with balloon remains and oscillation are random (Ingleby 2022, Kräuchi 2016) and only represented through the C_D spread.</li>
      <li>Pawan CPR-1200 data are from a 2012 data sheet (8.0 m, 31 km at 1 kg); no current production data were found. Which balloon brand flies changes burst by 1–3 km.</li>
      <li>Nothing here has yet been checked against one of this team's own flights. The first test flight should record neck lift, ascent rate every km, burst altitude, descent rate at 5 km and the landing point; those five numbers calibrate every model above.</li>
    </ul>
  </div>;
}
