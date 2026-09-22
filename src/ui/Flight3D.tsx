/**
 * 3-D flight view (Three.js). Scene units are kilometres: x = east of the pad, z = south of the pad
 * (so north points away from the default camera), y = altitude above sea level × exaggeration.
 *  - terrain: Mapbox Terrain-RGB tiles decoded on a 41×41 grid over the flight's bounding box
 *    (Open-Meteo DEM as a coarse fallback), coloured with the same elevation ramp as the map
 *  - track: tube coloured by phase (blue ascent, orange descent), its ground shadow, drop lines
 *  - wind: arrows along the path every 2 km of climb (5 km of descent), length ∝ speed
 *    (0.3 km per m/s), and a wind column above the pad from the forecast at launch hour
 *  - markers: pad, burst, landing, Tawhiri landing, Monte Carlo landings on the ground
 *  - a time scrubber that moves a balloon marker along the track
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { FlightResult } from "../physics/trajectory";
import type { McResult } from "../physics/montecarlo";
import type { TawhiriResult } from "../data/tawhiri";
import type { GridFetchResult, WeatherColumn } from "../data/openmeteo";
import { fetchElevations } from "../data/openmeteo";
import { eastNorthM, offsetLatLon, dirSpeedFromUV } from "../physics/geo";
import { ELEV_STOPS } from "./MapView";
import { isa } from "../physics/atmosphere";
import { hhmm, compass, km } from "./format";

export interface Flight3DData { nominal: FlightResult; mc?: McResult; tawhiri?: TawhiriResult; grid: GridFetchResult; weather?: WeatherColumn }
interface Terrain { lat0: number; lon0: number; x0: number; x1: number; z0: number; z1: number; n: number; elev: number[]; key: string }

function rampColor(m: number): THREE.Color {
  const st = ELEV_STOPS;
  if (m <= st[0][0]) return new THREE.Color(st[0][1]);
  for (let i = 1; i < st.length; i++) if (m <= st[i][0]) { const f = (m - st[i - 1][0]) / (st[i][0] - st[i - 1][0]); return new THREE.Color(st[i - 1][1]).lerp(new THREE.Color(st[i][1]), f); }
  return new THREE.Color(st[st.length - 1][1]);
}
/**
 * Terrain heights on an n×n grid over the scene bbox, decoded from Mapbox Terrain-RGB tiles
 * (elevation = -10000 + 0.1·(R·65536 + G·256 + B)) drawn onto an offscreen canvas. Uses zoom 10
 * (~150 m per pixel at 18° N) or 11 for small areas; 4–9 tile fetches, no rate limit issues.
 * The formula and tileset are the ones verified for the map fill (scripts/check_terrain_rgb.py).
 */
async function terrainFromTiles(lat0: number, lon0: number, x0: number, x1: number, z0: number, z1: number, n: number, signal?: AbortSignal): Promise<number[]> {
  const token = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined)?.trim();
  if (!token || !token.startsWith("pk.")) throw new Error("no Mapbox token");
  const [latN, lonW] = offsetLatLon(lat0, lon0, x0 * 1000, -z0 * 1000), [latS, lonE] = offsetLatLon(lat0, lon0, x1 * 1000, -z1 * 1000);
  const z = Math.max(x1 - x0, z1 - z0) < 35 ? 11 : 10, N = 2 ** z, T = 256;
  const tx = (lon: number) => ((lon + 180) / 360) * N, ty = (lat: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * N;
  const txW = Math.floor(tx(lonW)), txE = Math.floor(tx(lonE)), tyN = Math.floor(ty(latN)), tyS = Math.floor(ty(latS));
  const cols = txE - txW + 1, rows = tyS - tyN + 1;
  if (cols * rows > 16) throw new Error("area too large for tile decode");
  const canvas = document.createElement("canvas"); canvas.width = cols * T; canvas.height = rows * T;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  await Promise.all(Array.from({ length: cols * rows }, (_, k) => new Promise<void>((resolve, reject) => {
    const i = k % cols, j = Math.floor(k / cols);
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = () => { ctx.drawImage(img, i * T, j * T); resolve(); };
    img.onerror = () => reject(new Error(`tile ${z}/${txW + i}/${tyN + j} failed`));
    img.src = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${z}/${txW + i}/${tyN + j}.pngraw?access_token=${token}`;
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })));
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = x0 + (i / (n - 1)) * (x1 - x0), zz = z0 + (j / (n - 1)) * (z1 - z0);
    const [la, lo] = offsetLatLon(lat0, lon0, x * 1000, -zz * 1000);
    const px = Math.min(canvas.width - 1, Math.max(0, Math.floor((tx(lo) - txW) * T))), py = Math.min(canvas.height - 1, Math.max(0, Math.floor((ty(la) - tyN) * T)));
    const k = (py * canvas.width + px) * 4;
    out.push(-10000 + 0.1 * (data[k] * 65536 + data[k + 1] * 256 + data[k + 2]));
  }
  return out;
}
function label(text: string, cls = "l3d") { const d = document.createElement("div"); d.className = cls; d.textContent = text; return new CSS2DObject(d); }

export interface Flight3DSnapshot { exag: number; showTerrain: boolean; showWind: boolean; showColumn: boolean; showMc: boolean; tSec: number }
export function Flight3D({ data, launchLat, launchLon, launchAltM, initial, onSnapshot }: { data: Flight3DData | null; launchLat: number; launchLon: number; launchAltM: number; initial?: Flight3DSnapshot; onSnapshot?: (s: Flight3DSnapshot) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{ renderer: THREE.WebGLRenderer; labels: CSS2DRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; group: THREE.Group; balloon: THREE.Group; balloonLabel: CSS2DObject } | null>(null);
  const [exag, setExag] = useState(initial?.exag ?? 1);
  const [showTerrain, setShowTerrain] = useState(initial?.showTerrain ?? true);
  const [showWind, setShowWind] = useState(initial?.showWind ?? true);
  const [showColumn, setShowColumn] = useState(initial?.showColumn ?? true);
  const [showMc, setShowMc] = useState(initial?.showMc ?? true);
  const [terrain, setTerrain] = useState<Terrain | null>(null);
  const [terrainStatus, setTerrainStatus] = useState("");
  const [tSec, setTSec] = useState(initial?.tSec ?? 0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { onSnapshot?.({ exag, showTerrain, showWind, showColumn, showMc, tSec }); }, [exag, showTerrain, showWind, showColumn, showMc, tSec]);

  // scene-space helpers (km): east -> x, north -> -z
  const toXZ = (lat: number, lon: number): [number, number] => { const [e, n] = eastNorthM(launchLat, launchLon, lat, lon); return [e / 1000, -n / 1000]; };
  const pts = data?.nominal.points ?? [];
  const bbox = useMemo(() => {
    if (!data) return null;
    let x0 = -5, x1 = 5, z0 = -5, z1 = 5;
    const add = (lat: number, lon: number) => { const [x, z] = toXZ(lat, lon); x0 = Math.min(x0, x - 5); x1 = Math.max(x1, x + 5); z0 = Math.min(z0, z - 5); z1 = Math.max(z1, z + 5); };
    for (const p of pts) add(p.lat, p.lon);
    data.mc?.landings.forEach(l => add(l.lat, l.lon));
    if (data.tawhiri) add(data.tawhiri.landing.latitude, data.tawhiri.landing.longitude > 180 ? data.tawhiri.landing.longitude - 360 : data.tawhiri.landing.longitude);
    return { x0, x1, z0, z1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, launchLat, launchLon]);

  // ---- terrain fetch
  useEffect(() => {
    if (!bbox) return;
    const n = 41;
    const key = `${launchLat.toFixed(3)},${launchLon.toFixed(3)}|${bbox.x0.toFixed(0)},${bbox.x1.toFixed(0)},${bbox.z0.toFixed(0)},${bbox.z1.toFixed(0)}`;
    if (terrain?.key === key) return;
    const ac = new AbortController();
    (async () => {
      try {
        setTerrainStatus("loading terrain…");
        let elev: number[];
        try {
          elev = await terrainFromTiles(launchLat, launchLon, bbox.x0, bbox.x1, bbox.z0, bbox.z1, n, ac.signal);
        } catch (e: any) {
          if (e?.name === "AbortError") throw e;
          // fallback: Open-Meteo DEM on a coarser grid (rate-limited, so only when the tiles are unavailable)
          const nn = 15; const req: [number, number][] = [];
          for (let j = 0; j < nn; j++) for (let i = 0; i < nn; i++) { const x = bbox.x0 + (i / (nn - 1)) * (bbox.x1 - bbox.x0), z = bbox.z0 + (j / (nn - 1)) * (bbox.z1 - bbox.z0); const [la, lo] = offsetLatLon(launchLat, launchLon, x * 1000, -z * 1000); req.push([la, lo]); }
          elev = await fetchElevations(req, ac.signal);
          setTerrain({ lat0: launchLat, lon0: launchLon, x0: bbox.x0, x1: bbox.x1, z0: bbox.z0, z1: bbox.z1, n: nn, elev, key }); setTerrainStatus("terrain from Open-Meteo DEM (coarse)"); return;
        }
        setTerrain({ lat0: launchLat, lon0: launchLon, x0: bbox.x0, x1: bbox.x1, z0: bbox.z0, z1: bbox.z1, n, elev, key });
        setTerrainStatus("");
      } catch (e: any) { if (e?.name !== "AbortError") setTerrainStatus("terrain unavailable: " + (e.message ?? e)); }
    })();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox]);
  const groundAt = (x: number, z: number): number => {
    if (!terrain) return launchAltM / 1000;
    const fx = Math.min(terrain.n - 1.001, Math.max(0, ((x - terrain.x0) / (terrain.x1 - terrain.x0)) * (terrain.n - 1)));
    const fz = Math.min(terrain.n - 1.001, Math.max(0, ((z - terrain.z0) / (terrain.z1 - terrain.z0)) * (terrain.n - 1)));
    const i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, n = terrain.n;
    const e = (ii: number, jj: number) => terrain.elev[jj * n + ii] ?? launchAltM;
    return ((1 - a) * (1 - b) * e(i, j) + a * (1 - b) * e(i + 1, j) + (1 - a) * b * e(i, j + 1) + a * b * e(i + 1, j + 1)) / 1000;
  };

  // ---- renderer / camera / controls, created once
  useEffect(() => {
    const el = host.current; if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer(); labels.setSize(el.clientWidth, el.clientHeight);
    Object.assign(labels.domElement.style, { position: "absolute", top: "0", left: "0", pointerEvents: "none" });
    el.appendChild(labels.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 5000);
    camera.position.set(60, 45, 80);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = Math.PI / 2 - 0.02;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(40, 80, 30); scene.add(sun);
    const group = new THREE.Group(); scene.add(group);
    // progress marker: a latex balloon (envelope, neck, line, payload) that becomes a parachute after burst
    const balloon = new THREE.Group(); balloon.visible = false; scene.add(balloon);
    const envelope = new THREE.Group(); envelope.name = "envelope";
    envelope.add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), new THREE.MeshPhongMaterial({ color: 0xf4f4f0, transparent: true, opacity: 0.85, shininess: 60 })));
    const neck = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 12), new THREE.MeshLambertMaterial({ color: 0xdddddd })); neck.position.y = -1.1; neck.rotation.x = Math.PI; envelope.add(neck);
    balloon.add(envelope);
    const chute = new THREE.Group(); chute.name = "chute"; chute.visible = false;
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xeb6834, side: THREE.DoubleSide })); chute.add(canopy);
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; chute.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), new THREE.Vector3(0, -1.6, 0)]), new THREE.LineBasicMaterial({ color: 0x555555 }))); }
    balloon.add(chute);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1.35, 0), new THREE.Vector3(0, -3.2, 0)]), new THREE.LineBasicMaterial({ color: 0x333333 })); line.name = "line"; balloon.add(line);
    const payload = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), new THREE.MeshLambertMaterial({ color: 0x2a78d6 })); payload.position.y = -3.4; payload.name = "payload"; balloon.add(payload);
    const balloonLabel = label("", "l3d strong"); balloonLabel.position.set(0, 1.6, 0); balloon.add(balloonLabel);
    three.current = { renderer, labels, scene, camera, controls, group, balloon, balloonLabel };
    let raf = 0; const loop = () => { controls.update(); renderer.render(scene, camera); labels.render(scene, camera); raf = requestAnimationFrame(loop); }; loop();
    const ro = new ResizeObserver(() => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); labels.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }); ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.innerHTML = ""; three.current = null; };
  }, []);

  // ---- (re)build the scene contents
  useEffect(() => {
    const t = three.current; if (!t) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim() || "#f0efec";
    t.scene.background = new THREE.Color(bg);
    // CSS2D labels live in the DOM; detach the old ones or they linger as ghosts after group.clear()
    t.group.traverse(o => { if ((o as any).isCSS2DObject) (o as CSS2DObject).element.remove(); });
    t.group.clear();
    if (!data || !bbox) return;
    const g = t.group;
    const Y = (m: number) => (m / 1000) * exag;
    // terrain
    const w = bbox.x1 - bbox.x0, h = bbox.z1 - bbox.z0;
    if (showTerrain) {
      const n = terrain?.n ?? 2;
      const geo = new THREE.PlaneGeometry(w, h, n - 1, n - 1); geo.rotateX(-Math.PI / 2); geo.translate((bbox.x0 + bbox.x1) / 2, 0, (bbox.z0 + bbox.z1) / 2);
      const pos = geo.attributes.position as THREE.BufferAttribute; const colors = new Float32Array(pos.count * 3);
      for (let k = 0; k < pos.count; k++) { const e = terrain ? terrain.elev[k] : launchAltM; pos.setY(k, Y(e)); const c = rampColor(e); colors[3 * k] = c.r; colors[3 * k + 1] = c.g; colors[3 * k + 2] = c.b; }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3)); geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
      g.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.08 })));
    } else {
      const grid = new THREE.GridHelper(Math.max(w, h), Math.round(Math.max(w, h) / 5), 0x888888, 0xbbbbbb); grid.position.set((bbox.x0 + bbox.x1) / 2, Y(launchAltM), (bbox.z0 + bbox.z1) / 2); g.add(grid);
    }
    // cardinal directions on the four edges of the terrain (map orientation: east right, north away)
    const cx0 = (bbox.x0 + bbox.x1) / 2, cz0 = (bbox.z0 + bbox.z1) / 2;
    for (const [text, x, z] of [["NORTH", cx0, bbox.z0 + 1.5], ["SOUTH", cx0, bbox.z1 - 1.5], ["EAST", bbox.x1 - 1.5, cz0], ["WEST", bbox.x0 + 1.5, cz0]] as [string, number, number][]) {
      const l = label(text, "l3d cardinal"); l.position.set(x, Y(groundAt(x, z) * 1000) + 0.6, z); g.add(l);
    }
    // a ground cross at the pad pointing to the four directions
    const gy = Y(launchAltM) + 0.15, arm = Math.min(6, (bbox.x1 - bbox.x0) / 12);
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-arm, gy, 0), new THREE.Vector3(arm, gy, 0), new THREE.Vector3(0, gy, -arm), new THREE.Vector3(0, gy, arm)]), new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.7 })));
    g.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, gy, 0), arm, 0x222222, arm * 0.35, arm * 0.2));
    // altitude axis at the pad
    const padY = Y(launchAltM);
    const axisTop = Y(Math.max(35000, data.nominal.burst.z + 3000));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, padY, 0), new THREE.Vector3(0, axisTop, 0)]), new THREE.LineBasicMaterial({ color: 0x888888 })));
    const padAtmos = data.grid.field.atmosphere(launchLat, launchLon, data.nominal.points[0]?.t ?? 0);
    for (let a = 5000; a <= 35000; a += 5000) { const st = padAtmos.state(a); const tick = label(`${a / 1000} km · ${(st.T - 273.15).toFixed(0)} °C · ${(st.p / 100).toFixed(st.p < 10000 ? 1 : 0)} hPa`, "l3d muted"); tick.position.set(0, Y(a), 0); g.add(tick); g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.8, Y(a), 0), new THREE.Vector3(0.8, Y(a), 0)]), new THREE.LineBasicMaterial({ color: 0x888888 }))); }
    // wind column above the pad (forecast at launch hour)
    if (showColumn) {
      let lastZ = -1e9;
      for (const lv of data.grid.launchColumn) {
        if (lv.z - lastZ < 1500 || lv.z > 33000) continue; lastZ = lv.z;
        const spd = Math.hypot(lv.u, lv.v); if (spd < 0.3) continue;
        const dir = new THREE.Vector3(lv.u, 0, -lv.v).normalize();
        g.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0, Y(lv.z), 0), Math.max(0.6, 0.3 * spd), 0x1baf7a, 0.6, 0.35));
      }
      const cl = label("wind column at pad (forecast)", "l3d muted"); cl.position.set(0, axisTop + 0.5, 0); g.add(cl);
    }
    // track
    const P = pts.map(p => { const [x, z] = toXZ(p.lat, p.lon); return { v: new THREE.Vector3(x, Y(p.z), z), p }; });
    const asc = P.filter(q => q.p.stage !== "descent").map(q => q.v), des = P.filter(q => q.p.stage === "descent").map(q => q.v);
    if (asc.length > 1) g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(asc), Math.min(600, asc.length * 2), 0.25, 8, false), new THREE.MeshLambertMaterial({ color: 0x2a78d6 })));
    if (des.length > 1) g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([asc[asc.length - 1], ...des]), Math.min(600, des.length * 2), 0.25, 8, false), new THREE.MeshLambertMaterial({ color: 0xeb6834 })));
    // ground shadow of the track + drop lines
    const shadow = P.filter((_, i) => i % 3 === 0).map(q => new THREE.Vector3(q.v.x, Y(groundAt(q.v.x, q.v.z) * 1000) + 0.08, q.v.z));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(shadow), new THREE.LineBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.6 })));
    const drop = (v: THREE.Vector3) => { const m = new THREE.LineDashedMaterial({ color: 0x666666, dashSize: 0.6, gapSize: 0.4 }); const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v, new THREE.Vector3(v.x, Y(groundAt(v.x, v.z) * 1000), v.z)]), m); l.computeLineDistances(); g.add(l); };
    // wind arrows along the path
    if (showWind) {
      let lastA = -1e9, lastD = 1e9;
      for (const q of P) {
        const isAsc = q.p.stage !== "descent";
        if (isAsc ? q.p.z - lastA < 2000 : lastD - q.p.z < 5000) continue;
        if (isAsc) lastA = q.p.z; else lastD = q.p.z;
        const spd = Math.hypot(q.p.u, q.p.v); if (spd < 0.3) continue;
        const dir = new THREE.Vector3(q.p.u, 0, -q.p.v).normalize();
        g.add(new THREE.ArrowHelper(dir, q.v, Math.max(0.6, 0.3 * spd), 0xeda100, 0.7, 0.4));
        if (isAsc && Math.round(q.p.z / 1000) % 4 === 0) { const [from] = dirSpeedFromUV(q.p.u, q.p.v); const wl = label(`${spd.toFixed(0)} m/s from ${compass(from)} @ ${(q.p.z / 1000).toFixed(0)} km`, "l3d wind"); wl.position.copy(q.v).add(dir.clone().multiplyScalar(Math.max(0.6, 0.3 * spd) + 1)); g.add(wl); }
      }
    }
    // markers
    const marker = (v: THREE.Vector3, color: number, text: string, r = 0.6) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshLambertMaterial({ color })); m.position.copy(v); g.add(m); const l = label(text, "l3d strong"); l.position.set(0, 1.2, 0); m.add(l); return m; };
    const n = data.nominal;
    marker(new THREE.Vector3(0, padY, 0), 0x111111, `pad ${launchAltM.toFixed(0)} m`);
    const [bx, bz] = toXZ(n.burst.lat, n.burst.lon); const bv = new THREE.Vector3(bx, Y(n.burst.z), bz); marker(bv, 0xe34948, `burst ${(n.burst.z / 1000).toFixed(1)} km · T+${hhmm(n.burst.t)}`); drop(bv);
    const [lx, lz] = toXZ(n.landing.lat, n.landing.lon); const lv = new THREE.Vector3(lx, Y(groundAt(lx, lz) * 1000) + 0.3, lz); marker(lv, 0x008300, `landing ${km(n.rangeM)} km ${compass(n.bearingDeg)} · T+${hhmm(n.durationS)}`);
    if (data.tawhiri) { const lo = data.tawhiri.landing.longitude > 180 ? data.tawhiri.landing.longitude - 360 : data.tawhiri.landing.longitude; const [tx, tz] = toXZ(data.tawhiri.landing.latitude, lo); marker(new THREE.Vector3(tx, Y(groundAt(tx, tz) * 1000) + 0.3, tz), 0x7a7873, "Tawhiri landing", 0.45); }
    if (showMc && data.mc) {
      const arr = new Float32Array(data.mc.landings.length * 3);
      data.mc.landings.forEach((l, i) => { const [x, z] = toXZ(l.lat, l.lon); arr[3 * i] = x; arr[3 * i + 1] = Y(groundAt(x, z) * 1000) + 0.15; arr[3 * i + 2] = z; });
      const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      g.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x4a3aa7, size: 0.5, transparent: true, opacity: 0.6 })));
    }
    // camera target on first build for this data
    t.controls.target.set((bbox.x0 + bbox.x1) / 2, Y(10000), (bbox.z0 + bbox.z1) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, terrain, exag, showTerrain, showWind, showColumn, showMc, launchAltM]);

  // ---- time scrubber
  useEffect(() => {
    const t = three.current; if (!t || !data) return;
    const p0 = pts[0]; if (!p0) return;
    const target = p0.t + tSec;
    let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= target) lo = m; else hi = m; }
    const a = pts[lo], b = pts[Math.min(hi, pts.length - 1)]; const f = b.t > a.t ? Math.min(1, Math.max(0, (target - a.t) / (b.t - a.t))) : 0;
    const lat = a.lat + f * (b.lat - a.lat), lon = a.lon + f * (b.lon - a.lon), z = a.z + f * (b.z - a.z);
    const [x, zz] = toXZ(lat, lon);
    t.balloon.visible = tSec > 0; t.balloon.position.set(x, (z / 1000) * exag, zz);
    const descending = a.stage === "descent";
    const env = t.balloon.getObjectByName("envelope")!, ch = t.balloon.getObjectByName("chute")!;
    env.visible = !descending; ch.visible = descending;
    // envelope grows as the air thins: D ∝ (rho_pad / rho)^(1/3); marker base size scales with the scene
    const span = bbox ? Math.max(bbox.x1 - bbox.x0, bbox.z1 - bbox.z0) : 80;
    const base = span / 110;
    const grow = Math.cbrt(isa(launchAltM).rho / isa(z).rho);
    t.balloon.scale.setScalar(base);
    env.scale.setScalar(descending ? 1 : Math.min(4.5, grow));
    ch.scale.setScalar(2.2);
    const el = t.balloonLabel.element as HTMLDivElement;
    const st = data.grid.field.atmosphere(lat, lon, target).state(z);
    const tempC = st.T - 273.15, hPa = st.p / 100;
    let wx = "";
    const lv = data.weather?.levels;
    if (lv && lv.length) {
      let rh = lv[0].rh, cc = lv[0].cloud;
      if (z >= lv[lv.length - 1].z) { rh = lv[lv.length - 1].rh; cc = lv[lv.length - 1].cloud; }
      else for (let i = 1; i < lv.length; i++) if (lv[i].z >= z) { const a = lv[i - 1], b = lv[i], f = (z - a.z) / (b.z - a.z); rh = a.rh + f * (b.rh - a.rh); cc = a.cloud + f * (b.cloud - a.cloud); break; }
      wx = ` · RH ${rh.toFixed(0)}%${cc >= 50 ? " · ☁ in cloud" : cc >= 20 ? ` · cloud ${cc.toFixed(0)}%` : ""}`;
    }
    el.textContent = `${descending ? "⬇ under parachute" : "⬆ balloon Ø×" + Math.min(4.5, grow).toFixed(1)} · T+${hhmm(tSec)} · ${(z / 1000).toFixed(1)} km · ${(Math.hypot(x, zz)).toFixed(1)} km out · ${tempC.toFixed(0)} °C · ${hPa.toFixed(hPa < 100 ? 1 : 0)} hPa${wx}`;
    el.style.color = tempC <= -40 ? "#6ea8ff" : tempC <= 0 ? "#9cc4ff" : "";
    t.balloonLabel.position.set(0, descending ? 3 : Math.min(4.5, grow) + 1, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tSec, data, exag]);
  useEffect(() => {
    if (!playing || !data) return;
    const dur = data.nominal.durationS; const id = setInterval(() => setTSec(s => (s + 30 >= dur ? (setPlaying(false), dur) : s + 30)), 50);
    return () => clearInterval(id);
  }, [playing, data]);

  const view = (which: "reset" | "top" | "side" | "north") => {
    const t = three.current; if (!t || !bbox) return;
    const cx = (bbox.x0 + bbox.x1) / 2, cz = (bbox.z0 + bbox.z1) / 2;
    const topY = ((data?.nominal.burst.z ?? 32000) / 1000) * exag;           // scene height of the burst
    const span = Math.max(bbox.x1 - bbox.x0, bbox.z1 - bbox.z0, topY * 1.1); // fit the taller of ground extent and flight height
    const Yc = topY * 0.4; t.controls.target.set(cx, Yc, cz);
    if (which === "top") t.camera.position.set(cx, span * 1.15, cz + 0.01);
    else if (which === "side") t.camera.position.set(cx, Yc + 5, cz + span * 1.25);
    else if (which === "north") t.camera.position.set(cx - span * 1.25, Yc + 5, cz);
    else t.camera.position.set(cx + span * 0.7, span * 0.6, cz + span * 0.9);
  };
  useEffect(() => { if (data) view("reset"); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [data]);

  const dur = data?.nominal.durationS ?? 0;
  return <div className="page" style={{ maxWidth: "none", height: "100%", display: "grid", gridTemplateRows: "auto 1fr", gap: 8, padding: "12px 16px" }}>
    <div className="row" style={{ gap: 10 }}>
      {!data && <span className="note">Run a prediction in the Predict tab first; the 3-D view shows that flight.</span>}
      <span className="note" style={{ margin: 0 }}>vertical exaggeration</span>
      {[1, 2, 3, 5].map(x => <button key={x} className={"tab small" + (exag === x ? " active" : "")} onClick={() => setExag(x)}>{x}×</button>)}
      <span style={{ width: 8 }} />
      <label className="note" style={{ margin: 0 }}><input type="checkbox" checked={showTerrain} onChange={e => setShowTerrain(e.target.checked)} /> terrain</label>
      <label className="note" style={{ margin: 0 }}><input type="checkbox" checked={showWind} onChange={e => setShowWind(e.target.checked)} /> wind along path</label>
      <label className="note" style={{ margin: 0 }}><input type="checkbox" checked={showColumn} onChange={e => setShowColumn(e.target.checked)} /> wind column at pad</label>
      <label className="note" style={{ margin: 0 }}><input type="checkbox" checked={showMc} onChange={e => setShowMc(e.target.checked)} /> Monte Carlo landings</label>
      <span style={{ width: 8 }} />
      <button className="secondary" onClick={() => view("reset")}>reset view</button>
      <button className="secondary" onClick={() => view("top")}>top</button>
      <button className="secondary" onClick={() => view("side")}>from south</button>
      <button className="secondary" onClick={() => view("north")}>from west</button>
      <span style={{ width: 8 }} />
      <button className="secondary" onClick={() => { if (tSec >= dur) setTSec(0); setPlaying(p => !p); }} disabled={!data}>{playing ? "pause" : "play"}</button>
      <input type="range" min={0} max={Math.max(1, Math.round(dur))} step={10} value={Math.min(tSec, dur)} onChange={e => { setPlaying(false); setTSec(+e.target.value); }} style={{ width: 220 }} disabled={!data} />
      <span className="mono note" style={{ margin: 0 }}>T+{hhmm(Math.min(tSec, dur))}</span>
      <span className="status">{terrainStatus}</span>
    </div>
    <div ref={host} style={{ position: "relative", minHeight: 420, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "var(--surface-2)" }} />
    <p className="note" style={{ margin: 0 }}>Drag to orbit, scroll to zoom, right-drag to pan. Map orientation: NORTH, SOUTH, EAST and WEST are written on the edges of the terrain and a cross at the pad points north; altitude is up with the chosen exaggeration; the tick marks on the pad axis are 5 km apart. Press play: the balloon icon climbs the blue tube and swells as the air thins; its label shows the diameter growth, position, and the forecast air temperature and pressure at that height (blue text below 0 °C), then it falls under the orange parachute. The altitude ticks on the pad axis carry the pad column's temperature. Yellow arrows: wind at the balloon's own position (0.3 km of arrow per m/s); green arrows: the forecast wind column above the pad at launch hour, which shows why the track turns where it does. Blue tube ascent, orange tube descent, grey line its shadow on the ground, purple dots the Monte Carlo landings.</p>
  </div>;
}
