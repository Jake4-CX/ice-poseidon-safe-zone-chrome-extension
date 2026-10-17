import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SafeZoneState,
  ZoneTracker,
  destination,
  distanceM,
  edgeEta,
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
