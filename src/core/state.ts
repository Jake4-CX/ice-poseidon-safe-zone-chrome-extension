import {
  FrameAssembler,
  FrameKind,
  type Badge,
  type DecodedFrame,
  type HealthStatus,
  type Projectile,
  type ZombieRosterPayload,
  type ZombieState,
} from "./binary.js";
import {
  applyPatch,
  parseTextMessage,
  type EventMessage,
  type Explosion,
  type GameItem,
  type LastKnown,
  type MapObject,
  type RosterContestant,
  type SafeZoneObject,
  type Slot,
} from "./messages.js";
import { fuzzySearch } from "./search.js";
import { kickUserIdFromAvatar } from "./kick.js";
import { zoneAt } from "./geo.js";
import { ZoneTracker, type ZoneMotion } from "./zone.js";

export interface PlayerDeath {
  /** Unix ms. */
  at: number;
  /** e.g. "damage" (from the gravestone); null when we only saw them die live. */
  cause: string | null;
  /** e.g. "zone", "zombie", "c4". */
  source: string | null;
  killer: string | null;
}

export interface PlayerLocation {
  lat: number;
  lng: number;
  accuracyM: number;
  /** Unix ms. */
  recordedAt: number;
  mock: boolean;
}

export interface PlayerStatus {
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

export interface Player {
  userId: string;
  slot: number;
  username: string;
  avatarUrl: string | null;
  kickUserId: number | null;
  /** Curated roster entry (kick slug, live flag) when the server provides one. */
  roster: RosterContestant | null;
  location: PlayerLocation | null;
  /** Last known position published while the player is hidden (e.g. invisibility). */
  lastKnown: { lat: number; lng: number; recordedAt: number } | null;
  status: PlayerStatus | null;
  death: PlayerDeath | null;
}

export interface Zombie {
  id: string;
  lat: number;
  lng: number;
  ownerUserId: string | null;
  targetUserId: string | null;
  guard: boolean;
  expiresAt: number | null;
  speedMps: number | null;
  leechRadiusM: number;
  leeching: { userId: string; nextHitAt: number }[];
}

/** Thrown when the stream can't be applied consistently; reconnect for a fresh baseline. */
export class ResyncRequired extends Error {
  override name = "ResyncRequired";
}

export type StateChange =
  | "event" | "slots" | "roster" | "locations" | "status" | "map_objects"
  | "items" | "explosions" | "projectiles" | "zombies" | "heartbeat";

type Listener = (changes: Set<StateChange>) => void;

const EXPLOSION_TTL_MS = 60_000;

/**
 * Holds the full public-map state, fed by raw socket/snapshot frames via `ingest()`.
 * Mirrors the site's client logic. Unlike the site, data is NOT hidden during blackouts;
 * consumers can check `blackout` and decide.
 */
export class SafeZoneState {
  event: EventMessage["data"] | null = null;
  slotsDefinition = 0;
  slots = new Map<number, Slot>();
  roster: RosterContestant[] = [];
  rosterStatsVisible = false;
  mapObjects: MapObject[] = [];
  items: GameItem[] = [];
  lastKnown: LastKnown[] = [];
  explosions: Explosion[] = [];
  projectiles: Projectile[] = [];
  /** serverTime - localTime, from heartbeats. */
  clockOffsetMs = 0;
  lastMessageAt = 0;
  readonly zoneTracker = new ZoneTracker();
  /** Deaths are kept even after the gravestone disappears (looted/expired). */
  private deaths = new Map<string, PlayerDeath>();
  private latestSampledAt = 0;

  private assembler = new FrameAssembler();
  private locations = new Map<string, PlayerLocation>();
  private watermarks = new Map<string, number>();
  private statuses = new Map<string, PlayerStatus>();
  private zombieRoster: ZombieRosterPayload | null = null;
  private zombieStates = new Map<number, ZombieState>();
  private listeners = new Set<Listener>();
  private pending = new Set<StateChange>();
  private batchDepth = 0;

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Call when a new socket session starts: sequencing restarts, baselines are resent. */
  resetStreams(): void {
    this.assembler.reset();
    this.zombieStates.clear();
  }

  /** Feed a sequence of frames (e.g. the map-snapshot) with a single change notification. */
  ingestAll(frames: Iterable<string | ArrayBuffer | ArrayBufferView>): void {
    this.batchDepth++;
    try {
      for (const f of frames) this.ingest(f);
    } finally {
      this.batchDepth--;
      this.flush();
    }
  }

  ingest(frame: string | ArrayBuffer | ArrayBufferView): void {
    this.lastMessageAt = Date.now();
    if (typeof frame === "string") this.ingestText(frame);
    else {
      let decoded: DecodedFrame | null;
      try {
        decoded = this.assembler.accept(frame);
      } catch (e) {
        throw new ResyncRequired((e as Error).message);
      }
      if (decoded) this.ingestBinary(decoded);
    }
    this.flush();
  }

  private mark(c: StateChange) {
    this.pending.add(c);
  }

  private flush() {
    if (this.batchDepth > 0 || this.pending.size === 0) return;
    const changes = this.pending;
    this.pending = new Set();
    for (const fn of this.listeners) fn(changes);
  }

  private ingestText(text: string) {
    const msg = parseTextMessage(text);
    if (!msg) return;
    switch (msg.type) {
      case "heartbeat":
        if (msg.server_time) this.clockOffsetMs = Date.parse(msg.server_time) - Date.now();
        this.mark("heartbeat");
        return;
      case "event":
        this.event = msg.data;
        this.mark("event");
        return;
      case "contestants": {
        const { roster, slots } = msg.data;
        if (roster) {
          this.roster = roster.contestants;
          this.rosterStatsVisible = roster.stats_visible;
          this.mark("roster");
        }
        if (slots) {
          this.slotsDefinition = slots.definition_sequence;
          this.slots = new Map(slots.slots.map((s) => [s.slot, s]));
          const ids = new Set(slots.slots.map((s) => s.user_id));
          for (const m of [this.locations, this.watermarks, this.statuses]) {
            for (const id of m.keys()) if (!ids.has(id)) m.delete(id);
          }
          this.mark("slots");
        }
        return;
      }
      case "map_objects":
        this.mapObjects = msg.data;
        this.observeZone();
        this.mark("map_objects");
        return;
      case "map_objects_patch":
        this.mapObjects = applyPatch(this.mapObjects, msg.data);
        this.observeZone();
        this.mark("map_objects");
        return;
      case "game_items":
        this.items = msg.data.items;
        this.lastKnown = msg.data.last_known;
        this.recordGraves();
        this.mark("items");
        return;
      case "game_items_patch":
        this.items = applyPatch(this.items, msg.data);
        if (msg.data.last_known) this.lastKnown = msg.data.last_known;
        this.recordGraves();
        this.mark("items");
        return;
      case "explosions": {
        const cutoff = this.now() - EXPLOSION_TTL_MS;
        this.explosions = [...this.explosions, ...msg.data].filter((e) => Date.parse(e.at) > cutoff);
        this.mark("explosions");
        return;
      }
    }
  }

  /**
   * Time the data describes. Live this is the server clock; when replaying a capture the wall
   * clock is far ahead, so fall back to the latest binary frame's sampledAt.
   */
  streamTime(): number {
    const now = this.now();
    return this.latestSampledAt && Math.abs(now - this.latestSampledAt) > 60_000 ? this.latestSampledAt : now;
  }

  private observeZone() {
    const zone = this.safeZone();
    const t = this.streamTime();
    if (zone) this.zoneTracker.observe(t, zoneAt(zone, t));
  }

  private recordGraves() {
    for (const it of this.items) {
      const g = it.grave as { user_id?: string; died_at?: string; cause?: string; source?: string; killer_username?: string | null } | null;
      if (it.kind !== "gravestone" || !g?.user_id || !g.died_at) continue;
      this.deaths.set(g.user_id, {
        at: Date.parse(g.died_at),
        cause: g.cause ?? null,
        source: g.source ?? null,
        killer: g.killer_username ?? null,
      });
    }
  }

  private slotUser(slot: number | null): Slot | undefined {
    return slot === null ? undefined : this.slots.get(slot);
  }

  private ingestBinary(f: DecodedFrame) {
    this.latestSampledAt = Math.max(this.latestSampledAt, f.header.sampledAt);
    switch (f.kind) {
      case FrameKind.Locations: {
        if (f.payload && f.payload.definitionSequence !== this.slotsDefinition) {
          throw new ResyncRequired("Location slot definition mismatch");
        }
        const seen = new Set<string>();
        for (const fix of f.payload?.fixes ?? []) {
          const s = this.slots.get(fix.slot);
          if (!s) throw new ResyncRequired(`Unknown slot ${fix.slot}`);
          seen.add(s.user_id);
          const mark = this.watermarks.get(s.user_id);
          if (fix.at !== null && mark !== undefined && fix.at < mark) continue;
          const prev = this.locations.get(s.user_id);
          if (fix.at === null && !prev) continue;
          if (fix.at !== null) this.watermarks.set(s.user_id, fix.at);
          this.locations.set(s.user_id, {
            lat: fix.lat,
            lng: fix.lng,
            accuracyM: fix.accuracyM,
            recordedAt: fix.at ?? prev!.recordedAt,
            mock: fix.mock,
          });
        }
        if (f.header.mode !== "sparse") {
          for (const id of this.locations.keys()) if (!seen.has(id)) this.locations.delete(id);
        }
        this.mark("locations");
        return;
      }
      case FrameKind.Status: {
        if (f.payload && f.payload.definitionSequence !== this.slotsDefinition) {
          throw new ResyncRequired("Status slot definition mismatch");
        }
        const seen = new Set<string>();
        for (const r of f.payload?.records ?? []) {
          const s = this.slots.get(r.slot);
          if (!s) throw new ResyncRequired(`Unknown slot ${r.slot}`);
          seen.add(s.user_id);
          const { slot: _slot, self: _self, ...status } = r;
          const prev = this.statuses.get(s.user_id);
          const dead = !status.alive || status.status === "eliminated";
          if (prev?.alive && prev.status !== "eliminated" && dead && !this.deaths.has(s.user_id)) {
            this.deaths.set(s.user_id, { at: f.header.sampledAt, cause: null, source: null, killer: null });
          }
          this.statuses.set(s.user_id, status);
        }
        if (f.header.mode !== "sparse") {
          for (const id of this.statuses.keys()) if (!seen.has(id)) this.statuses.delete(id);
        }
        this.mark("status");
        return;
      }
      case FrameKind.Projectiles:
        this.projectiles = f.payload ?? [];
        this.mark("projectiles");
        return;
      case FrameKind.ZombieRoster:
        this.zombieRoster = f.payload ?? { rosterSequence: 0, slotsSequence: 0, timeBase: 0, zombies: [] };
        this.zombieStates.clear();
        this.mark("zombies");
        return;
      case FrameKind.ZombieStates: {
        const roster = this.zombieRoster;
        if (!roster || (f.payload && (f.payload.rosterSequence !== roster.rosterSequence || f.payload.zombies.some((z) => z.index >= roster.zombies.length)))) {
          throw new ResyncRequired("Zombie roster mismatch");
        }
        if (f.header.mode !== "sparse") this.zombieStates.clear();
        for (const z of f.payload?.zombies ?? []) this.zombieStates.set(z.index, z);
        this.mark("zombies");
        return;
      }
    }
  }

  // ---------------------------------------------------------------- queries

  /** Server-corrected current time. */
  now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  get blackout() {
    return this.event?.map?.blackout ?? null;
  }

  get staleAfterMs(): number {
    return this.event?.map?.location_stale_after_ms ?? 120_000;
  }

  safeZone(): SafeZoneObject | undefined {
    return this.mapObjects.find((o): o is SafeZoneObject => o.type === "safe_zone");
  }

  /** Estimated zone drift (needs ~15s of updates after connecting). */
  zoneMotion(): ZoneMotion | null {
    return this.zoneTracker.motion();
  }

  players(): Player[] {
    const rosterByUser = new Map(this.roster.filter((r) => r.map_user_id).map((r) => [r.map_user_id!, r]));
    const lastKnownByUser = new Map(this.lastKnown.map((l) => [l.user_id, l]));
    return [...this.slots.values()].map((s) => {
      const lk = lastKnownByUser.get(s.user_id);
      return {
        userId: s.user_id,
        slot: s.slot,
        username: s.username,
        avatarUrl: s.avatar_url,
        kickUserId: kickUserIdFromAvatar(s.avatar_url),
        roster: rosterByUser.get(s.user_id) ?? null,
        location: this.locations.get(s.user_id) ?? null,
        lastKnown: lk ? { lat: lk.lat, lng: lk.lng, recordedAt: Date.parse(lk.recorded_at) } : null,
        status: this.statuses.get(s.user_id) ?? null,
        death: this.deaths.get(s.user_id) ?? null,
      };
    });
  }

  player(userId: string): Player | undefined {
    return this.players().find((p) => p.userId === userId);
  }

  search(query: string, limit = 20): Player[] {
    return fuzzySearch(this.players(), query, (p) => p.username, limit);
  }

  zombies(): Zombie[] {
    const roster = this.zombieRoster;
    if (!roster || roster.slotsSequence !== this.slotsDefinition) return [];
    const userOf = (slot: number | null) => this.slotUser(slot)?.user_id ?? null;
    return [...this.zombieStates.values()].flatMap((st) => {
      const def = roster.zombies[st.index];
      if (!def) return [];
      return [{
        id: def.id,
        lat: st.lat,
        lng: st.lng,
        ownerUserId: userOf(def.ownerSlot),
        targetUserId: userOf(st.targetSlot),
        guard: def.guard,
        expiresAt: def.expiresAt,
        speedMps: def.speedMps,
        leechRadiusM: def.leechRadiusM,
        leeching: st.leeching.flatMap((l) => {
          const u = userOf(l.slot);
          return u ? [{ userId: u, nextHitAt: l.nextHitAt }] : [];
        }),
      }];
    });
  }

  isStale(p: Player, now = this.now()): boolean {
    return !p.location || now - p.location.recordedAt > this.staleAfterMs;
  }
}
