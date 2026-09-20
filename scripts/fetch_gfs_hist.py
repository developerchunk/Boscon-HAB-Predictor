"""Pull GFS pressure-level profiles at Jejuri from Open-Meteo's historical-forecast archive,
one file per month, hours 05:00 and 06:00 UTC only are kept (11:00 IST launch is 05:30 UTC),
plus 07..09 UTC so a 2-3 h flight can be time-interpolated."""
import json, urllib.request, time, os, sys
lat, lon = 18.286293, 74.123039
levels = [1000,975,950,925,900,850,800,700,600,500,400,300,250,200,150,100,70,50,40,30,20,15,10]
vars_ = []
for p in levels:
    vars_ += [f"wind_speed_{p}hPa", f"wind_direction_{p}hPa", f"geopotential_height_{p}hPa", f"temperature_{p}hPa"]
hv = ",".join(vars_)
import calendar
for year in [2022, 2023, 2024, 2025, 2026]:
    for month in range(1, 13):
        if year == 2026 and month > 8: break
        out = f"gfs_hist/jejuri_gfs_{year}-{month:02d}.json"
        if os.path.exists(out): continue
        last = calendar.monthrange(year, month)[1]
        url = (f"https://historical-forecast-api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
               f"&start_date={year}-{month:02d}-01&end_date={year}-{month:02d}-{last:02d}&hourly={hv}"
               f"&models=gfs_seamless&wind_speed_unit=ms&timezone=UTC")
        for attempt in range(4):
            try:
                d = json.load(urllib.request.urlopen(url, timeout=120))
                break
            except Exception as e:
                msg = getattr(e, 'read', lambda: b'')()[:200]
                print(year, month, "attempt", attempt, "ERR", str(e)[:80], msg, flush=True)
                time.sleep(20 * (attempt + 1))
        else:
            continue
        h = d["hourly"]
        keep = [i for i, t in enumerate(h["time"]) if t[11:13] in ("04","05","06","07","08","09")]
        slim = {"time": [h["time"][i] for i in keep]}
        for k in vars_:
            slim[k] = [h[k][i] for i in keep]
        json.dump({"meta": {k: d[k] for k in ("latitude","longitude","elevation")}, "units": d["hourly_units"], "hourly": slim}, open(out, "w"))
        print(year, month, "saved", len(keep), "rows", flush=True)
        time.sleep(1.5)
print("done")
