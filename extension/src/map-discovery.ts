/**
 * Finds the site's MapLibre map instance through React's fiber tree.
 *
 * The map container <div> (class "maplibregl-map") is rendered by the site's CxMap
 * component directly inside a context provider whose value is { map, maplibre, ... }.
 * We walk up from the container's fiber checking provider values, hook refs and
 * imperative handles for an object that quacks like a maplibregl.Map.
 */

export interface MlMapEvent {
  originalEvent?: Event;
  /** Container-relative pixel position (mouse events). */
  point?: { x: number; y: number };
}

export interface MlMap {
  flyTo(opts: object): void;
  easeTo(opts: object): void;
  getZoom(): number;
  getContainer(): HTMLElement;
  project(lngLat: [number, number]): { x: number; y: number };
  on(type: string, fn: (e: MlMapEvent) => void): void;
  off(type: string, fn: (e: MlMapEvent) => void): void;
  getSource(id: string): { setData(data: unknown): void } | undefined;
  addSource(id: string, source: object): void;
  addLayer(layer: object, beforeId?: string): void;
  getStyle(): { layers?: { id: string; type: string }[] } | undefined;
}

/**
 * The site's contestant sprite renderer (class "am" in publicMapScene). Sprites are drawn on
 * a canvas, but each track exposes its exact screen box (refreshed every drawn frame) and the
 * sprite layouts, whose (cx, cy) is the avatar ring centre and `ring` its diameter.
 *
 * Don't use the renderer's `attach()`: it holds ONE element per player and the site's own
 * hover card replaces it, orphaning ours.
 */
export interface CxLayout {
  width: number;
  height: number;
  cx: number;
  cy: number;
  ring: number;
}
export interface CxTrack {
  x: number;
  y: number;
  box: { left: number; top: number; right: number; bottom: number };
  placedFrame: number;
  full?: { layout?: CxLayout };
  compact?: { layout?: CxLayout };
}
export interface CxRenderer {
  id: string;
  tracks: Map<string, CxTrack>;
  frameSerial: number;
  removed: boolean;
  attach(id: string, el: HTMLElement): () => void;
  hitTest(point: { x: number; y: number }): string | null;
}

/** Avatar-ring centre and diameter in map-container pixels. */
export interface SpriteGeom {
  x: number;
  y: number;
  d: number;
}

/**
 * Where a player's sprite was drawn in the renderer's latest frame. `undefined` = the renderer
 * doesn't know the player; `null` = known but not drawn (off screen).
 */
export function spriteGeom(r: CxRenderer, id: string): SpriteGeom | null | undefined {
  const t = r.tracks.get(id);
  if (!t) return undefined;
  if (t.placedFrame !== r.frameSerial) return null;
  const b = t.box;
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  if (!(w > 0 && h > 0)) return null;
  // The box is one of the two layouts (full / compact while crowded or zoomed out) scaled;
  // pick whichever matches the box's aspect ratio.
  let best: CxLayout | null = null;
  let bestErr = Infinity;
  for (const lay of [t.full?.layout, t.compact?.layout]) {
    if (!lay?.width || !lay.height) continue;
    const err = Math.abs(h - (lay.height * w) / lay.width);
    if (err < bestErr) {
      bestErr = err;
      best = lay;
    }
  }
  if (best && best.ring > 0) {
    const s = w / best.width;
    return { x: b.left + best.cx * s, y: b.top + best.cy * s, d: best.ring * s };
  }
  return { x: b.left + w / 2, y: b.top + w / 2, d: w * 0.8 };
}

export const isRenderer = (x: unknown): x is CxRenderer =>
  !!x && typeof (x as CxRenderer).attach === "function" && typeof (x as CxRenderer).hitTest === "function" && (x as CxRenderer).tracks instanceof Map;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fiber = any;

export const isMap = (x: unknown): x is MlMap =>
  !!x && typeof (x as MlMap).flyTo === "function" && typeof (x as MlMap).project === "function" && typeof (x as MlMap).getContainer === "function";

function fiberOf(el: Element): Fiber | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  return key ? (el as unknown as Record<string, Fiber>)[key] : null;
}

export function mapFromFiber(start: Fiber): MlMap | null {
  let f = start;
  for (let depth = 0; f && depth < 60; depth++, f = f.return) {
    const value = f.memoizedProps?.value;
    if (value && isMap(value.map)) return value.map;
    let hook = f.memoizedState;
    for (let n = 0; hook && typeof hook === "object" && n < 100; n++, hook = hook.next) {
      const s = hook.memoizedState;
      if (s && typeof s === "object") {
        if (isMap(s.current)) return s.current;
        if (isMap(s)) return s;
        if (typeof s.current?.getMap === "function" && isMap(s.current.getMap())) return s.current.getMap();
      }
    }
  }
  return null;
}

/**
 * Find the site's sprite renderers. Map layers are React components rendered *inside* the
 * map's context provider; each keeps `useRef({ renderer: { renderer, hoverCard }, state })`.
 * So: walk up from the map container to the provider, then depth-first through its subtree.
 */
export function findRenderers(map: MlMap): CxRenderer[] {
  let provider: Fiber = fiberOf(map.getContainer());
  while (provider && provider.memoizedProps?.value?.map !== map) provider = provider.return;
  if (!provider) return [];
  const found = new Set<CxRenderer>();
  const stack: Fiber[] = [provider.child];
  for (let visited = 0; stack.length && visited < 50_000; visited++) {
    const f = stack.pop();
    if (!f) continue;
    let hook = f.memoizedState;
    for (let n = 0; hook && typeof hook === "object" && n < 100; n++, hook = hook.next) {
      const cur = hook.memoizedState?.current;
      if (isRenderer(cur?.renderer?.renderer)) found.add(cur.renderer.renderer);
      else if (isRenderer(cur?.renderer)) found.add(cur.renderer);
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return [...found].filter((r) => !r.removed);
}

/** The largest map on the page whose instance we can reach. */
export function discoverMap(doc: Document = document): MlMap | null {
  const containers = [...doc.querySelectorAll<HTMLElement>(".maplibregl-map")].sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
  );
  for (const el of containers) {
    // React attaches the fiber to the element it rendered; walk up in case the class moved.
    for (let node: Element | null = el; node && node !== doc.body; node = node.parentElement) {
      const fiber = fiberOf(node);
      if (!fiber) continue;
      try {
        const map = mapFromFiber(fiber);
        if (map && map.getContainer() === el) return map;
      } catch {
        /* keep looking */
      }
      break;
    }
  }
  return null;
}
