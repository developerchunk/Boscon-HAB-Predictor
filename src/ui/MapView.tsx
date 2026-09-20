import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

/**
 * Terrain layers. Sources (Mapbox-hosted, read with the public token):
 *   mapbox.mapbox-terrain-dem-v1  raster DEM  -> (a) filled elevation tint, (b) hillshade, (c) the 3-D mesh
 *   mapbox.mapbox-terrain-v2      vector      -> `contour` lines with `ele` (metres) and `index`
 *
 * (a) Filled tint: the DEM tiles are "Terrain-RGB" PNGs, elevation = -10000 + 0.1 (R·65536 + G·256 + B)
 *     with R, G, B in 0..255. Loaded as a plain raster source, the GPU decodes that with the style-spec
 *     `raster-color-mix` (value = mix.r·r + mix.g·g + mix.b·b + mix.a, channels in 0..1), i.e.
 *     mix = [0.1·65536·255, 0.1·256·255, 0.1·255, -10000] = [1671168, 6528, 25.5, -10000],
 *     and colours every pixel with the `raster-color` ramp below over `raster-color-range` 0..1600 m.
 *     Linear texture filtering is safe here because the decode is linear in the channels.
 * (b) Hillshade from the same DEM as a raster-dem source.
 * (c) Contours: interval by zoom (Mapbox docs) z9 500 m, z10 200 m, z11 100 m, z12 50 m, z13 20 m, z14+ 10 m;
 *     every 100 m line is heavier and labelled in metres (every 200 m below zoom 11.5).
 */
export const ELEV_STOPS: [number, string][] = [
  [0, "#2c7a3a"], [200, "#5aa63f"], [400, "#a6c93d"], [600, "#e8d33a"], [800, "#f2a33a"],
  [1000, "#e5672c"], [1200, "#c22d2d"], [1400, "#8a1f6e"],
];
const reliefColor: mapboxgl.ExpressionSpecification = ["interpolate", ["linear"], ["raster-value"], ...ELEV_STOPS.flat()] as any;
const TERRAIN_RGB_MIX = [0.1 * 65536 * 255, 0.1 * 256 * 255, 0.1 * 255, -10000];
const RELIEF_RANGE: [number, number] = [0, 1600];
const TERRAIN_LAYER_IDS = ["hab-relief", "hab-hillshade", "hab-contour-minor", "hab-contour-major", "hab-contour-label-200", "hab-contour-label-100"];
export type TerrainMode = "off" | "2d" | "3d";

export interface MapData {
  launch: [number, number]; // lat, lon
  track?: { lon: number; lat: number; stage: string; alt: number }[];
  burst?: [number, number]; landing?: [number, number];
  mc?: [number, number][]; ellipses?: [number, number][][]; // [lon, lat] rings
  tawhiri?: { track: [number, number][]; landing: [number, number] };
  scatter?: { lon: number; lat: number; label: string }[];
  hourly?: { lon: number; lat: number; label: string }[];
}

const TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined)?.trim();

export function MapView(p: { data: MapData; onLaunchMove: (lat: number, lon: number) => void; fitKey: string }) {
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const marker = useRef<mapboxgl.Marker | null>(null);
  const ready = useRef(false);
  const onMove = useRef(p.onLaunchMove); onMove.current = p.onLaunchMove;
  const [terrain, setTerrain] = useState<TerrainMode>("2d");
  const [zoom, setZoom] = useState(8.5);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const [cursor, setCursor] = useState<[number, number] | null>(null);

  const tokenProblem = !TOKEN ? "missing" : TOKEN.startsWith("sk.") ? "secret" : !TOKEN.startsWith("pk.") ? "malformed" : null;
  useEffect(() => {
    if (tokenProblem || !div.current || map.current) return;
    mapboxgl.accessToken = TOKEN;
    const m = new mapboxgl.Map({ container: div.current, style: "mapbox://styles/mapbox/outdoors-v12", center: [p.data.launch[1], p.data.launch[0]], zoom: 9.2, preserveDrawingBuffer: import.meta.env.DEV /* lets dev checks read canvas pixels */ });
    m.addControl(new mapboxgl.NavigationControl(), "top-right");
    m.addControl(new mapboxgl.ScaleControl({ unit: "metric" }));
    m.on("load", () => {
      // ---- terrain: filled elevation tint + hillshade + contours, inserted BELOW the style's water, roads and labels
      const styleLayers = m.getStyle()?.layers ?? [];
      const below = (styleLayers.find(l => /^water/.test(l.id)) ?? styleLayers.find(l => l.type === "line" || l.type === "symbol"))?.id;
      m.addSource("hab-dem", { type: "raster-dem", url: "mapbox://mapbox.mapbox-terrain-dem-v1", tileSize: 512, maxzoom: 14 });
      // Plain raster access to the Terrain-RGB tiles. The TileJSON form resolves to the raster/v1 endpoint, which
      // returns 401 for this tileset when read as a plain raster (verified 2026-09-20); the documented v4 ".pngraw"
      // endpoint returns lossless PNGs at 200 up to z14 (404 above), so it is addressed explicitly. ".webp" at v4 is
      // lossy and would corrupt the decoded heights.
      m.addSource("hab-dem-rgb", { type: "raster", tiles: [`https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/{z}/{x}/{y}.pngraw?access_token=${TOKEN}`], tileSize: 256 /* v4 pngraw tiles are 256 px (verified) */, minzoom: 0, maxzoom: 14, attribution: "© Mapbox Terrain" });
      m.addSource("hab-terrain-v2", { type: "vector", url: "mapbox://mapbox.mapbox-terrain-v2" });
      m.addLayer({ id: "hab-relief", type: "raster", source: "hab-dem-rgb", paint: { "raster-color": reliefColor, "raster-color-mix": TERRAIN_RGB_MIX, "raster-color-range": RELIEF_RANGE, "raster-opacity": 0.85, "raster-resampling": "linear", "raster-fade-duration": 0 } as any }, below);
      m.addLayer({ id: "hab-hillshade", type: "hillshade", source: "hab-dem", paint: { "hillshade-exaggeration": 0.5, "hillshade-shadow-color": "#2e2418", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#4d3d26" } }, below);
      m.addLayer({ id: "hab-contour-minor", type: "line", source: "hab-terrain-v2", "source-layer": "contour", filter: ["!=", ["%", ["get", "ele"], 100], 0], paint: { "line-color": "#3b2f20", "line-width": 0.5, "line-opacity": 0.35 } }, below);
      m.addLayer({ id: "hab-contour-major", type: "line", source: "hab-terrain-v2", "source-layer": "contour", filter: ["==", ["%", ["get", "ele"], 100], 0], paint: { "line-color": "#3b2f20", "line-width": 1.1, "line-opacity": 0.6 } }, below);
      const labelLayout: any = { "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "ele"]], " m"], "text-size": 10.5, "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"], "symbol-spacing": 260, "text-max-angle": 30, "text-rotation-alignment": "map", "text-pitch-alignment": "viewport" };
      const labelPaint: any = { "text-color": "#2b2116", "text-halo-color": "#ffffff", "text-halo-width": 1.5 };
      m.addLayer({ id: "hab-contour-label-200", type: "symbol", source: "hab-terrain-v2", "source-layer": "contour", maxzoom: 11.5, filter: ["==", ["%", ["get", "ele"], 200], 0], layout: labelLayout, paint: labelPaint });
      m.addLayer({ id: "hab-contour-label-100", type: "symbol", source: "hab-terrain-v2", "source-layer": "contour", minzoom: 11.5, filter: ["==", ["%", ["get", "ele"], 100], 0], layout: labelLayout, paint: labelPaint });
      const empty = { type: "FeatureCollection", features: [] } as any;
      for (const id of ["ascent", "descent", "mc", "ellipses", "tawhiri", "points", "scatter", "hourly"]) m.addSource(id, { type: "geojson", data: empty });
      m.addLayer({ id: "ellipses", type: "line", source: "ellipses", paint: { "line-color": "#4a3aa7", "line-width": ["case", ["==", ["get", "prob"], 0.5], 2.5, 1.5], "line-dasharray": [2, 1.5] } });
      m.addLayer({ id: "mc", type: "circle", source: "mc", paint: { "circle-radius": 3, "circle-color": "#4a3aa7", "circle-opacity": 0.45 } });
      m.addLayer({ id: "scatter", type: "circle", source: "scatter", paint: { "circle-radius": 3.5, "circle-color": "#1baf7a", "circle-opacity": 0.6, "circle-stroke-width": 0.5, "circle-stroke-color": "#ffffff" } });
      m.addLayer({ id: "tawhiri", type: "line", source: "tawhiri", paint: { "line-color": "#7a7873", "line-width": 2, "line-dasharray": [3, 2] } });
      m.addLayer({ id: "ascent", type: "line", source: "ascent", paint: { "line-color": "#2a78d6", "line-width": 3 } });
      m.addLayer({ id: "descent", type: "line", source: "descent", paint: { "line-color": "#eb6834", "line-width": 3 } });
      m.addLayer({ id: "hourly", type: "circle", source: "hourly", paint: { "circle-radius": 4, "circle-color": "#eda100", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" } });
      m.addLayer({ id: "hourly-label", type: "symbol", source: "hourly", layout: { "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1.1], "text-anchor": "top" }, paint: { "text-color": "#333", "text-halo-color": "#fff", "text-halo-width": 1 } });
      m.addLayer({ id: "points", type: "circle", source: "points", paint: { "circle-radius": 6, "circle-color": ["get", "color"], "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
      m.addLayer({ id: "points-label", type: "symbol", source: "points", layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"] }, paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
      const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
      for (const id of ["mc", "scatter", "points", "hourly"]) {
        m.on("mouseenter", id, e => { const f = e.features?.[0] as any; if (!f) return; m.getCanvas().style.cursor = "pointer"; const g = (f.geometry as any).coordinates; popup.setLngLat(g).setHTML(`<div style="font-size:12px">${f.properties?.label ?? ""}</div>`).addTo(m); });
        m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; popup.remove(); });
      }
      ready.current = true;
      update();
      applyTerrain(m, "2d");
    });
    m.on("zoom", () => setZoom(m.getZoom()));
    m.on("mousemove", e => setCursor([e.lngLat.lat, e.lngLat.lng]));
    m.on("mouseout", () => setCursor(null));
    m.on("click", e => {
      if (!pickingRef.current) return;
      pickingRef.current = false; setPicking(false); m.getCanvas().style.cursor = "";
      onMove.current(+e.lngLat.lat.toFixed(6), +e.lngLat.lng.toFixed(6));
    });
    marker.current = new mapboxgl.Marker({ draggable: true, color: "#111" }).setLngLat([p.data.launch[1], p.data.launch[0]]).addTo(m);
    marker.current.on("dragend", () => { const ll = marker.current!.getLngLat(); onMove.current(+ll.lat.toFixed(6), +ll.lng.toFixed(6)); });
    map.current = m;
    if (import.meta.env.DEV) (window as any).__habMap = m; // debugging handle in dev builds only
    m.on("error", e => console.error("[mapbox error]", e?.error?.message ?? e, (e as any)?.sourceId ?? "", (e as any)?.tile?.tileID?.canonical ?? ""));
    return () => { m.remove(); map.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyTerrain(m: mapboxgl.Map, mode: TerrainMode) {
    const vis = mode === "off" ? "none" : "visible";
    for (const id of TERRAIN_LAYER_IDS) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", vis);
    if (mode === "3d") { m.setTerrain({ source: "hab-dem", exaggeration: 1.6 }); m.easeTo({ pitch: 58, duration: 800 }); }
    else { m.setTerrain(null); if (m.getPitch() > 0) m.easeTo({ pitch: 0, duration: 600 }); }
  }
  useEffect(() => { const m = map.current; if (m && ready.current) applyTerrain(m, terrain); }, [terrain]);

  function update() {
    const m = map.current; if (!m || !ready.current) return;
    const d = p.data;
    marker.current?.setLngLat([d.launch[1], d.launch[0]]);
    const set = (id: string, data: any) => (m.getSource(id) as mapboxgl.GeoJSONSource | undefined)?.setData(data);
    const line = (coords: [number, number][], props: any = {}) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
    const fc = (features: any[]) => ({ type: "FeatureCollection", features });
    const pt = (lon: number, lat: number, props: any) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } });
    const asc = (d.track ?? []).filter(q => q.stage !== "descent").map(q => [q.lon, q.lat] as [number, number]);
    const des = (d.track ?? []).filter(q => q.stage === "descent").map(q => [q.lon, q.lat] as [number, number]);
    set("ascent", fc(asc.length > 1 ? [line(asc)] : []));
    set("descent", fc(des.length > 1 ? [line(des)] : []));
    set("mc", fc((d.mc ?? []).map(q => pt(q[1], q[0], { label: "Monte Carlo landing" }))));
    set("ellipses", fc((d.ellipses ?? []).map((ring, i) => line(ring, { prob: [0.5, 0.9, 0.95][i] ?? 0 }))));
    set("tawhiri", fc(d.tawhiri ? [line(d.tawhiri.track)] : []));
    set("scatter", fc((d.scatter ?? []).map(s => pt(s.lon, s.lat, { label: s.label }))));
    set("hourly", fc((d.hourly ?? []).map(s => pt(s.lon, s.lat, { label: s.label }))));
    const pts: any[] = [];
    if (d.burst) pts.push(pt(d.burst[1], d.burst[0], { label: "burst", color: "#e34948" }));
    if (d.landing) pts.push(pt(d.landing[1], d.landing[0], { label: "landing (this model)", color: "#008300" }));
    if (d.tawhiri) pts.push(pt(d.tawhiri.landing[1], d.tawhiri.landing[0], { label: "landing (SondeHub/Tawhiri)", color: "#7a7873" }));
    set("points", fc(pts));
  }
  useEffect(update, [p.data]);
  useEffect(() => {
    const m = map.current; if (!m || !ready.current) return;
    const [lat, lon] = p.data.launch;
    if (!m.getBounds()?.contains([lon, lat])) m.easeTo({ center: [lon, lat], zoom: Math.max(m.getZoom(), 9), duration: 800 });
  }, [p.data.launch[0], p.data.launch[1]]);
  function startPick() {
    const m = map.current; if (!m) return;
    pickingRef.current = true; setPicking(true); m.getCanvas().style.cursor = "crosshair";
  }
  function cancelPick() { const m = map.current; pickingRef.current = false; setPicking(false); if (m) m.getCanvas().style.cursor = ""; }
  useEffect(() => {
    const m = map.current; if (!m || !ready.current) return;
    const d = p.data;
    const all: [number, number][] = [[d.launch[1], d.launch[0]]];
    (d.track ?? []).forEach(q => all.push([q.lon, q.lat]));
    (d.mc ?? []).forEach(q => all.push([q[1], q[0]]));
    (d.scatter ?? []).forEach(q => all.push([q.lon, q.lat]));
    if (d.tawhiri) all.push(d.tawhiri.landing);
    if (all.length < 2) return;
    const b = all.reduce((bb, c) => bb.extend(c), new mapboxgl.LngLatBounds(all[0], all[0]));
    m.fitBounds(b, { padding: 50, maxZoom: 11, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fitKey]);

  if (tokenProblem) return <div className="mapwrap"><div className="card" style={{ margin: 16 }}>
    <h3>{tokenProblem === "missing" ? "Mapbox token not set" : tokenProblem === "secret" ? "Mapbox token is a secret (sk.) token — a public (pk.) token is needed" : "Mapbox token does not look like a public token"}</h3>
    {tokenProblem === "secret"
      ? <p className="note">Mapbox GL runs in the browser and only accepts <b>public</b> tokens (<code>pk.…</code>). Anything in <code>.env</code> is compiled into the served JavaScript, so a secret token here would be exposed to every visitor — revoke it if this build was ever deployed. Create a public token at account.mapbox.com → Tokens (the default public token is enough; only the <code>styles:read</code>, <code>fonts:read</code> and <code>styles:tiles</code> scopes are used), put it in <code>.env</code> as <code>VITE_MAPBOX_TOKEN=pk.…</code>, and restart <code>npm run dev</code>.</p>
      : <p className="note">Create <code>.env</code> in the project root with <code>VITE_MAPBOX_TOKEN=pk.…</code> and restart <code>npm run dev</code>. The prediction, charts and plan view below work without the map.</p>}
  </div></div>;
  const interval = zoom >= 14 ? 10 : zoom >= 13 ? 20 : zoom >= 12 ? 50 : zoom >= 11 ? 100 : zoom >= 10 ? 200 : 500;
  return <div className="mapwrap"><div ref={div} className="map" />
    <div className="map-overlay top-left">
      <div className="row" style={{ gap: 4 }}>
        <span className="note" style={{ margin: 0 }}>Terrain</span>
        {(["off", "2d", "3d"] as TerrainMode[]).map(mode => <button key={mode} className={"tab small" + (terrain === mode ? " active" : "")} onClick={() => setTerrain(mode)}>{mode === "off" ? "off" : mode === "2d" ? "contours + shade" : "3-D"}</button>)}
        <span style={{ width: 8 }} />
        {picking
          ? <button className="tab small active" onClick={cancelPick}>click the map to set the pad… (cancel)</button>
          : <button className="tab small" onClick={startPick} title="Then click anywhere on the map; the pad moves there and its elevation is read from the DEM">Pick pad on map</button>}
      </div>
      <div className="note mono" style={{ margin: "4px 0 0", fontSize: 11 }}>
        pad {p.data.launch[0].toFixed(5)}, {p.data.launch[1].toFixed(5)}{cursor ? ` · cursor ${cursor[0].toFixed(5)}, ${cursor[1].toFixed(5)}` : " · drag the marker or pick on map"}
      </div>
    </div>
    {terrain !== "off" && <div className="map-overlay bottom-left legend-box">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Elevation, m AMSL</div>
      <div className="legend-ramp">
        <div className="legend-bar" style={{ background: `linear-gradient(to top, ${ELEV_STOPS.map(([m, c]) => `${c} ${(m / RELIEF_RANGE[1]) * 100}%`).join(", ")})` }} />
        <div className="legend-ticks">{[...ELEV_STOPS].reverse().map(([m]) => <span key={m} style={{ bottom: `${(m / RELIEF_RANGE[1]) * 100}%` }}>{m === ELEV_STOPS[ELEV_STOPS.length - 1][0] ? `≥ ${m}` : m}</span>)}</div>
      </div>
      <div className="note" style={{ margin: "6px 0 0", maxWidth: 170 }}>Fill: Mapbox Terrain DEM, every pixel coloured by its height. {zoom < 9 ? "Zoom in past level 9 for contour lines." : `Contours every ${interval} m at this zoom, labelled every ${zoom >= 11.5 ? 100 : 200} m.`}</div>
    </div>}
  </div>;
}
