# BOSCON HAB predictor

Landing predictor, burst calculator and Pune wind climatology for the HAB-1 flight from
Jejuri (18.286293 N, 74.123039 E, 744.4 m AMSL). Browser app, no backend: forecast winds
come from Open-Meteo, the reference prediction from SondeHub's Tawhiri, terrain from the
Copernicus DEM, and the climatology from NOAA radiosonde archives bundled in `public/data/`.

```bash
npm install
cp .env.example .env        # put VITE_MAPBOX_TOKEN=pk.... in it
npm run dev                 # http://localhost:5173
npm test                    # 31 physics tests (atmosphere, burst calc, integrator, drag model)
npm run build
```

Without a Mapbox token everything still works except the map tiles; the plan-view chart shows the
same trajectory, Monte Carlo scatter and ellipses in east/north kilometres from the pad. The token
must be a **public** one (`pk.…`); Mapbox GL rejects secret `sk.` tokens and anything in `.env` is
compiled into the served JavaScript.

**Terrain on the map.** Three layers from Mapbox's terrain data, inserted below the base map's water,
roads and labels:

* a **filled elevation tint** covering every pixel: the `mapbox.mapbox-terrain-dem-v1` tiles are
  Terrain-RGB images (elevation = −10000 + 0.1·(R·65536 + G·256 + B)), fetched as a plain raster
  source from the `v4 …/{z}/{x}/{y}.pngraw` endpoint (256 px, lossless, zoom ≤ 14; the TileJSON
  `raster/v1` route returns 401 for plain-raster reads and the `.webp` variant is lossy) and decoded
  on the GPU with the style-spec `raster-color-mix`
  `[1671168, 6528, 25.5, −10000]` (channels are 0..1 in the shader) and coloured with a
  `raster-color` ramp over 0–1600 m: green 0 m, yellow-green 400 m, yellow 600 m, orange 800 m,
  red 1200 m, purple ≥ 1400 m. The legend shows the same ramp;
* a **hillshade** from the same DEM;
* **contour lines** from `mapbox.mapbox-terrain-v2`, labelled in metres on every 100 m line
  (every 200 m below zoom 11.5). Mapbox serves contours at 500 m spacing at zoom 9, then 200, 100,
  50, 20 and 10 m as you zoom in; below zoom 9 there are none.

A "3-D" toggle drapes the map on the DEM (1.6× exaggeration). The landing altitude the physics
uses still comes from the Copernicus DEM lookup, not from these display layers.

Verified 2026-09-20: `scripts/check_terrain_rgb.py` decodes the tile under the pad to 743.7 m
(repo pad elevation 744.4 m, Copernicus 740 m) and Pune Shivajinagar, Sinhagad, Lonavala and the
Konkan to their known heights; in the browser every raster tile reports state `loaded` and the
ground at zoom 15 around the pad renders in the 700 m colour of the legend.

---

## 1. What it computes

| Tab | Inputs | Outputs |
|---|---|---|
| **Predict** | pad position and elevation, launch time (IST), balloon make and size, gas, mass under the balloon, fill (target ascent rate / measured neck lift / target burst altitude), parachute (constructed diameter and Cd, or a sea-level descent rate), forecast model | neck lift to set on the scale, free lift, gas volume at pad conditions, burst altitude and time, nominal track, landing point with DEM ground height, range and bearing, time in each layer and where the drift came from, Monte Carlo landing scatter with 50/90/95% ellipses, the SondeHub/Tawhiri prediction for the same parameters, and a ±3 h launch-time sweep |
| **Burst calculator** | balloon, gas, payload, site elevation, fill, chute | the physical model next to the CUSF/SondeHub calculator; ascent-rate-vs-altitude for three drag models; sensitivity of burst altitude and time to fill (±10%) and to burst diameter (±10%) |
| **Climatology** | radiosonde station or the GFS archive, months, years, sounding hour | wind speed percentiles and mean vector by altitude (with the direction reversal), month-by-month table, GFS-vs-radiosonde check, and the vehicle flown on every real atmosphere: landing scatter, range percentiles, bearing rose |
| **Predict › temperature** | – | projected air temperature and pressure: pad-column profile against the ISA, the temperature at the balloon over flight time, coldest point, minutes at or below −20/−40/−60 °C, and the full pressure-level table (hPa, height, °C, wind); the 3-D view shows °C and hPa on the balloon label and on the altitude ticks |
| **Method & sources** | – | the formulas, constants and verification status, in the app |

---

## 2. Physics, with sources

All code is in `src/physics/`. Every constant carries its source in a comment.

### 2.1 Atmosphere — `atmosphere.ts`
US Standard Atmosphere 1976 (NASA-TM-X-74335), seven layers to 86 km, geometric↔geopotential
conversion with r₀ = 6356.766 km, Sutherland viscosity (USSA76 eq. 51).
**Verified** against the published layer-base pressures 22632.06 Pa (11 km), 5474.889 Pa (20 km),
868.0187 Pa (32 km), 110.9063 Pa (47 km), 66.93887 Pa (51 km), 3.956420 Pa (71 km) to 0.05%
(`__tests__/atmosphere.test.ts`).

For a live prediction the density column is the forecast's own temperature and geopotential height
at each pressure level, ρ = p/(R T), hydrostatic between levels (`Column`). The tropical stratosphere
is warmer than the ISA, so for the same gas quantity a burst at ~32 km in the GFS column corresponds
to ~31.3 km in the ISA. Both numbers are shown.

### 2.2 Fill and ascent — `balloon.ts`

```
neck lift (spring scale, payload detached)   L_neck = V0 (ρ_air − ρ_gas) − m_balloon        [kg]
free lift                                    L_free = L_neck − m_under_balloon              [kg]
volume aloft (latex unstressed)              V(z)   = n R T(z) / p(z)                        [m³]
quasi-steady force balance                   v(z)   = sqrt( 2 g L_free / (ρ(z) C_D A(z)) ),  A = π D²/4
burst                                        D(z) ≥ D_burst
```

Sources: Gallice et al. 2011 eq. (1)–(3); Renegar (UMD) eq. 19; Conner's flight data show vertical
accelerations < 0.008 m/s², which justifies quasi-steady.

**Drag coefficient.** Three models are implemented and selectable:

| model | C_D | effect on ascent rate with height | source |
|---|---|---|---|
| constant (default for the *fill plan*) | 0.25 (≥1200 g), 0.30 (600–1000 g) | v ∝ ρ^(−1/6): ~2× faster at 30 km | CUSF/SondeHub `calc.js`, calibrated to Totex/Kaymont free-lift tables |
| **Gallice 2011 (default for the *flight*)** | 0.04808 (ln Re)² − 1.406 ln Re + 10.49, Re = ρ R v/μ (radius-based) | nearly flat: within ±25% of the pad value to 30 km | Gallice, Wienhold, Hoyle, Immler, Peter, *Atmos. Meas. Tech.* 4, 2235 (2011), eq. (6), fitted to 10 Totex TX1200 night flights |
| ASTRA | 0.425 below Re 3.3e5 falling to 0.225 | intermediate | Southampton `astra_simulator/flight_tools.py` |

The Gallice curve is applied as a *shape*: one multiplier scales it so that the ascent rate at the
pad equals the planned (or measured) value. Gallice reports the per-balloon offset as multiplicative
(±25%), so anchoring removes it. Burst altitude does not depend on the drag model at all (it depends
on gas quantity and burst diameter); **time to burst does, by 25–30 minutes for this vehicle**:

| model | time to 31.3 km at 5.0 m/s pad rate | mean ascent rate |
|---|---|---|
| constant C_D (as in `tools/flight_profile.py` and the NOTAM draft's "T+73.7 min") | ~74 min | ~7 m/s |
| Gallice C_D(Re) | ~94 min | ~5.5 m/s |
| radiosonde statistics: Seidel et al. 2011, 552,962 soundings, median elapsed time to 10 hPa (≈31 km) | 103 min | 5.05 m/s |

Voggenberger et al. 2024 (*GMD* 17, 3783) found a constant 5 m/s "sufficient" over a global
radiosonde set; Kräuchi et al. 2016 measured 5 ± 0.8 m/s on a 1200 g balloon. The constant-C_D model's
doubling of the ascent rate in the stratosphere is not observed; the near-constant Gallice profile is.
**The NOTAM flight profile in `docs/09-aai-notam-request.md` should be re-issued from this predictor**
(ascent ~94 min, not 74; total ~2 h 10 min, not 2 h 02 min).

**Balloon table** (`BALLOONS`), burst diameters in metres:

| balloon | burst Ø | source |
|---|---|---|
| Kaymont/Totex 1200 g | 8.63 | Kaymont KCI/HAB-1200 sheet: 863 cm, 33.2 km at 1050 g payload with 1190 g free lift |
| Hwoyee HY-1200 | 9.10 (2024 table) / 8.50 (older UKHAS table) | hwoyee.com product table ("≥ 9100 mm"), adopted by SondeHub 2024-11 |
| Pawan CPR-1200 (Pune) | 8.00 | Pawan Rubber Products data sheet 2012: 800 cm, 31 km at 1000 g payload, 1180 g free lift, 325 m/min |

Real flights (UKHAS flight database): Hwoyee 1200s burst 0.1–6 km *above* the Totex-model prediction;
Kaymont/Totex burst up to 3 km *below* it. Pawan is used by IIA Bangalore and ISRO, publishes 31 km
at 1 kg, and gives ~1.5 km less than a Totex for the same fill. Which brand flies is a decision the
predictor cannot make; the balloon selector exists for that reason.

**Burst scatter**: Weibull, shape k = 14.3577 (ASTRA's fit to observed bursts; CV ≈ 8.5% in diameter
≈ ±1.5 km in burst altitude, the same magnitude Gallice reports from drag variability alone).

**CUSF/SondeHub calculator** (`cusfBurstCalc`): a line-for-line transcription of
`sondehub.org/calc/js/calc.js`, **verified to the metre against the live page** on 2026-09-20 for
five cases (`__tests__/cusf_reference.test.ts`), e.g. Kaymont 1200 g, 2000 g payload, hydrogen,
5 m/s → 32,264 m, 108 min, 3,151 g neck lift, 3.90 m³. Its known simplifications: sea-level air
density 1.2050 kg/m³ regardless of site elevation (Jejuri's air is 7% thinner), exponential
atmosphere with 7238.3 m scale height, constant ascent rate.

### 2.3 Descent — `descent.ts`

```
v(z) = sqrt( 2 m g / (ρ(z) C_D0 S0) ),  S0 = π D0²/4 on the CONSTRUCTED canopy diameter
```

Knacke, *Parachute Recovery Systems Design Manual* (NWC TP 6575), Table 5-1, C_D0 on nominal area:
flat circular 0.75–0.80, conical 0.75–0.90, hemispherical 0.62–0.77, cross 0.60–0.85. Sirks et al.
2020 (arXiv:2004.10764, 26 stratospheric descents under a 1.22 m chute): the √(ρ₀/ρ) law
over-predicts descent speed by 3.7 ± 0.4% with 20% flight-to-flight scatter. Quasi-steady terminal
speed is used throughout; the relaxation time is ~2 s at 31 km and 0.3 s at the ground, so the
post-burst transient is < 150 m of fall (Renegar: canopies inflate "within a few seconds").

> **Open point for Aditya.** `tools/flight_profile.py` uses C_D = 1.5 on a 1.2 m circle, giving
> 4.8 m/s at low level (the NOTAM's figure). On a constructed-area basis, Knacke's 0.75 makes the same
> 1.2 m canopy descend at 6.6 m/s at sea level and 7.0 m/s at the pad, which the app flags. Which is
> right depends on how the chute's "1.2 m" is defined and on its shape. Measure the low-level descent
> rate on the first test flight and enter it directly ("sea-level descent rate" mode).

### 2.4 Wind field and integrator — `wind.ts`, `trajectory.ts`, `data/openmeteo.ts`

* Open-Meteo forecast API, verified 2026-09-20 by direct requests: GFS (`gfs_seamless`) gives 23
  pressure levels 1000…10 hPa (10 hPa ≈ 31.2 km) hourly to 16 days; ICON 19 levels to 30 hPa; ECMWF
  IFS 14 levels to 10 hPa. Each level supplies wind, geopotential height and temperature. Below the
  first pressure level the 10/80/120/180 m above-ground winds are used (Tawhiri leaves them unused).
* A 5 × 5 grid of columns at 0.5° spacing (±110 km) over 10–15 hours is fetched in one request
  (~70 kB). Interpolation: bilinear in lat/lon, linear in time, linear in altitude — the scheme of
  Tawhiri's `interpolate.pyx`. Above the top level the top wind is held and the run is flagged.
* Integrator: RK4, 5 s step, state (lat, lon, z), Tawhiri's spherical stepping (R = 6371009 m + z).
* Terrain: landing ends at the ground height from Mapbox Terrain-RGB tiles (≈9 m/px at zoom 14; the
  Copernicus GLO-90 API is the fallback), re-flown until converged within 15 m. Tawhiri uses a 15"
  DEM; ASTRA stops at 0 m.

**Verified:**
* uniform wind, constant ascent, steady descent: displacement equals U·(t_up + t_down) to 0.5%
  (`__tests__/trajectory.test.ts`);
* on the same measured Pune sounding, this integrator and the repo's independent Python
  `tools/drift_sim.py` agree to **0.01–0.04% in range** on five Oct 2019 / Nov 2025 soundings
  (`scripts/crosscheck_drift_sim.ts`). Before the extractor was fixed to place pressure-only wind
  levels (see 4.1) the two disagreed by up to 8% — a real bug, caught by a test that could fail.

### 2.5 Monte Carlo — `montecarlo.ts`
Per run: burst diameter (Weibull k = 14.36, mean = nominal × factor), neck lift N(1, 5%), payload
N(1, 3%), chute C_D uniform ±20%, balloon remnant 3–100% of envelope mass carried down (all ASTRA
defaults), and wind: one of the 50 ECMWF ensemble members' deviations from the control at the pad
column (a real, flow-dependent spread; 14 levels), or, if the ensemble is unavailable, an *assumed*
AR(1) perturbation with σ = 2.5 m/s and 2 km vertical correlation, labelled as such in the UI.
Output: 50/90/95% covariance ellipses (χ², 2 d.o.f.).

Reference points from practitioners: Akerman — 5-mile radius plus 5% of distance; Randall — a
10 × 5 km oval for a 50 km flight; Wyoming Space Grant — night-before SondeHub predictions within
8 km ~70% of the time, within 24 km >90%.

---

## 3. Wind data for Pune

### 3.1 Sources and what each is worth

| source | what | coverage found | status |
|---|---|---|---|
| NOAA IGRA v2, Pune (INM00043063, 18.53 N 73.85 E, 555 m; 43 km NW of the pad) | measured radiosonde, 00Z and 12Z | 850 soundings reaching ≥30 km since 2016, but **only 1 in 2021–2022, 29 in 2023–2024**; 34 in 2025, 86 in Jan–Sep 2026 | primary for climatology; thin for "last 3–4 years" |
| IGRA Mumbai/Santacruz (INM00043003, 120 km W) | measured | 1,085 deep soundings 2022–2026 | fills the recent years |
| IGRA Nagpur (INM00042867, 500 km NE) | measured | 1,399 deep soundings 2022–2026 | regional context |
| IGRA Goa, Hyderabad | measured | 734 / 800 since 2016 | regional context |
| Open-Meteo historical-forecast archive, GFS column at the pad, 05 and 06 UTC daily | **model**, short-lead forecast, 23 levels | every day Jan 2022 – Aug 2026 (3,408 columns) | continuous "last 4 years" at exactly the launch hour, but not a measurement |
| ERA5 pressure levels | reanalysis | Open-Meteo's ERA5 endpoint returns no pressure-level variables (verified); CDS needs an account | **not used** |

Surface winds: the Pune station reports 0.0 m/s at the surface in most records, so launchability on a
given morning must come from Pune airport METARs and an anemometer at the pad, not from this data.

### 3.2 GFS column vs Pune radiosonde, same days (`scripts/verify_gfs_vs_igra.ts`)

15 paired days (Nov 2025), GFS at 05 UTC vs sonde at 00 UTC, 43 km apart — so this is an upper bound
on the model error the predictor inherits:

| altitude | RMS vector difference | mean measured speed |
|---|---|---|
| 1 km | 3.7 m/s | 6.7 m/s |
| 5 km | 2.2 m/s | 5.1 m/s |
| 12 km | 3.3 m/s | 19.2 m/s |
| 20 km | 3.9 m/s | 8.8 m/s |
| 28 km | 5.4 m/s | 9.3 m/s |

Over all 131 paired days 2023–2026 the 1–2 km RMS is 2.9–3.7 m/s. A 3 m/s error held over a 2-hour
flight is ~20 km of landing error if fully correlated, ~5 km if it decorrelates every 2 km of
altitude — which is why the Monte Carlo uses the ensemble rather than a single number.

### 3.3 What the October–November atmosphere over Pune does
Low troposphere from the east/north-east after the monsoon withdraws (~11 Oct); the subtropical
westerly jet builds from ~10 km and peaks near 12–14 km (Nov 2025 mean 19 m/s at 12 km); the summer
stratospheric easterlies persist above ~20 km into November and reverse to westerlies in winter. A
flight therefore goes **west** through the jet and is pulled **back east** above 20 km; the app's
"Where the drift comes from" table quantifies the return for each forecast, and the Climatology tab's
mean-u chart shows the sign change with altitude for any month.

### 3.3a Open-Meteo quota, and what one prediction costs

Open-Meteo's free tier allows 600 calls per minute, 5,000 per hour and 10,000 per day, and a
request with many locations, variables or days is weighted as several calls (their weighting
formula is not published in a form that can be cited here). The app therefore:

* fetches a 9×9 grid of columns at the model's native 0.25° spacing (81 locations, ±110 km) over
  a 10-hour window (15 hours with the launch-time sweep), ~100 variables per column — one request;
* fetches the 51-member ECMWF ensemble at the pad for the launch hour — one request;
* looks up the ground height at the landing point (up to three refinements) from Mapbox Terrain-RGB
  tiles decoded in the browser — no Open-Meteo call; the Copernicus elevation API is only the fallback;
* **caches** the grid and ensemble for 30 minutes, DEM points for the session and archive months
  for the day, so changing the balloon, fill, parachute or Monte Carlo settings and pressing
  Predict again costs **zero** API calls. The status line reports the requests made by each run.

The on-demand climatology fetch is the heavy one: each month is one request of ~92 variables
over ~30 days. The bundled Pune archive exists so that this is not needed for the home site.
A 429 answer is shown as a message naming the limit; the data already cached keeps working.
The 3-D terrain reads Mapbox tiles, not Open-Meteo.

### 3.3b Alternatives to the free Open-Meteo API (no quota, no loss of accuracy)

| route | cost | data | setup |
|---|---|---|---|
| **NOAA NOMADS bridge** (recommended) | free, no key; NOAA asks for ≤120 requests/min per IP | the native GFS 0.25° GRIB2: every grid point in the box, hourly, 41 pressure levels 1000–1 hPa (≈48 km, so no held wind above 31 km), 10/80/100 m winds, model orography — no interpolation before the integrator | `npm run bridge:setup` once (Python venv + ecCodes), then `npm run bridge` alongside `npm run dev`; the app detects it and selects it |
| Open-Meteo customer API | €29/month (Standard, 1M weighted calls/month, no hourly/daily cap) | identical to the free API | `VITE_OPEN_METEO_API_KEY=…` in `.env` |
| self-hosted Open-Meteo | free; needs Docker and a few GB of disk | identical to the free API, served from your machine, unlimited | `docker run -p 8080:8080 ghcr.io/open-meteo/open-meteo` with the sync commands from the Open-Meteo README, then `VITE_OPEN_METEO_BASE=http://localhost:8080` |

The bridge (`scripts/gfs_nomads_bridge.py`) uses NOAA's GRIB filter (their OpenDAP subsetting
was retired in 2025), decodes with ecCodes, caches each decoded forecast hour on disk under
`.cache/nomads` and serves the columns as JSON on `localhost:8787`. A 13-hour window for a ±1°
box is ~13 files of 70 kB, about 40 s cold and instant afterwards. The ECMWF ensemble for the
Monte Carlo spread and the geocoder still come from Open-Meteo (one small request each, cached);
if those are throttled the Monte Carlo falls back to the labelled AR(1) wind spread and the
landing ends at the pad elevation with a warning, rather than failing.

**Accuracy is never traded for quota.** The default Open-Meteo grid is the full 9×9 at the
model's native 0.25° spacing over ±1°; coarser presets exist only for a throttled API; the bridge
always returns every native point with all 41 levels. Caching, not thinning, is what keeps repeat
runs free.

### 3.4 Any other city in India (or anywhere)

The **Predict** tab is not tied to Pune: type a place name in the "Place" box (Open-Meteo/GeoNames
geocoding), enter coordinates, drag the marker, or use "Pick pad on map" and click. The GFS/ICON/ECMWF
grid, the ECMWF ensemble, the DEM lookups and the Tawhiri comparison are all fetched for whatever
point is set, anywhere on Earth. The pad elevation is re-read from the Copernicus DEM each time.

For **climatology** at another site there are two routes:

* **GFS archive at the current pad, fetched on demand** — in the Climatology tab choose the source
  "GFS model column at the current pad"; it pulls the Open-Meteo archive for the selected months and
  years at your launch hour (one request per month, ~0.7 MB; archive starts April 2021). This is a
  model, not a measurement, but it exists for every point.
* **Measured radiosondes** — bundle more IGRA stations. Every Indian station with data through 2025
  is in the IGRA list (New Delhi 42182, Kolkata 42809, Bengaluru 43295, Hyderabad 43128, Chennai is
  43279 via Karaikal 43346/Machilipatnam 43185, Ahmedabad 42647, Jodhpur 42339, Lucknow 42369,
  Bhubaneswar 42971, Guwahati 42410, Thiruvananthapuram 43371, Visakhapatnam 43150, Nagpur 42867,
  Bhopal 42667, Jaipur 42348, Patna 42492, Srinagar 42027, …). Download `INM000<id>-data.txt.zip`
  from the IGRA `data-por` directory, unzip it next to the others, and run

  ```bash
  python3 scripts/igra_extract.py --igra-dir <dir> --out public/data/igra_profiles.json --stations INM00043295:2016,INM00042182:2022
  ```

  The station's name and coordinates are taken from the IGRA station list; the Climatology tab lists
  every bundled station with its distance from the current pad. Upper winds are synoptic-scale, so a
  station within ~150 km is representative for the flight above the boundary layer.

---

## 4. Data preparation scripts

### 4.1 `scripts/igra_extract.py`
Parses IGRA v2 `-data.txt` files (fixed-width format documented in the script), keeps soundings with
≥20 wind levels reaching ≥30 km, places wind-only levels that carry pressure but no height by
interpolating the same sounding's own pressure–height pairs (the repo's `drift_sim.py` uses an ISA
conversion, which in the tropics is off by up to ~400 m at 30 km), resamples to a 250 m grid and writes
`public/data/igra_profiles.json` (4,868 profiles, 5.9 MB).

```bash
# download: https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/access/data-por/INM00043063-data.txt.zip (and 43003, 42867, 43192, 43128)
python3 scripts/igra_extract.py --igra-dir <dir> --out public/data/igra_profiles.json
```

### 4.2 `scripts/fetch_gfs_hist.py` and `scripts/gfs_extract.py`
Pull the Open-Meteo historical-forecast GFS columns at the pad month by month (all 23 levels, four
variables, 04–09 UTC), then keep 05 and 06 UTC and write `public/data/gfs_jejuri_profiles.json`.

### 4.3 `scripts/crosscheck_drift_sim.ts`, `scripts/verify_gfs_vs_igra.ts`
The two verification scripts described above.

---

## 5. Open-source predictors surveyed, and what was taken from each

| predictor | read | taken | known failure modes (from their issues/wiki/users) |
|---|---|---|---|
| CUSF **Tawhiri** (`cuspaceflight/tawhiri`, SondeHub fork `projecthorus/tawhiri`) | `solver.pyx`, `models.py`, `interpolate.pyx`, `dataset.py`, API docs | RK4 structure, spherical stepping, interpolation scheme, API used live for comparison | constant ascent rate; descent `v_sl·1.1045/√ρ` with a NASA fit; 0.5°/3 h GFS ~5 h late; 10/80/100 m winds unused; launch altitude silently 0 if DEM lookup fails (SondeHub); longitude must be 0–360; open issue #107 (shifted final ascent point) |
| CUSF **burst calculator** (`ukhas/cusf-burst-calc`, sondehub.org/calc) | `calc.js` both copies | exact transcription as cross-check; balloon tables | sea-level density everywhere; exponential atmosphere; Hwoyee/Pawan data "guesswork" per its own comments; Hwoyee 1200 revised 8.50 → 9.10 m in 2024 |
| Southampton **ASTRA** (`sobester/astra_simulator`) | `simulator.py`, `flight_tools.py`, `available_balloons_parachutes.py` | Re-dependent C_D option, Weibull burst statistics, Monte Carlo perturbation set | lands at 0 m MSL (no DEM); GFS 0.25° only to 10 hPa; web planner offline |
| SondeHub live predictor, HYSPLIT balloon tool, steeman.be | read | descent re-prediction idea (measure the rate, re-run) | – |

Accuracy claims found (all second-hand, URLs in `docs/` of the survey): "within 10 km" is the common
experience for ~30 km flights when burst altitude, ascent rate and descent rate are right; errors of
20–70 km in the EOSS reports all trace to a wrong descent rate, a wrong ascent rate through the jet,
or an early burst — not to the wind field.

---

## 6. What is **not** done, and what to do on the first test flight

* Nothing has been checked against one of this team's own flights yet. Record on the first test:
  neck lift, ascent rate per kilometre, burst altitude, descent rate at 5 km, landing point. Those
  five numbers calibrate the drag curve scale, the burst-diameter factor and the chute C_D.
* The gas-temperature lag (Gallice's diffusion model, the tropopause dip) is not implemented.
* The ECMWF ensemble has only three stratospheric levels; spread above 20 km is coarse.
* GFS tops out at 10 hPa (31.2 km); a burst above that uses the held wind (flagged). Tawhiri's 47
  levels to 1 hPa are shown alongside for that reason.
* Pawan CPR-1200 figures are from a 2012 data sheet; no current production data were found.
* Parachute opening, tangling with remnants and oscillation (Ingleby 2022, Kräuchi 2016) are only
  represented by the C_D spread.
* Forecast skill: nothing beyond ~7 days is reliable (Akerman; Wyoming Space Grant). For the 24/31
  October launch, use the Climatology tab now and the Predict tab from ~17 October.
* Launch-day surface conditions are not in this tool (see 3.1).

## 7. Result for the current default case (run 2026-09-20 17:40 IST, launch 21 Sep 2026 11:00 IST)

Kaymont 1200 g, hydrogen, 2.0 kg under the balloon, 5.0 m/s at the pad, 1.2 m chute C_D 0.75:
neck lift 3,094 g; burst 31,969 m after 1 h 34 min, 53 km west; landing 66.4 km at 277° after
2 h 08 min on 680 m ground; Monte Carlo (300 flights, 50 ENS members) median 67.1 km, 95th
percentile 78.9 km, 90% ellipse 15.6 × 7.6 km along 275°; SondeHub/Tawhiri with the same parameters
landed 7.1 km away. That is a September (monsoon-tail) day; the October–November regime is different,
which is what the climatology is for.

## 8. Climatology result for this vehicle (Pune radiosondes, Oct–Nov 2016–2026, 195 soundings)

Same vehicle flown on each measured atmosphere (no Monte Carlo, ISA column, landing at pad height):

| statistic | range |
|---|---|
| median | 36.7 km (19.8 NM) |
| 75th / 90th / 95th percentile | 51.5 / 59.7 / 66.1 km |
| 99th percentile / worst | 79.0 / 98.4 km |
| landing bearing | W 31%, NE 23%, NW 16%, E 14% |
| flight duration, median | 128 min |

32 of the 195 soundings end between 30 km and the 31.3 km burst; the top wind is held for that gap.
For comparison the NOTAM draft (from `tools/drift_sim.py`, with vehicle dispersions) quoted a median
of 34.7 km and a 95th percentile of 64.1 km — consistent; the extra 2 km here is the longer Gallice
ascent. Mean wind at 12 km in Oct/Nov is 15 m/s from the WSW (max 38 m/s); above 20 km it is 7–12 m/s
from the east, which is the reversal that turns most flights back.
