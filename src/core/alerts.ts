import { distanceM, formatDistance } from "./geo.js";
import type { Player, SafeZoneState } from "./state.js";

export type AlertKind =
  | "eliminated" | "hp_drop" | "healed" | "left_zone" | "entered_zone" | "poisoned" | "drone"
  | "zombie_target" | "projectile" | "went_dark" | "back_online" | "mock_gps";

export interface Alert {
  kind: AlertKind;
  userId: string;
  username: string;
  message: string;
  severity: "info" | "warn" | "danger";
  at: number;
}

interface Memory {
  alive: boolean | null;
  hp: number | null;
  outside: boolean | null;
  poisoned: boolean;
  drone: boolean;
  stale: boolean;
  mock: boolean;
  chasedBy: Set<string>;
  projectiles: Set<string>;
}

/** A single update losing/gaining at least this much HP is always reported. */
const BIG_HIT_HP = 5;
/** Fraction-of-max-HP lines reported when crossed downward (lowest first, so the most severe wins). */
const HP_THRESHOLDS = [0.1, 0.25, 0.5];

/** Alerts that flap (zombies re-targeting, GPS jitter at the zone edge) are rate limited per player. */
const COOLDOWN_MS: Partial<Record<AlertKind, number>> = {
  zombie_target: 5 * 60_000,
  left_zone: 2 * 60_000,
  entered_zone: 2 * 60_000,
  went_dark: 5 * 60_000,
  back_online: 5 * 60_000,
};

const PROJECTILE_LABEL: Record<string, string> = { missile: "Missile", nuke: "Nuke", gods_fruit: "God's fruit" };

/**
 * Turns state transitions of watched players into alerts. The first observation of a
 * player only establishes a baseline, so connecting never floods you with alerts.
 */
export class AlertEngine {
  private memory = new Map<string, Memory>();
  private lastFired = new Map<string, number>();

  forget(userId: string): void {
    this.memory.delete(userId);
  }

  evaluate(state: SafeZoneState, watched: ReadonlySet<string>): Alert[] {
    const now = state.now();
    const alerts: Alert[] = [];
    const players = state.players().filter((p) => watched.has(p.userId));
    const zombies = state.zombies();
    for (const p of players) {
      const prev = this.memory.get(p.userId);
      const cur = this.snapshot(p, state, zombies, now);
      this.memory.set(p.userId, cur);
      if (!prev) continue;
      const push = (kind: AlertKind, severity: Alert["severity"], message: string) => {
        const cooldown = COOLDOWN_MS[kind];
        const key = `${p.userId}:${kind}`;
        if (cooldown && now - (this.lastFired.get(key) ?? -Infinity) < cooldown) return;
        this.lastFired.set(key, now);
        alerts.push({ kind, severity, message, userId: p.userId, username: p.username, at: now });
      };

      if (prev.alive === true && cur.alive === false) push("eliminated", "danger", `${p.username} was eliminated`);
      if (prev.hp !== null && cur.hp !== null && cur.alive !== false) {
        // Zombies leech 1 HP every few seconds, so only report big hits and threshold crossings.
        const max = p.status?.maxHp ?? 100;
        const crossed = HP_THRESHOLDS.find((t) => prev.hp! > max * t && cur.hp! <= max * t);
        if (prev.hp - cur.hp >= BIG_HIT_HP) {
          push("hp_drop", cur.hp <= max * 0.25 ? "danger" : "warn", `${p.username} took ${prev.hp - cur.hp} damage (${cur.hp}/${max} HP)`);
        } else if (crossed !== undefined) {
          push("hp_drop", crossed <= 0.25 ? "danger" : "warn", `${p.username} dropped below ${Math.round(crossed * 100)}% HP (${cur.hp}/${max})`);
        } else if (cur.hp - prev.hp >= BIG_HIT_HP) {
          push("healed", "info", `${p.username} healed +${cur.hp - prev.hp} (${cur.hp}/${max} HP)`);
        }
      }
      if (prev.outside === false && cur.outside === true) push("left_zone", "warn", `${p.username} left the safe zone`);
      if (prev.outside === true && cur.outside === false) push("entered_zone", "info", `${p.username} is back inside the safe zone`);
      if (!prev.poisoned && cur.poisoned) push("poisoned", "warn", `${p.username} was poisoned`);
      if (!prev.drone && cur.drone) push("drone", "warn", `A drone is inbound on ${p.username}`);
      if (!prev.stale && cur.stale) push("went_dark", "info", `${p.username}'s location went stale`);
      if (prev.stale && !cur.stale) push("back_online", "info", `${p.username}'s location is updating again`);
      if (!prev.mock && cur.mock) push("mock_gps", "warn", `${p.username} is reporting a mock GPS location`);
      if (prev.chasedBy.size === 0 && cur.chasedBy.size > 0) {
        push("zombie_target", "warn", `${cur.chasedBy.size === 1 ? "A zombie is" : `${cur.chasedBy.size} zombies are`} chasing ${p.username}`);
      }
      for (const id of cur.projectiles) {
        if (prev.projectiles.has(id)) continue;
        const pr = state.projectiles.find((x) => x.id === id);
        if (!pr) continue;
        const secs = Math.max(0, Math.round((pr.landsAt - now) / 1000));
        const by = pr.launchedBy ? ` from ${pr.launchedBy}` : "";
        push("projectile", "danger", `${PROJECTILE_LABEL[pr.kind] ?? pr.kind}${by} targeting near ${p.username} — lands in ${secs}s`);
      }
    }
    return alerts;
  }

  private snapshot(p: Player, state: SafeZoneState, zombies: ReturnType<SafeZoneState["zombies"]>, now: number): Memory {
    const s = p.status;
    const pos = p.location;
    const projectiles = new Set<string>();
    if (pos) {
      for (const pr of state.projectiles) {
        if (pr.kind === "gods_fruit") continue; // heals, not a threat
        if (distanceM(pos, { lat: pr.targetLat, lng: pr.targetLng }) <= pr.targetRadiusM + 50) projectiles.add(pr.id);
      }
    }
    return {
      alive: s ? s.alive && s.status !== "eliminated" : null,
      hp: s?.hp ?? null,
      outside: s ? s.status === "outside" || s.outsideSince !== null : null,
      poisoned: !!s?.poison && s.poison.endsAt > now,
      drone: !!s?.droneLandsAt && s.droneLandsAt > now,
      stale: state.isStale(p, now),
      mock: !!pos?.mock,
      chasedBy: new Set(zombies.filter((z) => z.targetUserId === p.userId).map((z) => z.id)),
      projectiles,
    };
  }
}

/** Human-readable proximity summary, e.g. for "what's near this player". */
export function describeNearby(state: SafeZoneState, p: Player, radiusM = 150): string[] {
  const pos = p.location;
  if (!pos) return [];
  const out: string[] = [];
  for (const z of state.zombies()) {
    const d = distanceM(pos, z);
    if (d <= radiusM) out.push(`zombie ${formatDistance(d)} away${z.targetUserId === p.userId ? " (chasing)" : ""}`);
  }
  for (const it of state.items) {
    const d = distanceM(pos, it);
    if (d <= radiusM) out.push(`${it.kind.replace(/_/g, " ")} ${formatDistance(d)} away`);
  }
  for (const o of state.mapObjects) {
    if (o.type !== "claimable" || o.claimed) continue;
    const d = distanceM(pos, o);
    if (d <= radiusM) out.push(`${o.rarity ?? ""} chest ${formatDistance(d)} away`.trim());
  }
  return out;
}
