import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decodeFrame,
  decodeHeader,
  FrameAssembler,
  FrameKind,
  FrameError,
  SequenceGapError,
  type MapSnapshotResponse,
} from "../src/core/index.js";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

const wsFrames: { text?: string; binary?: string }[] = fs
  .readFileSync(fixture("ws-frames.ndjson"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const binaries = wsFrames.filter((f) => f.binary).map((f) => b64(f.binary!));

test("every captured binary frame decodes", () => {
  assert.ok(binaries.length > 100);
  for (const bytes of binaries) {
    const f = decodeFrame(bytes);
    assert.ok(f.kind >= 1 && f.kind <= 8);
    assert.equal(f.header.version, 1);
  }
});

test("header fields are sane", () => {
  const h = decodeHeader(binaries[0]!);
  assert.equal(h.generation, 1);
  assert.ok(h.sequence > 0);
  // sampledAt is a unix-ms timestamp from the capture day
  assert.ok(h.sampledAt > Date.parse("2026-01-01") && h.sampledAt < Date.parse("2027-01-01"));
});

test("location fixes land in Austin with plausible accuracy", () => {
  const loc = binaries.map(decodeFrame).find((f) => f.kind === FrameKind.Locations && f.payload);
  assert.ok(loc && loc.kind === FrameKind.Locations && loc.payload);
  assert.ok(loc.payload.fixes.length > 50);
  for (const fix of loc.payload.fixes) {
    assert.ok(fix.lat > 30 && fix.lat < 30.6, `lat ${fix.lat}`);
    assert.ok(fix.lng > -98 && fix.lng < -97.4, `lng ${fix.lng}`);
    assert.ok(fix.accuracyM >= 0 && fix.accuracyM < 6553.5);
  }
});

test("status records decode hp/max hp/status", () => {
  const st = binaries.map(decodeFrame).find((f) => f.kind === FrameKind.Status && f.header.mode === "full");
  assert.ok(st && st.kind === FrameKind.Status && st.payload);
  for (const r of st.payload.records) {
    assert.ok(r.hp <= r.maxHp || r.status === "eliminated");
    assert.ok(r.maxHp > 0 && r.maxHp <= 200);
  }
  assert.ok(st.payload.records.some((r) => r.status === "inside"));
});

test("projectile frame decodes a nuke", () => {
  const f = decodeFrame(b64(fs.readFileSync(fixture("projectile-frame.b64"), "utf8")));
  assert.equal(f.kind, FrameKind.Projectiles);
  assert.ok(f.kind === FrameKind.Projectiles && f.payload);
  const [p] = f.payload;
  assert.ok(p);
  assert.equal(p.kind, "nuke");
  assert.equal(p.variant, "standard");
  assert.equal(p.launchedBy, "asco");
  assert.equal(p.targetRadiusM, 100);
  assert.equal(p.amount, 20);
  assert.equal(p.spawnedByUserId, null);
  assert.ok(Math.abs(p.lat - 30.2161068) < 1e-6);
  assert.match(p.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("zombie roster and states line up", () => {
  const decoded = binaries.map(decodeFrame);
  const roster = decoded.find((f) => f.kind === FrameKind.ZombieRoster && f.payload);
  const states = decoded.find((f) => f.kind === FrameKind.ZombieStates && f.header.mode === "full");
  assert.ok(roster?.kind === FrameKind.ZombieRoster && roster.payload);
  assert.ok(states?.kind === FrameKind.ZombieStates && states.payload);
  assert.equal(states.payload.rosterSequence, roster.payload.rosterSequence);
  for (const z of states.payload.zombies) assert.ok(z.index < roster.payload.zombies.length);
});

test("rejects garbage", () => {
  assert.throws(() => decodeFrame(new Uint8Array(10)), FrameError);
  const bad = new Uint8Array(binaries[0]!);
  bad[0] = 99;
  assert.throws(() => decodeFrame(bad), FrameError);
});

test("assembler drops stale frames and flags sparse gaps", () => {
  const asm = new FrameAssembler();
  const sparse = binaries.find((b) => decodeHeader(b).mode === "sparse")!;
  // A sparse frame with no baseline can't be applied.
  assert.throws(() => asm.accept(sparse), SequenceGapError);

  const asm2 = new FrameAssembler();
  const full = binaries.find((b) => decodeHeader(b).kind === FrameKind.Locations && decodeHeader(b).mode === "full")!;
  assert.ok(asm2.accept(full));
  assert.equal(asm2.accept(full), null, "replayed sequence is ignored");
});

test("snapshot endpoint frames decode", () => {
  const snap = JSON.parse(fs.readFileSync(fixture("map-snapshot.json"), "utf8")) as MapSnapshotResponse;
  const asm = new FrameAssembler();
  let complete = 0;
  for (const f of snap.frames) if ("binary" in f && asm.accept(b64(f.binary))) complete++;
  assert.ok(complete > 0);
});
