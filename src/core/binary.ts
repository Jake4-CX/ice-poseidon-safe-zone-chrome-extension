/**
 * Decoder for the binary frames sent by wss://event-public.iceposeidon.com/public-map-ws.
 *
 * Reverse engineered from the site's `cx-client` bundle. Every frame starts with a
 * 36-byte little-endian header followed by a columnar ("struct of arrays") body:
 *
 *   off size field
 *   0   u8   kind            1..8 (see FrameKind)
 *   1   u8   version         always 1
 *   2   u16  flags           1 = full, 3 = full|clear, 4 = sparse (delta)
 *   4   u32  generation
 *   8   u32  sequence        per-kind, strictly increasing
 *   12  f64  eventRevision
 *   20  f64  sampledAt       unix ms
 *   28  u16  partIndex       large updates are split into multiple parts
 *   30  u16  partCount
 *   32  u16  recordCount     records in *this* part
 *   34  u16  reserved (0)
 *
 * See docs/PROTOCOL.md for per-kind body layouts.
 */

export const HEADER_BYTES = 36;
const MAX_FRAME_BYTES = 65536;
const NULL_U16 = 0xffff;
/** Positions in kinds 1 & 8 are 1e-5 degree offsets from an origin. */
const COARSE_SCALE = 1e5;
/** Absolute positions in kind 4 use 1e-7 degrees. */
const FINE_SCALE = 1e7;

export enum FrameKind {
  /** Contestant GPS fixes, keyed by slot. */
  Locations = 1,
  /** Contestant health / status, keyed by slot. */
  Status = 2,
  /** Positions of moving entities (needs an entity-definitions stream; unused publicly). */
  EntityPositions = 3,
  /** Missiles, nukes and god's fruit in flight. */
  Projectiles = 4,
  /** Personal: nearby players (authenticated sockets only). */
  Motion = 5,
  /** Personal: own health overlay (authenticated sockets only). */
  Overlay = 6,
  /** Zombie definitions (ids, owner, leech stats). */
  ZombieRoster = 7,
  /** Zombie positions + who they're chasing / leeching. */
  ZombieStates = 8,
}

export type FrameMode = "full" | "clear" | "sparse";

export interface FrameHeader {
  kind: FrameKind;
  version: number;
  flags: number;
  mode: FrameMode;
  generation: number;
  sequence: number;
  eventRevision: number;
  sampledAt: number;
  partIndex: number;
  partCount: number;
  recordCount: number;
}

export const HEALTH_STATUSES = ["disabled", "paused", "inside", "outside", "unavailable", "eliminated"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export const BADGES = ["kick_shield", "faith_shield"] as const;
export type Badge = (typeof BADGES)[number];
export const PROJECTILE_KINDS = ["missile", "nuke", "gods_fruit"] as const;
export type ProjectileKind = (typeof PROJECTILE_KINDS)[number];
export const PROJECTILE_VARIANTS = ["standard", "abz"] as const;

export interface LocationFix {
  slot: number;
  lat: number;
  lng: number;
  /** Unix ms the fix was recorded, or null when the server omits it (unchanged). */
  at: number | null;
  accuracyM: number;
  /** Device reported a mock (spoofed) location provider. */
  mock: boolean;
}
export interface LocationsPayload {
  definitionSequence: number;
  ageBaseMs: number;
  fixes: LocationFix[];
}

export interface StatusRecord {
  slot: number;
  self: boolean;
  alive: boolean;
  status: HealthStatus;
  hp: number;
  maxHp: number;
  badges: Badge[];
  poison: { startedAt: number; endsAt: number } | null;
  droneLandsAt: number | null;
  outsideSince: number | null;
  nextDamageAt: number | null;
}
export interface StatusPayload {
  definitionSequence: number;
  timeBase: number;
  records: StatusRecord[];
}

export interface Projectile {
  id: string;
  kind: ProjectileKind;
  variant: (typeof PROJECTILE_VARIANTS)[number];
  lat: number;
  lng: number;
  targetLat: number;
  targetLng: number;
  targetRadiusM: number;
  landsAt: number;
  amount: number;
  launchedBy: string | null;
  spawnedByUserId: string | null;
}

export interface ZombieDefinition {
  id: string;
  ownerSlot: number | null;
  expiresAt: number | null;
  guard: boolean;
  speedMps: number | null;
  leechAmount: number;
  leechIntervalSeconds: number;
  leechRadiusM: number;
}
export interface ZombieRosterPayload {
  rosterSequence: number;
  slotsSequence: number;
  timeBase: number;
  zombies: ZombieDefinition[];
}

export interface ZombieState {
  /** Index into the current ZombieRoster's `zombies` array. */
  index: number;
  lat: number;
  lng: number;
  targetSlot: number | null;
  leeching: { slot: number; nextHitAt: number }[];
}
export interface ZombieStatesPayload {
  rosterSequence: number;
  timeBase: number;
  zombies: ZombieState[];
}

export type DecodedFrame =
  | { kind: FrameKind.Locations; header: FrameHeader; payload: LocationsPayload | null }
  | { kind: FrameKind.Status; header: FrameHeader; payload: StatusPayload | null }
  | { kind: FrameKind.Projectiles; header: FrameHeader; payload: Projectile[] | null }
  | { kind: FrameKind.ZombieRoster; header: FrameHeader; payload: ZombieRosterPayload | null }
  | { kind: FrameKind.ZombieStates; header: FrameHeader; payload: ZombieStatesPayload | null }
  | { kind: FrameKind.EntityPositions | FrameKind.Motion | FrameKind.Overlay; header: FrameHeader; payload: null };

export class FrameError extends RangeError {
  override name = "FrameError";
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new FrameError(msg);
}

export function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

function uuidAt(bytes: Uint8Array, off: number): string {
  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[off + i]!.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const nullableU16 = (v: number) => (v === NULL_U16 ? null : v);

export function decodeHeader(data: ArrayBuffer | ArrayBufferView): FrameHeader {
  const bytes = toBytes(data);
  check(bytes.byteLength >= HEADER_BYTES && bytes.byteLength <= MAX_FRAME_BYTES, "Invalid binary frame length");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = dv.getUint8(0);
  check(kind >= 1 && kind <= 8, `Unsupported binary kind ${kind}`);
  check(dv.getUint8(1) === 1, "Unsupported binary version");
  const flags = dv.getUint16(2, true);
  check(flags === 1 || flags === 3 || flags === 4, `Invalid binary flags ${flags}`);
  const mode: FrameMode = flags === 4 ? "sparse" : flags & 2 ? "clear" : "full";
  const header: FrameHeader = {
    kind,
    version: 1,
    flags,
    mode,
    generation: dv.getUint32(4, true),
    sequence: dv.getUint32(8, true),
    eventRevision: dv.getFloat64(12, true),
    sampledAt: dv.getFloat64(20, true),
    partIndex: dv.getUint16(28, true),
    partCount: dv.getUint16(30, true),
    recordCount: dv.getUint16(32, true),
  };
  check(header.partCount > 0 && header.partIndex < header.partCount, "Invalid multipart metadata");
  if (mode === "clear") check(header.recordCount === 0, "Invalid CLEAR");
  return header;
}

/** Decode a single binary frame (one part of a possibly multipart update). */
export function decodeFrame(data: ArrayBuffer | ArrayBufferView): DecodedFrame {
  const header = decodeHeader(data);
  const bytes = toBytes(data);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = header.recordCount;
  const H = HEADER_BYTES;

  if (header.mode === "clear") return { kind: header.kind, header, payload: null } as DecodedFrame;

  switch (header.kind) {
    case FrameKind.Locations: {
      check(bytes.byteLength === H + 20 + 11 * n, "Locations length mismatch");
      const definitionSequence = dv.getUint32(H, true);
      const ageBaseMs = dv.getFloat64(H + 4, true);
      const oLat = dv.getInt32(H + 12, true);
      const oLng = dv.getInt32(H + 16, true);
      const P = H + 20;
      const fixes: LocationFix[] = [];
      for (let i = 0; i < n; i++) {
        const marks = dv.getUint8(P + 10 * n + i);
        const hasAge = (marks & 2) !== 0;
        const age = dv.getUint16(P + 6 * n + 2 * i, true);
        fixes.push({
          slot: dv.getUint16(P + 4 * n + 2 * i, true),
          lat: (oLat + dv.getInt16(P + 2 * i, true)) / COARSE_SCALE,
          lng: (oLng + dv.getInt16(P + 2 * n + 2 * i, true)) / COARSE_SCALE,
          at: hasAge ? ageBaseMs - age * 100 : null,
          accuracyM: dv.getUint16(P + 8 * n + 2 * i, true) / 10,
          mock: (marks & 1) !== 0,
        });
      }
      return { kind: FrameKind.Locations, header, payload: { definitionSequence, ageBaseMs, fixes } };
    }

    case FrameKind.Status: {
      check(bytes.byteLength === H + 12 + 28 * n, "Status length mismatch");
      const definitionSequence = dv.getUint32(H, true);
      const timeBase = dv.getFloat64(H + 4, true);
      const P = H + 12;
      const records: StatusRecord[] = [];
      for (let i = 0; i < n; i++) {
        const flags = dv.getUint16(P + 4 * n + 2 * i, true);
        const badgeBits = dv.getUint8(P + 3 * n + i);
        const status = HEALTH_STATUSES[dv.getUint8(P + 2 * n + i)];
        check(status !== undefined, "Unsupported health status");
        const time = (bit: number, col: number) =>
          flags & bit ? timeBase + dv.getInt32(P + col * n + 4 * i, true) * 100 : null;
        const poisonStart = time(2, 8);
        const poisonEnd = time(2, 12);
        records.push({
          slot: dv.getUint16(P + 2 * i, true),
          self: (flags & 32) !== 0,
          alive: (flags & 1) !== 0,
          status,
          hp: dv.getUint8(P + 6 * n + i),
          maxHp: dv.getUint8(P + 7 * n + i),
          badges: BADGES.filter((_, b) => (badgeBits & (1 << b)) !== 0),
          poison: poisonStart !== null && poisonEnd !== null ? { startedAt: poisonStart, endsAt: poisonEnd } : null,
          droneLandsAt: time(4, 16),
          outsideSince: time(8, 20),
          nextDamageAt: time(16, 24),
        });
      }
      return { kind: FrameKind.Status, header, payload: { definitionSequence, timeBase, records } };
    }

    case FrameKind.Projectiles: {
      const decoder = new TextDecoder();
      let off = H;
      const out: Projectile[] = [];
      for (let i = 0; i < n; i++) {
        check(off + 52 <= bytes.byteLength, "Projectile length mismatch");
        const kind = PROJECTILE_KINDS[dv.getUint8(off + 16)];
        const variant = PROJECTILE_VARIANTS[dv.getUint8(off + 17)];
        check(kind !== undefined && variant !== undefined, "Unsupported projectile kind/variant");
        const launcherLen = dv.getUint8(off + 18);
        const pFlags = dv.getUint8(off + 19);
        const launcherEnd = off + 52 + launcherLen;
        const end = pFlags & 1 ? launcherEnd + 16 : launcherEnd;
        check(end <= bytes.byteLength, "Projectile length mismatch");
        out.push({
          id: uuidAt(bytes, off),
          kind,
          variant,
          lat: dv.getInt32(off + 20, true) / FINE_SCALE,
          lng: dv.getInt32(off + 24, true) / FINE_SCALE,
          targetLat: dv.getInt32(off + 28, true) / FINE_SCALE,
          targetLng: dv.getInt32(off + 32, true) / FINE_SCALE,
          targetRadiusM: dv.getFloat32(off + 36, true),
          landsAt: dv.getFloat64(off + 40, true),
          amount: dv.getUint32(off + 48, true),
          launchedBy: launcherLen ? decoder.decode(bytes.subarray(off + 52, launcherEnd)) : null,
          spawnedByUserId: end === launcherEnd ? null : uuidAt(bytes, launcherEnd),
        });
        off = end;
      }
      check(off === bytes.byteLength, "Projectile trailing bytes");
      return { kind: FrameKind.Projectiles, header, payload: out };
    }

    case FrameKind.ZombieRoster: {
      check(bytes.byteLength === H + 16 + 37 * n, "Zombie roster length mismatch");
      const rosterSequence = dv.getUint32(H, true);
      const slotsSequence = dv.getUint32(H + 4, true);
      const timeBase = dv.getFloat64(H + 8, true);
      const P = H + 16;
      const zombies: ZombieDefinition[] = [];
      for (let i = 0; i < n; i++) {
        const flags = dv.getUint8(P + 36 * n + i);
        zombies.push({
          id: uuidAt(bytes, P + 16 * i),
          ownerSlot: nullableU16(dv.getUint16(P + 16 * n + 2 * i, true)),
          expiresAt: flags & 2 ? timeBase + dv.getInt32(P + 18 * n + 4 * i, true) * 100 : null,
          guard: (flags & 1) !== 0,
          speedMps: flags & 4 ? dv.getFloat32(P + 22 * n + 4 * i, true) : null,
          leechIntervalSeconds: dv.getFloat32(P + 26 * n + 4 * i, true),
          leechRadiusM: dv.getFloat32(P + 30 * n + 4 * i, true),
          leechAmount: dv.getUint16(P + 34 * n + 2 * i, true),
        });
      }
      return { kind: FrameKind.ZombieRoster, header, payload: { rosterSequence, slotsSequence, timeBase, zombies } };
    }

    case FrameKind.ZombieStates: {
      const P = H + 20;
      const F = P + 9 * n;
      check(bytes.byteLength >= F, "Zombie state length mismatch");
      const counts = Array.from({ length: n }, (_, i) => dv.getUint8(P + 8 * n + i));
      const L = counts.reduce((a, b) => a + b, 0);
      check(bytes.byteLength === F + 6 * L, "Zombie state length mismatch");
      const rosterSequence = dv.getUint32(H, true);
      const timeBase = dv.getFloat64(H + 4, true);
      const oLat = dv.getInt32(H + 12, true);
      const oLng = dv.getInt32(H + 16, true);
      let j = 0;
      const zombies: ZombieState[] = counts.map((count, i) => {
        const leeching = Array.from({ length: count }, () => {
          const rec = {
            slot: dv.getUint16(F + 2 * j, true),
            nextHitAt: timeBase + dv.getInt32(F + 2 * L + 4 * j, true) * 100,
          };
          j++;
          return rec;
        });
        return {
          index: dv.getUint16(P + 2 * i, true),
          lat: (oLat + dv.getInt16(P + 2 * n + 2 * i, true)) / COARSE_SCALE,
          lng: (oLng + dv.getInt16(P + 4 * n + 2 * i, true)) / COARSE_SCALE,
          targetSlot: nullableU16(dv.getUint16(P + 6 * n + 2 * i, true)),
          leeching,
        };
      });
      return { kind: FrameKind.ZombieStates, header, payload: { rosterSequence, timeBase, zombies } };
    }

    default:
      // Kinds 3/5/6 are not meaningful on the public socket; header only.
      return { kind: header.kind, header, payload: null } as DecodedFrame;
  }
}

/** Concatenate the payloads of a complete multipart update into one logical frame. */
function mergeParts(parts: DecodedFrame[]): DecodedFrame {
  const first = parts[0]!;
  if (parts.length === 1 || first.payload === null) return first;
  const header: FrameHeader = {
    ...first.header,
    partIndex: 0,
    partCount: 1,
    recordCount: parts.reduce((a, p) => a + p.header.recordCount, 0),
  };
  switch (first.kind) {
    case FrameKind.Locations:
      return { kind: first.kind, header, payload: { ...first.payload, fixes: parts.flatMap((p) => (p.payload as LocationsPayload).fixes) } };
    case FrameKind.Status:
      return { kind: first.kind, header, payload: { ...first.payload, records: parts.flatMap((p) => (p.payload as StatusPayload).records) } };
    case FrameKind.Projectiles:
      return { kind: first.kind, header, payload: parts.flatMap((p) => p.payload as Projectile[]) };
    case FrameKind.ZombieRoster:
      return { kind: first.kind, header, payload: { ...first.payload, zombies: parts.flatMap((p) => (p.payload as ZombieRosterPayload).zombies) } };
    case FrameKind.ZombieStates:
      return { kind: first.kind, header, payload: { ...first.payload, zombies: parts.flatMap((p) => (p.payload as ZombieStatesPayload).zombies) } };
    default:
      return first;
  }
}

/** Raised when a sparse (delta) frame can't be applied; the caller should resync. */
export class SequenceGapError extends Error {
  override name = "SequenceGapError";
}

const PENDING_TIMEOUT_MS = 5000;

/**
 * Reassembles multipart frames and enforces per-kind sequencing, mirroring the
 * site's own client. `accept()` returns a complete logical update, or null while
 * parts are still outstanding / the frame is stale.
 */
export class FrameAssembler {
  private generation = 0;
  private latest = new Map<number, number>();
  private baselines = new Set<number>();
  private pending = new Map<number, { header: FrameHeader; startedAt: number; parts: Map<number, DecodedFrame> }>();

  reset(): void {
    this.generation = 0;
    this.latest.clear();
    this.baselines.clear();
    this.pending.clear();
  }

  accept(data: ArrayBuffer | ArrayBufferView, now = Date.now()): DecodedFrame | null {
    const header = decodeHeader(data);
    const kind = header.kind;
    if (header.generation !== this.generation) {
      // New server generation: all sequence state is void.
      this.reset();
      this.generation = header.generation;
    }
    if (header.sequence <= (this.latest.get(kind) ?? 0)) return null;
    if (header.mode === "sparse" && (!this.baselines.has(kind) || header.sequence !== (this.latest.get(kind) ?? 0) + 1)) {
      this.pending.delete(kind);
      this.baselines.delete(kind);
      throw new SequenceGapError(`Sparse gap on kind ${kind} (seq ${header.sequence})`);
    }

    let entry = this.pending.get(kind);
    if (entry && (header.sequence !== entry.header.sequence || now - entry.startedAt > PENDING_TIMEOUT_MS)) entry = undefined;
    entry ??= { header, startedAt: now, parts: new Map() };
    entry.parts.set(header.partIndex, decodeFrame(data));
    this.pending.set(kind, entry);
    if (entry.parts.size !== header.partCount) return null;

    const merged = mergeParts(Array.from({ length: header.partCount }, (_, i) => entry!.parts.get(i)!));
    this.pending.delete(kind);
    this.latest.set(kind, header.sequence);
    this.baselines.add(kind);
    return merged;
  }
}
