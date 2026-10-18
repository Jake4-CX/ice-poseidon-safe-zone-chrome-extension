import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SafeZoneState,
  ZoneTracker,
  destination,
  distanceM,
  edgeEta,
  edgeEtaAny,
  fromLocalM,
  predictZone,
  type SafeZoneObject,
  type ZoneMotion,
} from "../src/core/index.js";

const frames = fs
  .readFileSync(new URL("./fixtures/ws-frames.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { text?: string; binary?: string })
  .map((f) => f.text ?? new Uint8Array(Buffer.from(f.binary!, "base64")).buffer);

const zoneAtOrigin = (radius = 100): SafeZoneObject => ({ id: "z", type: "safe_zone", lat: 30, lng: -97, radius });
const eastward = (speed: number): ZoneMotion => ({ vEast: speed, vNorth: 0, speedMps: speed, headingDeg: 90, radiusRateMps: 0, spanS: 60 });

test("tracker recovers the zone's real drift from captured traffic (~1 m/s north-west)", () => {
  const state = new SafeZoneState();
  state.ingestAll(frames);
  const m = state.zoneMotion();
  assert.ok(m, "motion estimated");
  assert.ok(m.speedMps > 0.8 && m.speedMps < 1.2, `speed ${m.speedMps}`);
  assert.ok(m.headingDeg > 290 && m.headingDeg < 330, `heading ${m.headingDeg}`);
  assert.ok(Math.abs(m.radiusRateMps) < 0.01);
});

test("tracker: least squares on synthetic motion, reset on teleport", () => {
  const z = new ZoneTracker();
  const start = { lat: 30, lng: -97 };
  for (let s = 0; s <= 60; s += 2) z.observe(s * 1000, { ...destination(start, 45, s * 2), radius: 1000 - s });
  const m = z.motion()!;
  assert.ok(Math.abs(m.speedMps - 2) < 0.01);
  assert.ok(Math.abs(m.headingDeg - 45) < 0.5);
  assert.ok(Math.abs(m.radiusRateMps + 1) < 0.01);
  z.observe(62_000, { ...destination(start, 0, 5000), radius: 1000 });
  assert.equal(z.motion(), null, "a 5 km jump resets history");
});

test("predictZone extrapolates linearly", () => {
  const p = predictZone(zoneAtOrigin(), eastward(1), 0, 60_000);
  assert.ok(Math.abs(distanceM({ lat: 30, lng: -97 }, p) - 60) < 0.5);
});

test("edgeEta: inside point exits, outside point gets reached", () => {
  const zone = zoneAtOrigin(100);
  const centre = { lat: 30, lng: -97 };
  const exit = edgeEta(centre, zone, eastward(1), 0)!;
  assert.equal(exit.kind, "exits");
  assert.ok(Math.abs(exit.ms - 100_000) < 50);
  const ahead = destination(centre, 90, 150);
  const enter = edgeEta(ahead, zone, eastward(1), 0)!;
  assert.equal(enter.kind, "enters");
  assert.ok(Math.abs(enter.ms - 50_000) < 100);
  assert.equal(edgeEta(destination(centre, 270, 150), zone, eastward(1), 0), null, "zone moving away never reaches it");
  assert.equal(edgeEta(centre, zone, null, 0), null);
});

test("edgeEta follows a scheduled shrink", () => {
  const zone: SafeZoneObject = {
    ...zoneAtOrigin(1000),
    transition: {
      from: { lat: 30, lng: -97, radius: 1000 },
      to: { lat: 30, lng: -97, radius: 0 },
      started_at: new Date(0).toISOString(),
      ends_at: new Date(1000_000).toISOString(),
      paused_at: null,
    },
  };
  const p = destination({ lat: 30, lng: -97 }, 0, 500);
  const eta = edgeEta(p, zone, null, 0)!;
  assert.equal(eta.kind, "exits");
  assert.ok(Math.abs(eta.ms - 500_000) < 1000, `eta ${eta.ms}`);
});

test("deaths come from gravestones with cause and source", () => {
  const state = new SafeZoneState();
  state.ingestAll(frames);
  const dead = state.players().filter((p) => p.death);
  assert.ok(dead.length > 10);
  const d = dead[0]!.death!;
  assert.ok(d.at > Date.parse("2026-01-01"));
  assert.ok(dead.some((p) => p.death!.source === "zone"));
});

test("edgeEtaAny: safe while inside any zone; exits only when the last one leaves", () => {
  const centre = { lat: 30.29, lng: -97.74 };
  const zoneAt = (id: string, eastM: number, radius: number) => {
    const p = fromLocalM(centre, eastM, 0);
    return { id, type: "safe_zone" as const, lat: p.lat, lng: p.lng, radius } as SafeZoneObject;
  };
  const still = { vEast: 0, vNorth: 0, speedMps: 0, headingDeg: 0, radiusRateMps: 0, spanS: 60 };
  const east1 = { ...still, vEast: 1, speedMps: 1, headingDeg: 90 };
  // Point at the centre. Zone A (r=100) drifts east at 1 m/s: alone it would leave the point
  // after 100s. Zone B (r=300, centred 250m west) is stationary and also covers the point.
  const a = { zone: zoneAt("a", 0, 100), motion: east1 };
  const b = { zone: zoneAt("b", -250, 300), motion: still };
  const now = Date.parse("2026-10-18T19:00:00Z");
  assert.equal(edgeEtaAny(centre, [a], now)!.ms, 100_000);
  assert.equal(edgeEtaAny(centre, [a, b], now), null, "B keeps them safe");
  // B drifting west at 1 m/s leaves the point after 50s, A after 100s: exit at 100s.
  const bWest = { zone: b.zone, motion: { ...still, vEast: -1, speedMps: 1, headingDeg: 270 } };
  assert.equal(Math.round(edgeEtaAny(centre, [a, bWest], now)!.ms), 100_000);
  // Outside both: whichever reaches the point first.
  const far = fromLocalM(centre, 400, 0);
  const eta = edgeEtaAny(far, [a, bWest], now)!;
  assert.equal(eta.kind, "enters");
  assert.equal(Math.round(eta.ms / 1000), 300); // A's edge: 400 - 100 = 300 m at 1 m/s
});
