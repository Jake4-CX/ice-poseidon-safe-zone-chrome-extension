import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AlertEngine,
  SafeZoneState,
  applyPatch,
  edgeMarginM,
  fuzzyScore,
  guessKickSlug,
  kickUserIdFromAvatar,
  zoneAt,
  type SafeZoneObject,
} from "../src/core/index.js";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const frames = fs
  .readFileSync(fixture("ws-frames.ndjson"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { text?: string; binary?: string })
  .map((f) => f.text ?? new Uint8Array(Buffer.from(f.binary!, "base64")).buffer);

function loadState() {
  const state = new SafeZoneState();
  state.ingestAll(frames);
  return state;
}

test("replaying captured traffic builds a consistent state without resyncs", () => {
  const state = loadState();
  const players = state.players();
  assert.equal(players.length, state.slots.size);
  assert.ok(players.length > 100);
  assert.ok(players.filter((p) => p.location).length > 50);
  assert.ok(players.filter((p) => p.status).length > 50);
  assert.ok(state.safeZone(), "safe zone present");
  assert.ok(state.event?.map, "event settings present");
});

test("search finds players by partial / fuzzy names", () => {
  const state = loadState();
  assert.equal(state.search("tazo")[0]?.username, "Tazo");
  assert.equal(state.search("ice pos")[0]?.username, "Ice Poseidon");
  assert.equal(state.search("icpsdn")[0]?.username, "Ice Poseidon");
  assert.ok(fuzzyScore("tazo", "Tazo") > fuzzyScore("tazo", "xTazoFan"));
  assert.deepEqual(state.search("   "), []);
});

test("zombies resolve owner/target slots to users", () => {
  const state = loadState();
  const zombies = state.zombies();
  assert.ok(zombies.length > 0);
  const ids = new Set(state.players().map((p) => p.userId));
  for (const z of zombies) if (z.targetUserId) assert.ok(ids.has(z.targetUserId));
});

test("kick helpers", () => {
  assert.equal(guessKickSlug("Ice Poseidon"), "iceposeidon");
  assert.equal(guessKickSlug("Johnny_Sinful"), "johnny_sinful");
  assert.equal(kickUserIdFromAvatar("https://data.cx-live.com/v1/kick/avatars?id=230051&size=64"), 230051);
  assert.equal(kickUserIdFromAvatar(null), null);
});

test("zone interpolation follows transitions linearly and honours pause", () => {
  const zone: SafeZoneObject = {
    id: "z", type: "safe_zone", lat: 0, lng: 0, radius: 1000,
    transition: {
      from: { lat: 0, lng: 0, radius: 1000 },
      to: { lat: 0, lng: 0, radius: 500 },
      started_at: new Date(0).toISOString(),
      ends_at: new Date(1000).toISOString(),
      paused_at: null,
    },
  };
  assert.equal(zoneAt(zone, 500).radius, 750);
  assert.equal(zoneAt(zone, 5000).radius, 500);
  zone.transition!.paused_at = new Date(200).toISOString();
  assert.equal(zoneAt(zone, 900).radius, 900);
  assert.ok(edgeMarginM({ lat: 0, lng: 0 }, { lat: 0, lng: 0, radius: 100 }) === 100);
});

test("patches upsert, replace and remove while keeping order", () => {
  const out = applyPatch([{ id: "a", v: 1 }, { id: "b", v: 1 }], { upsert: [{ id: "b", v: 2 }, { id: "c", v: 1 }], remove: ["a"] });
  assert.deepEqual(out, [{ id: "b", v: 2 }, { id: "c", v: 1 }]);
});

test("alert engine: baseline first, then transitions", () => {
  const state = loadState();
  const engine = new AlertEngine();
  const target = state.players().find((p) => p.status?.alive && p.location)!;
  const watched = new Set([target.userId]);
  assert.deepEqual(engine.evaluate(state, watched), [], "first evaluation is a silent baseline");

  // Simulate an elimination via a sparse status update for that player.
  const statuses = (state as unknown as { statuses: Map<string, { alive: boolean; status: string }> }).statuses;
  statuses.set(target.userId, { ...statuses.get(target.userId)!, alive: false, status: "eliminated" });
  const alerts = engine.evaluate(state, watched);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, "eliminated");
});
