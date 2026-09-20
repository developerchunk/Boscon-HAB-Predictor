#!/usr/bin/env python3
"""Decode Mapbox Terrain-RGB tiles at known places to verify the elevation formula used by the map's
filled tint: elevation = -10000 + 0.1 * (R*65536 + G*256 + B).   Needs VITE_MAPBOX_TOKEN in the env.
   set -a; . ./.env; set +a; python3 scripts/check_terrain_rgb.py"""
import math, os, io, urllib.request, ssl
from PIL import Image
try:
    import certifi; ctx = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    ctx = ssl.create_default_context()
tok = os.environ["VITE_MAPBOX_TOKEN"]
cache = {}
def elev(lat, lon, z=14):
    n = 2 ** z
    xf = (lon + 180) / 360 * n
    yf = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    x, y = int(xf), int(yf)
    if (x, y) not in cache:
        url = f"https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}.pngraw?access_token={tok}"
        cache[(x, y)] = Image.open(io.BytesIO(urllib.request.urlopen(url, timeout=60, context=ctx).read())).convert("RGB")
    im = cache[(x, y)]; w, h = im.size
    R, G, B = im.getpixel((int((xf - x) * w), int((yf - y) * h)))
    return -10000 + 0.1 * (R * 65536 + G * 256 + B), (R, G, B), w
PTS = [("Jejuri pad (repo 744.4 m, Copernicus 740 m)", 18.286293, 74.123039),
       ("Pune Shivajinagar (IMD station 555 m)", 18.5333, 73.85),
       ("Sinhagad fort (~1,300 m)", 18.3663, 73.7559),
       ("Lonavala (~620 m)", 18.75, 73.41),
       ("Konkan near Pen (~10 m)", 18.74, 73.10),
       ("Mumbai Santacruz (IMD 14 m)", 19.1167, 72.85)]
for name, la, lo in PTS:
    e, rgb, w = elev(la, lo)
    print(f"{name:45s} decoded {e:7.1f} m   RGB={rgb}  tile {w} px")
