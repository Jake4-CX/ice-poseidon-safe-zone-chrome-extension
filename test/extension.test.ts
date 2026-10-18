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
for (const k of ["window", "document", "HTMLElement", "Element", "Node", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "location", "getComputedStyle"]) {
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
  assert.deepEqual([...new Set(fc.geojson.features.map((f) => f.properties.kind))].sort(), ["future", "outline", "path"]);
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

test("blackout bypass setting: players stay visible and the map draws ghosts for them", async () => {
  const state = app.client.state;
  state.event.map.blackout = { until: new Date(Date.now() + 600_000).toISOString(), source: "emp" };
  await app.store.updateSettings({ showDuringBlackout: true });
  toPage.length = 0;
  app.lastGhosts = "";
  app.onState(new Set(["event"]));
  app.renderNow();
  assert.match($(".banner").textContent!, /EMP blackout until .*Showing players anyway: \d+ still updating/);
  assert.ok($(".banner").classList.contains("warn"), "banner styled as a notice, not an error");
  assert.doesNotMatch($(".row .l2").textContent!, /hidden during blackout/);
  const ghosts = toPage.filter((m) => m.type === "ghosts").at(-1)!.ghosts as { id: string; live: boolean; avatar: string | null }[];
  const alive = state.players().filter((p: { status?: { alive: boolean } }) => p.status?.alive !== false && (p as { lastSeen: unknown }).lastSeen);
  assert.ok(ghosts.length > 50 && ghosts.length <= alive.length, `ghosts for alive players (${ghosts.length})`);
  // The state clock follows the capture, so these fixes are fresh: live ghosts, counted in the banner.
  const liveCount = Number(/(\d+) still updating/.exec($(".banner").textContent!)![1]);
  assert.equal(ghosts.filter((g) => g.live).length, liveCount);
  assert.ok(liveCount > 0, "some positions still updating");

  // Turning it off restores the blackout and removes the ghosts.
  await app.store.updateSettings({ showDuringBlackout: false });
  app.onState(new Set(["event"]));
  app.renderNow();
  assert.match($(".row .l2").textContent!, /hidden during blackout/);
  assert.deepEqual(toPage.filter((m) => m.type === "ghosts").at(-1)!.ghosts, []);
  state.event.map.blackout = null;
  app.onState(new Set(["event"]));
});

test("multiple safe zones: header counts them, margins use the union, forecast outlines it", () => {
  const state = app.client.state;
  const main = state.safeZone();
  const far = { ...main, id: "zone-2", lat: main.lat + 0.05, radius: 500 };
  state.ingest(JSON.stringify({ type: "map_objects_patch", data: { upsert: [far], remove: [] } }));
  app.renderNow();
  assert.match($(".hstats").textContent!, /2 zones/);
  // A player standing in the new zone counts as inside.
  const p = state.players().find((x: { location: unknown }) => x.location);
  const { byId } = app.views();
  assert.ok(byId.get(p.userId).margin !== null, "margin computed against the union");
  state.ingest(JSON.stringify({ type: "map_objects_patch", data: { upsert: [], remove: ["zone-2"] } }));
});

test("player details show inventory, sigil and activity like the site's card", async () => {
  const state = app.client.state;
  const tazo = state.search("tazo", 1)[0];
  state.rosterStatsVisible = true;
  const roster = {
    id: "roster-tazo", name: "Tazo", avatar_url: null, eliminated_at: null, sigil: "endurance", kick_slug: "tazo", live: true, map_user_id: tazo.userId,
    inventory: [{ item: { type: "emp", duration_seconds: 600 }, label: "EMP (10 min)", icon: { url: "https://files.iceposeidon.com/i/emp.png", badge: null, alt: "EMP" }, slot_key: null, stealable: true }],
  };
  state.roster = [roster];
  const realFetch = g.fetch;
  const asked: string[] = [];
  g.fetch = async (url: string) => {
    asked.push(url);
    return { ok: true, json: async () => ({ visible: true, next_before: null, entries: [
      { id: "1", at: new Date().toISOString(), category: "attack", text: "Kalkalaka set off an EMP. Their map is hidden for 10 min.", hp_before: null, hp_after: null, icon: null },
    ] }) };
  };
  app.activity.clear();
  app.expanded = tazo.userId;
  app.renderNow();
  await flush();
  app.renderNow();
  g.fetch = realFetch;
  const details = $(".details").textContent!;
  assert.match(details, /Sigil Endurance/);
  assert.match(details, /EMP \(10 min\)/);
  assert.match(details, /Kalkalaka set off an EMP/);
  assert.equal(asked[0], "https://event-api.iceposeidon.com/public/event/contestants/roster-tazo/damage-log?limit=30");
  state.roster = [];
  app.expanded = null;
});

test("site's contestant card: our actions move inside it instead of overlapping", async () => {
  const id = app.client.state.search("tazo", 1)[0].userId;
  const fromBridge = (msg: object) =>
    document.dispatchEvent(new dom.window.CustomEvent("szp:to-content", { detail: JSON.stringify(msg) }));
  fromBridge({ type: "playerClicked", id });
  fromBridge({ type: "anchor", id, x: 400, y: 300, visible: true });
  assert.ok(!$(".card").hidden, "floating bar shown first");

  // The site opens its modal for the same player.
  const dialog = document.createElement("section");
  dialog.setAttribute("role", "dialog");
  dialog.innerHTML = '<div class="header"><h2>Tazo</h2></div><div class="body">Inventory…</div>';
  document.body.appendChild(dialog);
  await flush();
  assert.ok($(".card").hidden, "floating bar hidden while the site card is open");
  const strip = dialog.querySelector<HTMLElement>("[data-szp-card]");
  assert.ok(strip, "actions injected into the site card");
  assert.equal(strip.previousElementSibling, dialog.firstElementChild, "right below the card header");
  const inner = strip.shadowRoot!.querySelector(".card.inline")!;
  assert.ok(inner.querySelector('[data-act="watch"]'), "watch button in the strip");
  toPage.length = 0;
  (inner.querySelector('[data-act="locate"]') as HTMLElement).click();
  assert.ok(toPage.some((m) => m.type === "flyTo"), "locate flies the map");

  dialog.remove();
  await flush();
  assert.equal(app.cardId, null, "closing the site card closes ours too");
});


test("update check: compares versions, sanitises the download link, keeps the last answer on errors", async () => {
  const { checkForUpdate, compareVersions, RELEASES_URL } = await import("../extension/src/update.js");
  assert.equal(compareVersions("0.10.0", "0.9.3"), 1);
  assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.2.1"), -1);
  const reply = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
  const fresh = await checkForUpdate("0.1.0", true, reply({ version: "0.2.0", notes: "New stuff", download: "https://evil.example/zip" }));
  assert.equal(fresh.available, true, "newer version flagged");
  assert.equal(fresh.latest!.download, RELEASES_URL, "foreign download links replaced");
  const same = await checkForUpdate("0.2.0", true, reply({ version: "0.2.0" }));
  assert.equal(same.available, false, "same version is up to date");
  const failed = await checkForUpdate("0.1.0", true, reply(null, false));
  assert.match(failed.error!, /HTTP 500/);
  assert.equal(failed.latest!.version, "0.2.0", "last good answer kept");
});

test("update notice shows in the panel and can be dismissed for that version", () => {
  app.update = { current: "0.1.0", latest: { version: "0.2.0", notes: "New stuff", download: "https://github.com/Jake4-CX/ice-poseidon-safe-zone-chrome-extension/releases/latest" }, available: true, checkedAt: Date.now() };
  app.ui.dismissedUpdate = null;
  app.renderUpdate();
  const el = $(".update");
  assert.ok(!el.hidden, "notice visible");
  assert.match(el.textContent!, /SafeZone\+ 0\.2\.0 is available/);
  (el.querySelector('[data-ui="dismiss-update"]') as HTMLElement).click();
  assert.ok($(".update").hidden, "dismissed");
  assert.equal(app.ui.dismissedUpdate, "0.2.0");
});

test("last positions are saved and restored, so a reload during a blackout still has them", async () => {
  app.lastSeenSavedAt = 0;
  app.lastSeenSaved = "";
  app.saveLastSeen();
  await flush();
  const saved = storage.local.lastSeen as Record<string, import("../src/core/index.js").PlayerLocation>;
  assert.ok(saved && Object.keys(saved).length > 50, "positions persisted");
  const { SafeZoneState } = await import("../src/core/index.js");
  const fresh = new SafeZoneState();
  fresh.seedLastSeen(saved);
  assert.equal(Object.keys(fresh.exportLastSeen()).length, Object.keys(saved).length);
  // A newer position from this session wins over a remembered one.
  const [id, loc] = Object.entries(saved)[0]!;
  fresh.seedLastSeen({ [id]: { ...loc, lat: 0, recordedAt: loc.recordedAt - 1 } });
  assert.equal(fresh.exportLastSeen()[id]!.lat, loc.lat);
});

test("hide site header: header tucked away, revealed at the top edge, restored when turned off", async () => {
  const header = document.createElement("section");
  header.innerHTML = "<nav>tabs</nav>";
  const main = document.createElement("main");
  document.body.prepend(header, main);
  await app.store.updateSettings({ hideHeader: true });
  const html = document.documentElement;
  assert.ok(html.classList.contains("szp-hide-header"), "header hidden");
  assert.ok(header.hasAttribute("data-szp-header"), "header found before <main>");
  assert.ok(!$(".hdr-tab").hidden, "pull tab shown");
  document.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientY: 2, bubbles: true }));
  assert.ok(html.classList.contains("szp-header-peek"), "revealed at the top edge");
  ($(".hdr-tab") as HTMLButtonElement).click();
  ($(".hdr-tab") as HTMLButtonElement).click();
  assert.ok(html.classList.contains("szp-header-peek"), "tab pins it open");
  await app.store.updateSettings({ hideHeader: false });
  assert.ok(!html.classList.contains("szp-hide-header") && !html.classList.contains("szp-header-peek"), "restored");
  assert.ok($(".hdr-tab").hidden, "tab hidden again");
  header.remove();
  main.remove();
});

test("expanded details use the full row width and clicks inside don't collapse the row", () => {
  const p = app.client.state.search("tazo", 1)[0];
  $<HTMLInputElement>("input").value = app.query = p.username;
  app.expanded = p.userId;
  app.renderNow();
  const row = root.querySelector<HTMLElement>(`.row[data-id="${p.userId}"]`)!;
  const more = row.querySelector<HTMLElement>(":scope > .more")!;
  assert.ok(more.querySelector(".details"), "details live in the full-width slot");
  assert.ok(!row.querySelector(".body .details"), "not squeezed into the name column");
  (more.querySelector(".details .k") as HTMLElement).click();
  assert.equal(app.expanded, p.userId, "still expanded");
  app.expanded = null;
  app.renderNow();
  assert.ok(row.querySelector<HTMLElement>(":scope > .more")!.hidden, "slot hidden when collapsed");
  $<HTMLInputElement>("input").value = app.query = "";
});

test("activity requests back off when the site answers Blocked", async () => {
  const realFetch = g.fetch;
  let calls = 0;
  g.fetch = async () => {
    calls++;
    return { ok: false, status: 403, text: async () => '{"error":"Blocked"}' };
  };
  app.activity.clear();
  app.ensureActivity("someone");
  await flush();
  await flush();
  const a = app.activity.get("someone");
  assert.equal(a.error, "blocked");
  a.at = Date.now() - 20_000; // past the normal 15s refresh, inside the 2 min backoff
  app.ensureActivity("someone");
  await flush();
  assert.equal(calls, 1, "no retry within the backoff");
  g.fetch = realFetch;
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

test("calm EMP effect: the site's flashing overlay is switched off and a frame + countdown shown instead", async () => {
  const { countdown } = await import("../extension/src/content/emp-effect.js");
  assert.equal(countdown(247_000), "4:07");
  assert.equal(countdown(3_727_000), "1:02:07");

  // Stand-ins for the site's map and its EMP effect (hashed CSS-module class names).
  const mapEl = document.createElement("div");
  mapEl.className = "maplibregl-map";
  mapEl.getBoundingClientRect = () => ({ left: 0, top: 100, width: 1200, height: 700, right: 1200, bottom: 800, x: 0, y: 100, toJSON() {} }) as DOMRect;
  const canvas = document.createElement("div");
  canvas.className = "maplibregl-canvas-container _shocked_9zz9_93 _humming_9zz9_97";
  const storm = document.createElement("div");
  storm.className = "_storm_9zz9_1";
  mapEl.append(canvas, storm);
  document.body.appendChild(mapEl);

  const state = app.client.state;
  state.event.map.blackout = { until: new Date(state.now() + 247_000).toISOString(), source: "emp" };
  await app.store.updateSettings({ calmEmp: true, showDuringBlackout: false });
  app.syncEmpEffect();
  app.renderNow();
  const view = dom.window;
  assert.ok(document.documentElement.classList.contains("szp-calm-emp"), "calm mode on");
  assert.equal(view.getComputedStyle(storm).display, "none", "lightning/tint/scanlines overlay hidden");
  assert.equal(view.getComputedStyle(canvas).animationName || "none", "none", "map flicker stopped");
  const pill = $(".emp-pill");
  assert.ok(!pill.hidden && !$(".emp-frame").hidden, "calm indicator shown");
  assert.match(pill.textContent!, /EMP blackout · ends in 4:0[67]/);
  assert.equal(pill.style.top, "110px", "pill sits at the top of the map");
  assert.match($(".hstats").textContent!, /⚡ EMP 4:0[67]/, "countdown in the panel header (visible when collapsed)");

  // Setting off: the site's effect is left alone and our indicator hides.
  await app.store.updateSettings({ calmEmp: false });
  app.syncEmpEffect();
  assert.ok(!document.documentElement.classList.contains("szp-calm-emp"), "site effect untouched");
  assert.notEqual(view.getComputedStyle(storm).display, "none");
  assert.ok($(".emp-pill").hidden, "pill hidden");

  // Blackout over: nothing shown.
  await app.store.updateSettings({ calmEmp: true });
  state.event.map.blackout = null;
  app.syncEmpEffect();
  assert.ok($(".emp-pill").hidden && $(".emp-frame").hidden, "indicator gone after the blackout");
  mapEl.remove();
});

// Keep last: leaves the replayed game in the "server withholds players" (EMP) state.
test("EMP with the setting on: cached players stay in the panel and on the map as frozen ghosts", async () => {
  const state = app.client.state;
  const known = state.players().filter((p: { location: unknown }) => p.location).length;
  state.event.map.blackout = { until: new Date(Date.now() + 600_000).toISOString(), source: "emp" };
  await app.store.updateSettings({ showDuringBlackout: true });
  // What the server sends during an EMP: no slots, then empty location/status frames.
  const clearOf = (kind: number) => {
    const src = frames.find((f) => typeof f !== "string" && new Uint8Array(f as ArrayBuffer)[0] === kind) as ArrayBuffer;
    const head = new Uint8Array(src.slice(0, 36));
    const view = new DataView(head.buffer);
    view.setUint16(2, 3, true);
    view.setUint32(8, 0xfffffff0, true);
    view.setUint16(28, 0, true);
    view.setUint16(30, 1, true);
    view.setUint16(32, 0, true);
    return head.buffer;
  };
  const chestsBefore = state.chests().filter((c: { claimed: boolean }) => !c.claimed).length;
  const zonesOnly = state.mapObjects.filter((o: { type: string }) => o.type === "safe_zone");
  state.ingestAll([
    JSON.stringify({ type: "contestants", data: { roster: null, slots: { definition_sequence: state.slotsDefinition + 1, slots: [] } } }),
    clearOf(1),
    clearOf(2),
    JSON.stringify({ type: "map_objects", data: zonesOnly }), // chests removed too
  ]);
  assert.equal(state.slots.size, 0, "slots withheld");
  toPage.length = 0;
  app.lastGhosts = app.lastChests = "";
  app.onState(new Set(["slots"]));
  $<HTMLInputElement>("input").value = app.query = "";
  app.ui.filter = "alive";
  app.renderNow();
  assert.notEqual($(".hstats").textContent, "loading…", "not stuck on loading");
  assert.ok($$(".row").length > 10, "player rows still listed");
  assert.match($(".banner").textContent!, /sends no player data until then/);
  assert.match($(".row .l2").textContent!, /frozen/);
  const ghosts = toPage.filter((m) => m.type === "ghosts").at(-1)!.ghosts as { live: boolean }[];
  assert.ok(ghosts.length > 0 && ghosts.length <= known, "ghosts at remembered positions");
  assert.ok(ghosts.every((g) => !g.live), "all frozen (⏸)");
  assert.ok(ghosts.every((g) => typeof (g as unknown as { seenAt: unknown }).seenAt === "number"), "frozen ghosts carry when they were seen; the bridge counts up");
  assert.ok(chestsBefore > 0, "fixture has chests");
  const chests = toPage.filter((m) => m.type === "chests").at(-1)!.chests as unknown[];
  assert.equal(chests.length, chestsBefore, "unclaimed chests from before the EMP are drawn");
});
