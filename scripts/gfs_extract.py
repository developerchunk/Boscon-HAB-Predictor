#!/usr/bin/env python3
"""
Build a compact daily launch-time wind-profile archive at Jejuri from Open-Meteo's
historical-forecast archive of GFS (gfs_seamless) pressure-level fields.

  python3 scripts/gfs_extract.py --in-dir <dir of jejuri_gfs_YYYY-MM.json> --out public/data/gfs_jejuri_profiles.json

Source: https://historical-forecast-api.open-meteo.com/v1/forecast (model gfs_seamless, i.e. the
NOAA GFS 0.25 deg / 0.11 deg blend as archived by Open-Meteo, hourly, 23 levels 1000..10 hPa).
These are short-lead FORECASTS archived day by day, not analyses, and not measurements.

For each day we keep the 05:00 and 06:00 UTC columns (launch 11:00 IST = 05:30 UTC) and
resample u, v onto the same 250 m grid the IGRA profiles use, using each level's forecast
geopotential height as its altitude. Temperature and pressure per level are kept too, so a
real density column can be built.
"""
import argparse, json, glob, math, os

GRID_STEP = 250
LEVELS = [1000,975,950,925,900,850,800,700,600,500,400,300,250,200,150,100,70,50,40,30,20,15,10]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--in-dir", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    profiles = []
    files = sorted(glob.glob(os.path.join(a.in_dir, "jejuri_gfs_*.json")))
    for fn in files:
        d = json.load(open(fn)); h = d["hourly"]
        for i, t in enumerate(h["time"]):
            if t[11:13] not in ("05", "06"):
                continue
            lv = []
            for p in LEVELS:
                z = h[f"geopotential_height_{p}hPa"][i]; ws = h[f"wind_speed_{p}hPa"][i]; wd = h[f"wind_direction_{p}hPa"][i]; T = h[f"temperature_{p}hPa"][i]
                if z is None or ws is None or wd is None or T is None:
                    continue
                r = math.radians(wd)
                lv.append((z, -ws * math.sin(r), -ws * math.cos(r), T + 273.15, p * 100.0))
            lv.sort()
            if len(lv) < 15 or lv[-1][0] < 30000:
                continue
            # resample u,v to the 250 m grid from 0 to the top level
            grid = []; j = 0; zz = 0.0
            while zz <= lv[-1][0]:
                if zz <= lv[0][0]:
                    u, v = lv[0][1], lv[0][2]
                else:
                    while j < len(lv) - 2 and lv[j + 1][0] < zz: j += 1
                    z0, u0, v0, *_ = lv[j]; z1, u1, v1, *_ = lv[j + 1]
                    f = (zz - z0) / (z1 - z0) if z1 > z0 else 0.0
                    u = u0 + f * (u1 - u0); v = v0 + f * (v1 - v0)
                grid.append([int(round(u * 10)), int(round(v * 10))]); zz += GRID_STEP
            profiles.append({"d": t[:10], "h": int(t[11:13]), "uv": grid,
                             "col": [[int(round(z)), int(round(T * 10)), int(p)] for z, _, _, T, p in lv]})
    out = {"meta": {"grid_step_m": GRID_STEP, "units": "uv: 0.1 m/s (u east, v north) per 250 m from 0 m AMSL; col: [z m, T 0.1 K, p Pa] per pressure level",
                    "source": "Open-Meteo historical-forecast API, model gfs_seamless, point 18.286293N 74.123039E, downloaded 2026-09-20",
                    "hours_utc": [5, 6]}, "profiles": profiles}
    json.dump(out, open(a.out, "w"), separators=(",", ":"))
    print("profiles:", len(profiles), "->", a.out, os.path.getsize(a.out) // 1024, "kB")
    days = sorted({p["d"][:7] for p in profiles}); print("months:", days[0], "..", days[-1], len(days))

if __name__ == "__main__":
    main()
