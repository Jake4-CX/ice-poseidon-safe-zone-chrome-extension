/**
 * Smoke tests for the extension's content-script panel and map discovery, run in jsdom
 * with a mocked chrome.* API and captured live frames (no network).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id=map></div></body></html>", {
  url: "https://iceposeidon.com/safezone/map",
  pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "HTMLElement", "Element", "Node", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "location", "getComputedStyle"]) {
  g[k] = (dom.window as unknown as Record<string, unknown>)[k];
}
g.confirm = () => true;

// The panel must never touch the network in tests.
class FakeWebSocket {
  binaryType = "";
  onmessage = null;
  onclose = null;
  onerror = null;
  onopen = null;
  close() {}
}
g.WebSocket = FakeWebSocket;
g.fetch = () => Promise.reject(new Error("offline"));

// --- chrome.* mock
const storage: Record<"sync" | "local", Record<string, unknown>> = { sync: {}, local: {} };
const changeListeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
const sentToBackground: { type: string; [k: string]: unknown }[] = [];
const area = (name: "sync" | "local") => ({
  get: async (keys: string | string[]) => Object.fromEntries([keys].flat().map((k) => [k, storage[name][k]])),
  set: async (obj: Record<string, unknown>) => {
    Object.assign(storage[name], obj);
    const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { newValue: v }]));
    for (const l of changeListeners) l(changes, name);
  },
});
g.chrome = {
  storage: { sync: area("sync"), local: area("local"), onChanged: { addListener: (fn: (typeof changeListeners)[number]) => changeListeners.push(fn) } },
  runtime: {
    sendMessage: async (msg: { type: string; slug?: string; expectedUserId?: number | null }) => {
      sentToBackground.push(msg);
      if (msg.type === "kick") {
        return {
          ok: true,
          channel: msg.slug === "tazo"
            ? { slug: "tazo", userId: 230051, username: "Tazo", live: true, viewers: 543, title: "Safezone Austin", thumbnailUrl: null, verified: msg.expectedUserId === 230051 }
            : null,
        };
      }
      return undefined;
    },
  },
};

const frames = fs
  .readFileSync(new URL("./fixtures/ws-frames.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { text?: string; binary?: string })
  .map((f) => f.text ?? new Uint8Array(Buffer.from(f.binary!, "base64")).buffer);

const toPage: { type: string; [k: string]: unknown }[] = [];
dom.window.document.addEventListener("szp:to-page", (e) => toPage.push(JSON.parse((e as CustomEvent<string>).detail)));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
let CSS_TEXT = "";
let root: ShadowRoot;
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T;
const $$ = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];

before(async () => {
  const { App } = await import("../extension/src/content/app.js");
  CSS_TEXT = (await import("../extension/src/content/styles.js")).CSS;
  app = new App();
  await app.mount();
  app.client.stop();
  app.client.state.ingestAll(frames);
  app.renderNow();
  root = document.getElementById("safezone-plus")!.shadowRoot!;
});

after(() => app?.unmount());

test("panel mounts and shows live counts", () => {
  assert.match($(".hstats").textContent!, /\d+\/\d+ alive/);
  assert.equal($$(".chip").length, 6);
  assert.match($(".list").textContent!, /No favourites yet/);
});

test("search finds a player and favouriting persists to sync storage", async () => {
  const input = $<HTMLInputElement>("input");
  input.value = "tazo";
  input.dispatchEvent(new dom.window.Event("input"));
  const row = $(".row");
  assert.ok(row, "a result row is rendered");
  assert.equal(row.querySelector(".name")!.textContent, "Tazo");

  (row.querySelector('[data-act="fav"]') as HTMLElement).click();
  await flush();
  const favs = storage.sync.favourites as Record<string, { username: string }>;
  assert.deepEqual(Object.values(favs).map((f) => f.username), ["Tazo"]);
});

test("kick lookup marks the verified channel live", async () => {
  await flush();
  app.renderNow();
  assert.ok(sentToBackground.some((m) => m.type === "kick" && m.slug === "tazo" && m.expectedUserId === 230051));
  assert.match($(".row .live")!.textContent!, /LIVE 543/);
  assert.ok(!$('.row [data-act="watch"]').hasAttribute("disabled"));
});

test("locate flies the map and highlights favourite + focus", () => {
  toPage.length = 0;
  ($('.row [data-act="locate"]') as HTMLElement).click();
  const fly = toPage.find((m) => m.type === "flyTo");
  assert.ok(fly, "flyTo sent to page bridge");
  assert.ok(Math.abs((fly.lat as number) - 30.25) < 0.2);
  const markers = toPage.filter((m) => m.type === "markers").at(-1)!.markers as { label: string; style: string }[];
  assert.deepEqual(markers.map((m) => [m.label, m.style]), [["Tazo", "fav-focus"]]);
  assert.ok($(".row").classList.contains("focus"));
});

test("watch opens a floating Kick player that can be pinned under the player", () => {
  ($('.row [data-act="watch"]') as HTMLElement).click();
  const win = $(".stream");
  assert.ok(!win.hidden);
  assert.match(win.querySelector<HTMLIFrameElement>("iframe")!.src, /^https:\/\/player\.kick\.com\/tazo\?autoplay=true&muted=true$/);
  assert.match(win.querySelector(".ttl")!.textContent!, /Tazo.*LIVE 543/);

  toPage.length = 0;
  (win.querySelector('[data-sact="pin"]') as HTMLElement).click();
  const id = app.client.state.search("tazo", 1)[0].userId;
  assert.deepEqual(toPage.find((m) => m.type === "anchors")?.ids, [id], "bridge asked to track the pinned player");
  document.dispatchEvent(new dom.window.CustomEvent("szp:to-content", { detail: JSON.stringify({ type: "anchor", id, x: 500, y: 400, visible: true }) }));
  assert.equal(win.style.top, "408px", "window sits just below the sprite");
  assert.equal(storage.local.ui && (storage.local.ui as { stream: { pinned: boolean } }).stream.pinned, true, "pin state persisted");

  // Player scrolled off screen: the pinned window hides (stream keeps playing), then returns.
  document.dispatchEvent(new dom.window.CustomEvent("szp:to-content", { detail: JSON.stringify({ type: "anchor", id, x: 0, y: 0, visible: false }) }));
  assert.equal(win.style.visibility, "hidden");
  document.dispatchEvent(new dom.window.CustomEvent("szp:to-content", { detail: JSON.stringify({ type: "anchor", id, x: 300, y: 200, visible: true }) }));
  assert.equal(win.style.visibility, "");
  assert.equal(win.style.top, "208px");

  // Mute toggle reloads the embed with muted=false and remembers it.
  const mute = win.querySelector<HTMLElement>('[data-sact="mute"]')!;
  assert.match(mute.title, /Unmute/);
  mute.click();
  assert.match(win.querySelector<HTMLIFrameElement>("iframe")!.src, /muted=false$/);
  assert.equal((storage.local.ui as { stream: { muted: boolean } }).stream.muted, false);
  mute.click();
  assert.match(win.querySelector<HTMLIFrameElement>("iframe")!.src, /muted=true$/);

  (win.querySelector('[data-sact="pin"]') as HTMLElement).click();
  assert.equal(win.style.visibility, "", "unpinned windows are always visible");
  (win.querySelector('[data-sact="close"]') as HTMLElement).click();
  assert.ok(win.hidden);
});

test("list sorting: alive by HP (favourites first), low HP ascending, eliminated newest first", () => {
  const input = $<HTMLInputElement>("input");
  input.value = "";
  input.dispatchEvent(new dom.window.Event("input"));
  const namesFor = (filter: string) => {
    ($(`[data-filter="${filter}"]`) as HTMLElement).click();
    return $$(".row").map((r) => app.client.state.player(r.dataset.id!));
  };
  const alive = namesFor("alive");
  const tazoIdx = alive.findIndex((p: { username: string }) => p.username === "Tazo");
  assert.equal(tazoIdx, 0, "favourite pinned to the top");
  const hps = alive.slice(1).map((p: { status: { hp: number } }) => p.status.hp);
  assert.deepEqual(hps, [...hps].sort((a, b) => b - a));

  const low = namesFor("lowhp").map((p: { status: { hp: number } }) => p.status.hp);
  assert.deepEqual(low, [...low].sort((a, b) => a - b));

  const dead = namesFor("eliminated").map((p: { death: { at: number } | null }) => p.death?.at ?? -Infinity);
  assert.deepEqual(dead, [...dead].sort((a, b) => b - a));
  assert.match($(".row .l2").textContent!, /Eliminated· .*ago/);
  ($('[data-filter="favourites"]') as HTMLElement).click();
});

test("zone forecast is sent to the bridge with heading and speed", () => {
  app.lastForecast = "";
  toPage.length = 0;
  app.syncMap();
  const fc = toPage.find((m) => m.type === "zoneForecast")?.forecast as { label: { text: string }; geojson: { features: { properties: { kind: string } }[] } };
  assert.ok(fc, "forecast sent");
  assert.match(fc.label.text, /↖ NW \d(\.\d)? km\/h · in 10 min/);
  assert.deepEqual([...new Set(fc.geojson.features.map((f) => f.properties.kind))].sort(), ["future", "path"]);
  assert.match($(".hstats").innerHTML, /zmove/);
});

test("favourite alerts produce a toast and an alerts-tab entry", () => {
  const state = app.client.state;
  const tazo = state.search("tazo", 1)[0];
  app.onState(new Set(["status"])); // baseline
  const statuses = state.statuses as Map<string, { alive: boolean; status: string }>;
  statuses.set(tazo.userId, { ...statuses.get(tazo.userId)!, alive: false, status: "eliminated" });
  app.onState(new Set(["status"]));
  assert.match($(".toast").textContent!, /Tazo was eliminated/);
  ($('[data-tab="alerts"]') as HTMLElement).click();
  assert.match($(".alert .m").textContent!, /Tazo was eliminated/);
  ($('[data-tab="players"]') as HTMLElement).click();
});

test("expanded row offers watch / Kick / Google Maps buttons", () => {
  app.expanded = app.client.state.search("tazo", 1)[0].userId;
  app.renderNow();
  const labels = [...root.querySelectorAll(".details .pbtn")].map((b) => b.textContent!.trim());
  assert.deepEqual(labels, ["Watch", "Open on Kick", "Google Maps"]);
  assert.equal(root.querySelector<HTMLAnchorElement>('.details a.pbtn[href*="kick.com"]')!.href, "https://kick.com/tazo");
});

test("player positions are shared with the bridge for click hit-testing", () => {
  app.lastPlayers = "";
  toPage.length = 0;
  app.syncMap();
  const msg = toPage.find((m) => m.type === "players");
  assert.ok(msg);
  assert.ok((msg.players as unknown[]).length > 50);
});

test("clicking a player on the map shows an anchored action bar", async () => {
  const id = app.client.state.search("tazo", 1)[0].userId;
  const fromBridge = (msg: object) =>
    document.dispatchEvent(new dom.window.CustomEvent("szp:to-content", { detail: JSON.stringify(msg) }));
  fromBridge({ type: "playerClicked", id });
  assert.ok($(".card").hidden, "stays hidden until the bridge reports a screen position");
  fromBridge({ type: "anchor", id, x: 400, y: 300, visible: true });
  const card = $(".card");
  assert.ok(!card.hidden);
  assert.equal(card.querySelector(".cname")!.textContent, "Tazo");
  assert.match(card.textContent!, /LIVE 543/);
  assert.ok(!card.querySelector('[data-act="watch"]')!.hasAttribute("disabled"));
  assert.equal(card.style.top, "308px");

  fromBridge({ type: "anchor", id, x: 400, y: 300, visible: false });
  assert.ok(card.hidden, "hidden while the player is off screen");

  toPage.length = 0;
  (card.querySelector('[data-act="close"]') as HTMLElement).click();
  assert.ok(card.hidden);
  assert.deepEqual(toPage.find((m) => m.type === "anchors")?.ids, []);

  fromBridge({ type: "playerClicked", id: null });
  assert.ok($(".card").hidden);
});

test("blackout hides positions and map markers", () => {
  const state = app.client.state;
  state.event.map.blackout = { until: new Date(Date.now() + 600_000).toISOString(), source: "emp" };
  toPage.length = 0;
  app.onState(new Set(["event"]));
  app.renderNow();
  assert.ok(!$(".banner").hidden);
  assert.match($(".banner").textContent!, /EMP has blacked out the map/);
  assert.match($(".row .l2").textContent!, /hidden during blackout/);
  assert.ok($('.row [data-act="locate"]').hasAttribute("disabled"));
  const markers = toPage.filter((m) => m.type === "markers").at(-1)!.markers as unknown[];
  assert.equal(markers.length, 0);
  state.event.map.blackout = null;
});

test("map discovery walks the React fiber tree to the MapLibre instance", async () => {
  const { discoverMap } = await import("../extension/src/map-discovery.js");
  const doc = dom.window.document;
  const container = doc.getElementById("map")!;
  container.className = "maplibregl-map";
  const fakeMap = { flyTo() {}, easeTo() {}, getZoom: () => 12, project: () => ({ x: 0, y: 0 }), on() {}, off() {}, getContainer: () => container };
  // Same shape as the site: host div fiber -> root div fiber -> context provider { value: { map } }
  const provider = { memoizedProps: { value: { map: fakeMap, maplibre: {} } }, memoizedState: null, return: null };
  const rootDiv = { memoizedProps: {}, memoizedState: null, return: provider };
  (container as unknown as Record<string, unknown>)["__reactFiber$abc123"] = { memoizedProps: {}, memoizedState: null, return: rootDiv };
  assert.equal(discoverMap(doc), fakeMap);

  // Fallback: map held in a useRef hook further up.
  const component = { memoizedProps: {}, memoizedState: { memoizedState: { current: fakeMap }, next: null }, return: null };
  (container as unknown as Record<string, unknown>)["__reactFiber$abc123"] = { memoizedProps: {}, memoizedState: null, return: component };
  assert.equal(discoverMap(doc), fakeMap);
});

test("renderer discovery finds the site's sprite renderer below the map provider", async () => {
  const { findRenderers } = await import("../extension/src/map-discovery.js");
  const container = document.getElementById("map")!;
  const fakeMap = { flyTo() {}, easeTo() {}, getZoom: () => 12, project: () => ({ x: 0, y: 0 }), on() {}, off() {}, getContainer: () => container };
  const renderer = { id: "cx-contestants", tracks: new Map(), frameSerial: 1, removed: false, attach: () => () => {}, hitTest: () => null };
  // provider -> [unrelated sibling layer, contestant layer with the feature-hook ref]
  const layer = { memoizedState: { memoizedState: { current: { renderer: { renderer, hoverCard: {} }, state: {} } }, next: null }, child: null, sibling: null };
  const other = { memoizedState: { memoizedState: { current: null }, next: null }, child: null, sibling: layer };
  const provider: Record<string, unknown> = { memoizedProps: { value: { map: fakeMap } }, child: other, return: null };
  (container as unknown as Record<string, unknown>)["__reactFiber$abc123"] = { memoizedProps: {}, return: { memoizedProps: {}, return: provider } };
  assert.deepEqual(findRenderers(fakeMap as never), [renderer]);
  renderer.removed = true;
  assert.deepEqual(findRenderers(fakeMap as never), [], "removed renderers are ignored");
});

test("sprite geometry: avatar-ring centre from the drawn box, full vs compact layout", async () => {
  const { spriteGeom } = await import("../extension/src/map-discovery.js");
  const full = { width: 60, height: 90, cx: 30, cy: 30, ring: 40 };
  const compact = { width: 30, height: 40, cx: 15, cy: 15, ring: 24 };
  const track = { x: 0, y: 0, placedFrame: 7, full: { layout: full }, compact: { layout: compact }, box: { left: 100, top: 50, right: 160, bottom: 140 } };
  const r = { id: "cx-contestants", tracks: new Map([["u1", track]]), frameSerial: 7, removed: false, attach: () => () => {}, hitTest: () => null };
  assert.deepEqual(spriteGeom(r, "u1"), { x: 130, y: 80, d: 40 });
  // Compact sprite drawn at 1.5x
  track.box = { left: 200, top: 100, right: 245, bottom: 160 };
  assert.deepEqual(spriteGeom(r, "u1"), { x: 222.5, y: 122.5, d: 36 });
  r.frameSerial = 8; // not drawn in the latest frame = off screen
  assert.equal(spriteGeom(r, "u1"), null);
  assert.equal(spriteGeom(r, "nobody"), undefined);
});

test("action bar sits below the panel in the stacking order", () => {
  const z = (sel: string) => Number(/z-index:\s*(\d+)/.exec(new RegExp(`\\n${sel.replace(".", "\\.")} \\{[^}]*`).exec((CSS_TEXT))?.[0] ?? "")?.[1]);
  assert.ok(z(".card") < z(".panel"), `card ${z(".card")} vs panel ${z(".panel")}`);
  assert.ok(z(".card") < z(".stream"));
});

test("alerts dock in the map's top-left control corner when the map is present", () => {
  const corner = document.createElement("div");
  corner.className = "maplibregl-ctrl-top-left";
  document.getElementById("map")!.appendChild(corner);
  app.toast({ kind: "eliminated", userId: "u1", username: "Tazo", message: "Tazo was eliminated (map)", severity: "danger", at: Date.now() });
  const host = corner.querySelector<HTMLElement>(".maplibregl-ctrl")!;
  assert.ok(host, "control host injected into the corner");
  assert.match(host.shadowRoot!.querySelector(".toast")!.textContent!, /Tazo was eliminated \(map\)/);
  assert.ok(![...root.querySelectorAll(".toasts .toast")].some((t) => /\(map\)/.test(t.textContent!)), "not duplicated in the panel");
});
