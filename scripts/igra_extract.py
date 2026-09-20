#!/usr/bin/env python3
"""
Extract measured upper-air wind profiles from NOAA IGRA v2 station files into a
compact JSON the predictor can fly trajectories against in the browser.

  python3 scripts/igra_extract.py --igra-dir <dir with INM000*-data.txt> --out public/data/igra_profiles.json
  python3 scripts/igra_extract.py --igra-dir <dir> --out ... --stations INM00043295:2016,INM00042182:2022   # add any IGRA station
    (id:year_from; the station file must be downloaded into --igra-dir first; name/coordinates come from
     the IGRA station list, downloaded automatically if --station-list is not given)

Source: NOAA NCEI Integrated Global Radiosonde Archive v2
  https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/access/data-por/<ID>-data.txt.zip
Record format (IGRA v2 data-por, fixed width, 1-indexed columns):
  LVLTYP1 1  LVLTYP2 2  ETIME 4-8  PRESS 10-15 (Pa)  PFLAG 16  GPH 17-21 (m)  ZFLAG 22
  TEMP 23-27 (0.1 C)  TFLAG 28  RH 29-33 (0.1 %)  DPDP 35-39 (0.1 C)  WDIR 41-45 (deg FROM)  WSPD 47-51 (0.1 m/s)
  Header: '#' ID(2-12) YEAR(14-17) MONTH(19-20) DAY(22-23) HOUR(25-26) RELTIME(28-31) NUMLEV(33-36) ...
Missing = -9999 (or -8888 for GPH/PRESS in some files).

Wind-only levels (LVLTYP2 = 2) often carry a pressure but no geopotential height. They are
given an altitude by interpolating ln(p) -> z between the levels of the SAME sounding that
report both, and dropped if the sounding has fewer than 5 such anchors or the pressure is
outside the anchored range. (tools/drift_sim.py uses an ISA conversion instead, which in the
tropics is off by up to ~400 m at 30 km.)

What is kept: a sounding is kept only if it has >= MIN_LEVELS wind levels and its highest
wind level is >= MIN_TOP m, i.e. it actually measured the whole column a ~31 km flight uses.
Each kept sounding is resampled onto a fixed 250 m altitude grid (linear in u, v between
measured levels; no extrapolation above the top measured level — the grid is cut there).
u = eastward, v = northward, in m/s, stored as integers in 0.1 m/s.
"""
import argparse, json, math, os, collections

STATIONS = {
    "INM00043063": {"name": "Pune", "lat": 18.5333, "lon": 73.8500, "elev_m": 555.0, "year_from": 2016},
    "INM00043003": {"name": "Mumbai (Santacruz)", "lat": 19.1167, "lon": 72.8500, "elev_m": 14.2, "year_from": 2022},
    "INM00042867": {"name": "Nagpur (Sonegaon)", "lat": 21.1000, "lon": 79.0500, "elev_m": 310.0, "year_from": 2022},
    "INM00043192": {"name": "Goa (Panjim)", "lat": 15.4833, "lon": 73.8167, "elev_m": 59.0, "year_from": 2016},
    "INM00043128": {"name": "Hyderabad", "lat": 17.4500, "lon": 78.4667, "elev_m": 530.0, "year_from": 2016},
}
GRID_STEP = 250
GRID_TOP = 34000
MIN_TOP = 30000
MIN_LEVELS = 20


def parse_station(path, year_from):
    hdr = None
    levels = []
    pending = []   # (p, u, v) wind levels with pressure but no height
    anchors = []   # (ln p, z) from levels with both
    out = []

    def flush():
        if hdr is None:
            return
        if pending and len(anchors) >= 5:
            an = sorted(anchors, key=lambda a: -a[0])  # descending pressure = ascending height
            lp = [a[0] for a in an]; zz = [a[1] for a in an]
            for pp, u, v in pending:
                l = math.log(pp)
                if l > lp[0] or l < lp[-1]:
                    continue
                k = 0
                while k < len(lp) - 2 and lp[k + 1] > l:
                    k += 1
                f = (l - lp[k]) / (lp[k + 1] - lp[k]) if lp[k + 1] != lp[k] else 0.0
                levels.append((zz[k] + f * (zz[k + 1] - zz[k]), u, v))
        lv = sorted(levels)
        ded = []
        for z, u, v in lv:
            if ded and abs(z - ded[-1][0]) < 1.0:
                continue
            ded.append((z, u, v))
        if len(ded) < MIN_LEVELS or ded[-1][0] < MIN_TOP:
            return
        out.append((hdr, ded))

    with open(path, errors="replace") as f:
        for ln in f:
            if ln[0] == "#":
                flush()
                levels = []; pending = []; anchors = []
                try:
                    yr = int(ln[13:17]); mo = int(ln[18:20]); dy = int(ln[21:23]); hr = int(ln[24:26])
                except ValueError:
                    hdr = None
                    continue
                hdr = (yr, mo, dy, hr) if yr >= year_from else None
                continue
            if hdr is None:
                continue
            try:
                press = int(ln[9:15]); gph = int(ln[16:21]); wd = int(ln[40:45]); ws = int(ln[46:51])
            except ValueError:
                continue
            has_z = gph > -8000
            has_p = press > 0
            if has_z and has_p:
                anchors.append((math.log(press), float(gph)))
            if wd < 0 or wd > 360 or ws < 0:
                continue
            spd = ws / 10.0
            rad = math.radians(wd)
            u, v = -spd * math.sin(rad), -spd * math.cos(rad)
            if has_z:
                levels.append((float(gph), u, v))
            elif has_p:
                pending.append((float(press), u, v))
    flush()
    return out


def resample(levels):
    zs = [l[0] for l in levels]
    top = min(zs[-1], GRID_TOP)
    grid = []
    z = 0
    i = 0
    while z <= top:
        if z <= zs[0]:
            u, v = levels[0][1], levels[0][2]
        else:
            while i < len(levels) - 2 and zs[i + 1] < z:
                i += 1
            z0, u0, v0 = levels[i]; z1, u1, v1 = levels[i + 1]
            f = (z - z0) / (z1 - z0) if z1 > z0 else 0.0
            u = u0 + f * (u1 - u0); v = v0 + f * (v1 - v0)
        grid.append([int(round(u * 10)), int(round(v * 10))])
        z += GRID_STEP
    return grid


STATION_LIST_URL = "https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/doc/igra2-station-list.txt"


def station_meta(sid, list_path):
    """Name, lat, lon, elevation from the IGRA station list (fixed width: id 1-11, lat 13-20, lon 22-30, elev 32-37, name 42-71)."""
    import urllib.request, ssl
    if list_path is None or not os.path.exists(list_path):
        list_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "igra2-station-list.txt")
        if not os.path.exists(list_path):
            try:
                import certifi; ctx = ssl.create_default_context(cafile=certifi.where())
            except ImportError:
                ctx = ssl.create_default_context()
            with urllib.request.urlopen(STATION_LIST_URL, timeout=60, context=ctx) as r, open(list_path, "wb") as f:
                f.write(r.read())
    for ln in open(list_path, errors="replace"):
        if ln.startswith(sid):
            return {"name": ln[41:71].strip().title(), "lat": float(ln[12:20]), "lon": float(ln[21:30]), "elev_m": float(ln[31:37])}
    raise SystemExit(f"{sid} not in the IGRA station list")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--igra-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--stations", default="", help="extra stations as ID:year_from,ID:year_from (added to the built-in Pune-region set)")
    ap.add_argument("--only-extra", action="store_true", help="use only the --stations list, not the built-in set")
    ap.add_argument("--station-list", default=None, help="path to igra2-station-list.txt (downloaded if absent)")
    a = ap.parse_args()
    stations = {} if a.only_extra else dict(STATIONS)
    for item in [x for x in a.stations.split(",") if x.strip()]:
        sid, _, yf = item.partition(":")
        meta = station_meta(sid.strip(), a.station_list)
        stations[sid.strip()] = dict(meta, year_from=int(yf) if yf else 2016)
    result = {"meta": {"grid_step_m": GRID_STEP, "units": "u,v in 0.1 m/s; u east, v north; index i is altitude i*grid_step_m AMSL",
                       "min_top_m": MIN_TOP, "min_levels": MIN_LEVELS,
                       "source": "NOAA IGRA v2 data-por files, downloaded 2026-09-20"},
              "stations": {}, "profiles": []}
    for sid, info in stations.items():
        path = os.path.join(a.igra_dir, f"{sid}-data.txt")
        if not os.path.exists(path):
            print("missing", path); continue
        snd = parse_station(path, info["year_from"])
        by_ym = collections.Counter((h[0], h[1]) for h, _ in snd)
        result["stations"][sid] = dict(info, n_profiles=len(snd),
                                       per_year={str(y): sum(c for (yy, m), c in by_ym.items() if yy == y) for y in range(info["year_from"], 2027)})
        for (yr, mo, dy, hr), lv in snd:
            result["profiles"].append({"s": sid, "d": f"{yr:04d}-{mo:02d}-{dy:02d}", "h": hr, "uv": resample(lv)})
        print(f"{info['name']:20s} {len(snd):5d} deep soundings from {info['year_from']}")
    with open(a.out, "w") as f:
        json.dump(result, f, separators=(",", ":"))
    print("wrote", a.out, os.path.getsize(a.out) // 1024, "kB,", len(result["profiles"]), "profiles")


if __name__ == "__main__":
    main()
