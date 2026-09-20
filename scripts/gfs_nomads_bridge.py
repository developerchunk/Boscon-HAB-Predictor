#!/usr/bin/env python3
"""
Local bridge from NOAA NOMADS (native GFS 0.25 deg GRIB2 subsets) to the predictor.

    python3 -m venv .venv-grib && . .venv-grib/bin/activate && pip install eccodes certifi
    python3 scripts/gfs_nomads_bridge.py            # serves http://localhost:8787

GET /gfs?lat=18.286&lon=74.123&start=2026-09-21T04:00Z&end=2026-09-21T16:00Z&half=1.0
  -> JSON {run, times[], columns[{lat, lon, elevation, times[[{z,u,v,T,p}...]]}]}
     for every native 0.25 deg grid point within +-half degrees, hourly, 41 pressure levels
     (1000 hPa .. 0.01 hPa) plus the 10/80/100 m winds, straight from the GFS GRIB files.

Source: https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25_1hr.pl (NOAA NCEP, public, no key;
NOMADS asks for <= 120 requests/minute per IP). Files are ~70 kB per forecast hour for a 2.5 deg box.
The newest run whose files exist is used (GFS runs 00/06/12/18Z, published ~4-5 h after run time).
Decoded results are cached on disk under .cache/nomads so re-runs make no requests at all.
"""
import http.server, json, os, sys, time, urllib.request, urllib.parse, ssl, hashlib, threading, math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
try:
    import eccodes
except ImportError:
    sys.exit("pip install eccodes (see the docstring)")
try:
    import certifi; CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

PORT = int(os.environ.get("PORT", "8787"))
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cache", "nomads")
os.makedirs(CACHE, exist_ok=True)
FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25_1hr.pl"
LOCK = threading.Semaphore(4)   # parallel downloads, well inside NOMADS' per-minute limit


def grib_url(run: datetime, fhr: int, box):
    q = {"dir": f"/gfs.{run:%Y%m%d}/{run:%H}/atmos", "file": f"gfs.t{run:%H}z.pgrb2.0p25.f{fhr:03d}",
         "var_UGRD": "on", "var_VGRD": "on", "var_HGT": "on", "var_TMP": "on", "all_lev": "on", "subregion": "",
         "toplat": box[3], "bottomlat": box[1], "leftlon": box[0], "rightlon": box[2]}
    return FILTER + "?" + urllib.parse.urlencode(q)


def fetch(url: str, retries=3) -> bytes:
    for k in range(retries):
        try:
            with LOCK:
                with urllib.request.urlopen(url, timeout=90, context=CTX) as r:
                    data = r.read()
            if data[:4] == b"GRIB":
                return data
            raise RuntimeError(f"not GRIB ({len(data)} bytes)")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise FileNotFoundError(url)
            if k == retries - 1:
                raise
            time.sleep(2 * (k + 1))
        except Exception:
            if k == retries - 1:
                raise
            time.sleep(2 * (k + 1))


def decode(data: bytes):
    """GRIB2 bytes -> {"lats":[], "lons":[], "orog": [[...]], "levels": {p_Pa: {"u":[], "v":[], "gh":[], "t":[]}}, "agl": {h: {"u","v"}}, "t2": [...]}"""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".grb2", delete=False) as tf:
        tf.write(data); path = tf.name
    out = {"levels": {}, "agl": {}, "orog": None, "t2": None, "lats": None, "lons": None}
    try:
        with open(path, "rb") as f:
            while True:
                gid = eccodes.codes_grib_new_from_file(f)
                if gid is None:
                    break
                sn = eccodes.codes_get(gid, "shortName"); lt = eccodes.codes_get(gid, "typeOfLevel"); lv = eccodes.codes_get(gid, "level")
                if out["lats"] is None:
                    ni = eccodes.codes_get(gid, "Ni"); nj = eccodes.codes_get(gid, "Nj")
                    la1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"); lo1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
                    dj = eccodes.codes_get(gid, "jDirectionIncrementInDegrees"); di = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
                    scan = eccodes.codes_get(gid, "jScansPositively")
                    lats = [la1 + (j * dj if scan else -j * dj) for j in range(nj)]
                    lons = [((lo1 + i * di + 180) % 360) - 180 for i in range(ni)]
                    out["lats"], out["lons"], out["ni"], out["nj"] = lats, lons, ni, nj
                vals = eccodes.codes_get_values(gid).tolist()
                if lt == "isobaricInhPa" or lt == "isobaricInPa":
                    p = float(lv) * (100.0 if lt == "isobaricInhPa" else 1.0)
                    if p >= 100.0:   # keep 1000 hPa .. 1 hPa
                        out["levels"].setdefault(p, {})[sn] = vals
                elif lt == "heightAboveGround" and sn in ("10u", "10v", "u", "v") and lv in (10, 80, 100):
                    out["agl"].setdefault(int(lv), {})["u" if sn.endswith("u") else "v"] = vals
                elif lt == "heightAboveGround" and sn == "2t":
                    out["t2"] = vals
                elif lt == "surface" and sn == "orog":
                    out["orog"] = vals
                eccodes.codes_release(gid)
    finally:
        os.unlink(path)
    return out


_RUN_CACHE = {"at": 0.0, "run": None}


def latest_available_run(now: datetime, need_fhr: int = 0):
    """Newest 00/06/12/18Z run whose f{need_fhr} file exists on NOMADS (checked with a 1-point GET; cached 10 min)."""
    if _RUN_CACHE["run"] and time.time() - _RUN_CACHE["at"] < 600:
        return _RUN_CACHE["run"]
    base = now.replace(minute=0, second=0, microsecond=0)
    base = base.replace(hour=(base.hour // 6) * 6)
    for back in range(0, 8):
        run = base - timedelta(hours=6 * back)
        probe = grib_url(run, need_fhr, (74.0, 18.0, 74.25, 18.25)).replace("all_lev=on", "lev_500_mb=on").replace("var_UGRD=on&var_VGRD=on&var_HGT=on&var_TMP=on", "var_HGT=on")
        try:
            with urllib.request.urlopen(probe, timeout=30, context=CTX) as r:
                if r.read(4) == b"GRIB":
                    _RUN_CACHE.update(at=time.time(), run=run)
                    return run
        except Exception:
            continue
    raise RuntimeError("no GFS run found on NOMADS in the last 48 h")


def build(lat: float, lon: float, start: datetime, end: datetime, half: float):
    # snap the box to the native grid and widen by one cell so bilinear interpolation never leaves it
    box = (math.floor((lon - half) / 0.25) * 0.25, math.floor((lat - half) / 0.25) * 0.25, math.ceil((lon + half) / 0.25) * 0.25, math.ceil((lat + half) / 0.25) * 0.25)
    run = latest_available_run(datetime.now(timezone.utc))
    fhrs = []
    t = start.replace(minute=0, second=0, microsecond=0)
    while t <= end:
        f = int((t - run).total_seconds() // 3600)
        if 0 <= f <= 384 and (f <= 120 or f % 3 == 0):
            fhrs.append(f)
        t += timedelta(hours=1)
    if not fhrs:
        raise RuntimeError(f"requested window {start:%Y-%m-%dT%H}Z..{end:%Y-%m-%dT%H}Z is outside run {run:%Y-%m-%d %H}Z (+0..384 h)")

    def one(f):
        key = hashlib.md5(f"{run:%Y%m%d%H}|{f}|{box}".encode()).hexdigest()
        cp = os.path.join(CACHE, key + ".json")
        if os.path.exists(cp):
            d = json.load(open(cp))
            d["levels"] = {float(k): v for k, v in d["levels"].items()}   # JSON keys come back as strings
            d["agl"] = {int(k): v for k, v in d["agl"].items()}
            return f, d
        d = decode(fetch(grib_url(run, f, box)))
        json.dump(d, open(cp, "w"))
        return f, d
    with ThreadPoolExecutor(max_workers=4) as ex:
        frames = dict(ex.map(one, fhrs))

    first = frames[fhrs[0]]
    lats, lons, ni = first["lats"], first["lons"], first["ni"]
    R = 287.053; G = 9.80665
    columns = []
    for j, la in enumerate(lats):
        for i, lo in enumerate(lons):
            k = j * ni + i
            elev = first["orog"][k] if first["orog"] else 0.0
            times = []
            for f in fhrs:
                d = frames[f]
                lv = []
                t2 = (d["t2"][k] if d["t2"] else 288.15)
                # near-surface winds: 10/80/100 m above the model orography, T and p by a dry-adiabatic/hydrostatic step
                p_sfc = None
                for h in sorted(d["agl"]):
                    a = d["agl"][h]
                    if "u" in a and "v" in a:
                        T = t2 - 0.0065 * h
                        lv.append({"z": elev + h, "u": a["u"][k], "v": a["v"][k], "T": T, "p": None, "agl": h})
                for p in sorted(d["levels"], reverse=True):
                    L = d["levels"][p]
                    if not all(x in L for x in ("u", "v", "gh", "t")):
                        continue
                    z = L["gh"][k]
                    if p_sfc is None and z > elev:
                        p_sfc = p * math.exp(G * (z - elev) / (R * L["t"][k]))
                    if z < elev + 150:      # level is underground or inside the near-surface layer we already have
                        continue
                    lv.append({"z": z, "u": L["u"][k], "v": L["v"][k], "T": L["t"][k], "p": p})
                for q in lv:
                    if q["p"] is None:
                        ps = p_sfc or 101325.0
                        q["p"] = ps * math.exp(-G * q["agl"] / (R * q["T"])); del q["agl"]
                lv.sort(key=lambda q: q["z"])
                times.append(lv)
            columns.append({"lat": la, "lon": lo, "elevation": elev, "times": times})
    valid = [(run + timedelta(hours=f)).strftime("%Y-%m-%dT%H:%M") for f in fhrs]
    return {"run": f"{run:%Y-%m-%dT%H}:00Z", "times": valid, "lats": lats, "lons": lons, "columns": columns,
            "source": f"NOAA GFS 0.25° run {run:%Y-%m-%d %H}Z via NOMADS grib filter, {len(first['levels'])} pressure levels, native grid"}


class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "*"); self.end_headers()
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/health":
            return self._send(200, b'{"ok":true}')
        if u.path != "/gfs":
            return self._send(404, b'{"error":"use /gfs?lat=&lon=&start=&end=&half="}')
        try:
            lat = float(q["lat"][0]); lon = float(q["lon"][0]); half = float(q.get("half", ["1.0"])[0])
            start = datetime.fromisoformat(q["start"][0].replace("Z", "+00:00")); end = datetime.fromisoformat(q["end"][0].replace("Z", "+00:00"))
            t0 = time.time(); out = build(lat, lon, start, end, half)
            out["seconds"] = round(time.time() - t0, 1)
            self._send(200, json.dumps(out).encode())
            print(f"{datetime.now():%H:%M:%S} /gfs {lat:.3f},{lon:.3f} {len(out['times'])} h x {len(out['columns'])} cols in {out['seconds']} s", flush=True)
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}).encode())
            print("error:", e, flush=True)
    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"GFS NOMADS bridge on http://localhost:{PORT}  (cache: {os.path.abspath(CACHE)})", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
