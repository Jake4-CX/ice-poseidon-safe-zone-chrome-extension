/**
 * Runs in the page's MAIN world (no chrome.* APIs). Locates the site's MapLibre map and its
 * contestant sprite renderer (see map-discovery.ts) and executes commands from the content
 * script: camera moves, highlight rings, click hit-testing, screen anchors, zone forecast.
 *
 * Rings are drawn in our own overlay and re-positioned every animation frame from the
 * renderer's per-sprite boxes, so they sit on the real (smoothed) sprite and disappear when it
 * isn't drawn. Without the renderer we fall back to the raw GPS point.
 */
import { discoverMap, findRenderers, spriteGeom, type CxRenderer, type MlMap, type MlMapEvent, type SpriteGeom } from "./map-discovery.js";
import { TO_CONTENT, TO_PAGE, type MapMarker, type PlayerPoint, type ToContent, type ToPage, type ZoneForecast } from "./shared.js";

let map: MlMap | null = null;
let renderers: CxRenderer[] = [];
let overlay: HTMLDivElement | null = null;
let markers: MapMarker[] = [];
let players: PlayerPoint[] = [];
let following: string | null = null;
let pending: ToPage | null = null;
let forecast: ZoneForecast | null = null;
const anchorIds = new Set<string>();
const lastAnchor = new Map<string, string>();
let frame = 0;

function send(msg: ToContent) {
  document.dispatchEvent(new CustomEvent(TO_CONTENT, { detail: JSON.stringify(msg) }));
}

/**
 * Sprite geometry from whichever renderer draws this player. `undefined` = no renderer knows
 * them (use GPS fallback), `null` = known but not on screen this frame.
 */
function geomOf(id: string): SpriteGeom | null | undefined {
  let result: SpriteGeom | null | undefined;
  for (const r of renderers) {
    if (r.removed) continue;
    const g = spriteGeom(r, id);
    if (g) return g;
    if (g === null) result = null;
  }
  return result;
}

// ------------------------------------------------------------------ styles

const STYLE_ID = "szp-bridge-style";
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  // .szp-mk is positioned at the avatar-ring centre; --d is the highlight ring diameter.
  s.textContent = `
    .szp-mk { position: absolute; left: 0; top: 0; pointer-events: none; will-change: transform; --d: 30px; }
    .szp-mk .szp-ring {
      position: absolute; box-sizing: border-box; border-radius: 50%;
      width: var(--d); height: var(--d); left: calc(var(--d) / -2); top: calc(var(--d) / -2);
      border: 3px solid var(--c); box-shadow: 0 0 8px var(--c), inset 0 0 6px var(--c);
    }
    .szp-mk.focus .szp-ring { animation: szp-pulse 1.6s ease-out infinite; }
    .szp-mk.dead { opacity: .45; }
    .szp-mk .szp-star {
      position: absolute; left: calc(var(--d) / -2 - 5px); top: calc(var(--d) / -2 - 9px);
      font: 700 15px/1 system-ui, sans-serif; color: #facc15;
      text-shadow: 0 0 2px #000, 0 0 2px #000, 0 0 4px #000;
    }
    .szp-mk .szp-label {
      position: absolute; left: 0; top: calc(var(--d) / -2 - 24px); transform: translateX(-50%); white-space: nowrap;
      font: 600 12px/1.2 system-ui, sans-serif; padding: 2px 7px; border-radius: 999px;
      background: rgba(0,0,0,.78); color: #fff; border: 1px solid var(--c);
    }
    @keyframes szp-pulse {
      0% { box-shadow: 0 0 0 0 var(--c), inset 0 0 6px var(--c); }
      70% { box-shadow: 0 0 0 10px transparent, inset 0 0 6px var(--c); }
      100% { box-shadow: 0 0 0 0 transparent, inset 0 0 6px var(--c); }
    }
    .szp-fc-label {
      position: absolute; left: 0; top: 0; white-space: nowrap; pointer-events: none;
      font: 600 12px/1.2 system-ui, sans-serif; color: #dcfce7; padding: 3px 8px; border-radius: 999px;
      background: rgba(0,0,0,.72); border: 1px solid rgba(34,255,0,.6);
    }`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ lifecycle

const onRender = () => {
  positionForecastLabel();
  if (forecast && !forecastReady) ensureForecast();
};
const onDragStart = (e: MlMapEvent) => {
  if (following && e.originalEvent) {
    following = null;
    send({ type: "followStopped", reason: "user" });
  }
};

/** Prefer the renderer's exact sprite boxes; fall back to a box around the GPS point. */
const onClick = (e: MlMapEvent) => {
  if (!map || !e.point) return;
  let id: string | null = null;
  for (const r of renderers) {
    if (r.removed) continue;
    const hit = r.hitTest(e.point);
    if (hit && players.some((p) => p.id === hit)) {
      id = hit;
      break;
    }
  }
  if (!id && !renderers.length) {
    let bestD = Infinity;
    for (const p of players) {
      const q = map.project([p.lng, p.lat]);
      const dx = e.point.x - q.x;
      const dy = e.point.y - q.y;
      if (Math.abs(dx) > 34 || dy < -64 || dy > 30) continue;
      const d = dx * dx + (dy + 18) ** 2;
      if (d < bestD) {
        bestD = d;
        id = p.id;
      }
    }
  }
  send({ type: "playerClicked", id });
};

function attach(m: MlMap) {
  map = m;
  injectStyle();
  m.on("render", onRender);
  m.on("dragstart", onDragStart);
  m.on("click", onClick);
  m.on("styledata", onStyleData);
  overlay = document.createElement("div");
  overlay.dataset.szpOverlay = "";
  overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:1;overflow:hidden;";
  m.getContainer().appendChild(overlay);
  markerEls.clear();
  renderers = findRenderers(m);
  renderMarkers();
  forecastReady = false;
  ensureForecast();
  send({ type: "mapStatus", found: true, native: renderers.length > 0 });
  if (pending) {
    const p = pending;
    pending = null;
    handle(p);
  }
}

function detach() {
  if (map) {
    try {
      map.off("render", onRender);
      map.off("dragstart", onDragStart);
      map.off("click", onClick);
      map.off("styledata", onStyleData);
    } catch {
      /* map may already be destroyed */
    }
  }
  renderers = [];
  overlay?.remove();
  overlay = null;
  forecastLabel = null;
  map = null;
  markerEls.clear();
  if (following) {
    following = null;
    send({ type: "followStopped", reason: "map-lost" });
  }
  send({ type: "mapStatus", found: false, native: false });
}

setInterval(() => {
  if (map && !document.contains(map.getContainer())) detach();
  if (!map) {
    const m = discoverMap();
    if (m) attach(m);
    return;
  }
  // Renderers are recreated when the site remounts its layers.
  if (!renderers.length || renderers.some((r) => r.removed)) {
    const before = renderers.length;
    renderers = findRenderers(map);
    if (renderers.length !== before) send({ type: "mapStatus", found: true, native: renderers.length > 0 });
  }
}, 1000);

// ------------------------------------------------------------------ highlight markers

const COLORS: Record<MapMarker["style"], string> = { fav: "#facc15", focus: "#38bdf8", "fav-focus": "#38bdf8" };
const markerEls = new Map<string, { el: HTMLDivElement; placed: string }>();

function renderMarkers() {
  if (!overlay) return;
  const keep = new Set(markers.map((m) => m.id));
  for (const [id, m] of markerEls) {
    if (!keep.has(id)) {
      m.el.remove();
      markerEls.delete(id);
    }
  }
  for (const m of markers) {
    let entry = markerEls.get(m.id);
    if (!entry) {
      const el = document.createElement("div");
      el.innerHTML = '<div class="szp-ring"></div><div class="szp-star">★</div><div class="szp-label"></div>';
      el.style.visibility = "hidden";
      overlay.appendChild(el);
      entry = { el, placed: "" };
      markerEls.set(m.id, entry);
    }
    entry.el.className = `szp-mk ${m.style === "fav" ? "fav" : "focus"}${m.dead ? " dead" : ""}`;
    entry.el.style.setProperty("--c", COLORS[m.style]);
    (entry.el.querySelector(".szp-star") as HTMLElement).hidden = m.style === "focus";
    (entry.el.querySelector(".szp-label") as HTMLElement).textContent = m.label;
  }
  positionMarkers();
  ensureFrameLoop();
}

/** Place every ring on its sprite (or GPS point); hide ones that aren't on screen. */
function positionMarkers() {
  if (!map) return;
  for (const m of markers) {
    const entry = markerEls.get(m.id);
    if (!entry) continue;
    const g = geomOf(m.id);
    let placed: string;
    if (g) {
      placed = `${Math.round(g.x)}:${Math.round(g.y)}:${Math.round(g.d + 12)}:n`;
    } else if (g === null) {
      placed = "hidden";
    } else {
      // Renderer doesn't draw this player (or wasn't found): raw GPS point with a name label.
      const q = map.project([m.lng, m.lat]);
      placed = `${Math.round(q.x)}:${Math.round(q.y)}:30:f`;
    }
    if (placed === entry.placed) continue;
    entry.placed = placed;
    if (placed === "hidden") {
      entry.el.style.visibility = "hidden";
      continue;
    }
    const [x, y, d, mode] = placed.split(":");
    entry.el.style.transform = `translate(${x}px, ${y}px)`;
    entry.el.style.setProperty("--d", `${d}px`);
    entry.el.style.visibility = "";
    (entry.el.querySelector(".szp-label") as HTMLElement).hidden = mode === "n"; // the site already draws names
  }
}

// ------------------------------------------------------------------ anchors (action bar, pinned stream)

/** Viewport point just below the sprite (incl. its name label). */
function anchorOf(id: string): { x: number; y: number; visible: boolean } | null {
  if (!map) return null;
  const rect = map.getContainer().getBoundingClientRect();
  for (const r of renderers) {
    const t = r.removed ? undefined : r.tracks.get(id);
    if (!t) continue;
    // Boxes are only refreshed for sprites drawn in the latest frame.
    if (t.placedFrame !== r.frameSerial) return { x: 0, y: 0, visible: false };
    const x = (t.box.left + t.box.right) / 2;
    const y = t.box.bottom;
    const visible = t.box.right > 0 && t.box.left < rect.width && t.box.bottom > 0 && t.box.top < rect.height;
    return { x: rect.left + x, y: rect.top + y, visible };
  }
  const p = players.find((pp) => pp.id === id);
  if (!p) return null;
  const q = map.project([p.lng, p.lat]);
  return { x: rect.left + q.x, y: rect.top + q.y + 30, visible: q.x >= 0 && q.y >= 0 && q.x <= rect.width && q.y <= rect.height };
}

function reportAnchors() {
  for (const id of anchorIds) {
    const a = anchorOf(id);
    if (!a) continue;
    const key = a.visible ? `${Math.round(a.x)}:${Math.round(a.y)}` : "hidden";
    if (lastAnchor.get(id) === key) continue;
    lastAnchor.set(id, key);
    send({ type: "anchor", id, x: Math.round(a.x), y: Math.round(a.y), visible: a.visible });
  }
}

/** Sprites glide between fixes on the site's own animation loop, so follow them every frame. */
function frameLoop() {
  if (!map || (!anchorIds.size && !markers.length)) {
    frame = 0;
    return;
  }
  positionMarkers();
  reportAnchors();
  frame = requestAnimationFrame(frameLoop);
}

function ensureFrameLoop() {
  if (!frame && map && (anchorIds.size || markers.length)) frame = requestAnimationFrame(frameLoop);
}

// ------------------------------------------------------------------ zone forecast (native layers)

const FC_SOURCE = "szp-zone-forecast";
const EMPTY_FC = { type: "FeatureCollection", features: [] };
let forecastReady = false;
let forecastLabel: HTMLDivElement | null = null;

function onStyleData() {
  // A style switch drops custom sources/layers; re-add on the next opportunity.
  if (map && !map.getSource(FC_SOURCE)) forecastReady = false;
  ensureForecast();
}

function ensureForecast() {
  if (!map) return;
  try {
    const src = map.getSource(FC_SOURCE);
    if (!src) {
      map.addSource(FC_SOURCE, { type: "geojson", data: forecast?.geojson ?? EMPTY_FC });
      // Below the site's custom (sprite) layers so contestants stay on top.
      const before = map.getStyle()?.layers?.find((l) => l.type === "custom")?.id;
      const isKind = (k: string) => ["==", ["get", "kind"], k];
      map.addLayer({ id: "szp-fc-fill", type: "fill", source: FC_SOURCE, filter: isKind("future"), paint: { "fill-color": "#22ff00", "fill-opacity": 0.05 } }, before);
      map.addLayer({ id: "szp-fc-ring", type: "line", source: FC_SOURCE, filter: isKind("future"), paint: { "line-color": "#22ff00", "line-width": 2, "line-opacity": 0.8, "line-dasharray": [3, 2] } }, before);
      map.addLayer({ id: "szp-fc-path", type: "line", source: FC_SOURCE, filter: isKind("path"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#22ff00", "line-width": 3, "line-opacity": 0.9 } }, before);
    } else {
      src.setData(forecast?.geojson ?? EMPTY_FC);
    }
    forecastReady = true;
  } catch {
    forecastReady = false; // style not loaded yet; retried on render/styledata
  }
  if (forecast && overlay) {
    if (!forecastLabel) {
      forecastLabel = document.createElement("div");
      forecastLabel.className = "szp-fc-label";
    }
    if (forecastLabel.parentElement !== overlay) overlay.prepend(forecastLabel);
    forecastLabel.textContent = forecast.label.text;
  } else {
    forecastLabel?.remove();
  }
  positionForecastLabel();
}

function positionForecastLabel() {
  if (!map || !forecastLabel || !forecast) return;
  const p = map.project([forecast.label.lng, forecast.label.lat]);
  forecastLabel.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
}

// ------------------------------------------------------------------ commands

function handle(msg: ToPage) {
  switch (msg.type) {
    case "markers":
      markers = msg.markers;
      renderMarkers();
      return;
    case "players":
      players = msg.players;
      return;
    case "anchors":
      anchorIds.clear();
      for (const id of msg.ids) anchorIds.add(id);
      lastAnchor.clear(); // re-report everything so consumers start from the current state
      ensureFrameLoop();
      return;
    case "zoneForecast":
      forecast = msg.forecast;
      ensureForecast();
      return;
    case "ping":
      send({ type: "mapStatus", found: !!map, native: renderers.length > 0 });
      return;
  }
  if (!map) {
    pending = msg;
    return;
  }
  switch (msg.type) {
    case "flyTo":
      following = null;
      map.flyTo({ center: [msg.lng, msg.lat], zoom: msg.zoom ?? Math.max(map.getZoom(), 16), essential: true });
      return;
    case "follow":
      if (following !== msg.id) {
        following = msg.id;
        map.flyTo({ center: [msg.lng, msg.lat], zoom: Math.max(map.getZoom(), 16.5), essential: true });
      } else {
        map.easeTo({ center: [msg.lng, msg.lat], duration: 900, essential: true });
      }
      return;
    case "unfollow":
      following = null;
      return;
  }
}

document.addEventListener(TO_PAGE, (e) => {
  try {
    handle(JSON.parse((e as CustomEvent<string>).detail) as ToPage);
  } catch {
    /* ignore malformed */
  }
});
