#!/usr/bin/env node
/**
 * SafeZone+ CLI — test harness for the core library against the live event.
 *
 *   npm run cli -- stats
 *   npm run cli -- search <query>
 *   npm run cli -- player <name> [--kick]
 *   npm run cli -- watch <name> [<name> ...]      live alerts for players (or "all")
 *   npm run cli -- capture <out.ndjson> [seconds]  record raw socket frames
 */
import fs from "node:fs";
import {
  AlertEngine,
  SafeZoneClient,
  SafeZoneState,
  bearingDeg,
  compass,
  describeNearby,
  distanceM,
  fetchKickChannel,
  fetchSnapshotFrames,
  formatDistance,
  formatDuration,
  guessKickSlug,
  kickChannelUrl,
  nearestCircle,
  unionMarginM,
  STATIONARY_MPS,
  zoneAt,
  zoneTarget,
  type Player,
} from "../core/index.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

async function loadSnapshot(): Promise<SafeZoneState> {
  const state = new SafeZoneState();
  state.ingestAll(await fetchSnapshotFrames());
  return state;
}

function hpBar(p: Player): string {
  const s = p.status;
  if (!s) return c.dim("no status");
  if (!s.alive || s.status === "eliminated") return c.red("ELIMINATED");
  const frac = s.hp / s.maxHp;
  const filled = Math.round(frac * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const col = frac > 0.5 ? c.green : frac > 0.25 ? c.yellow : c.red;
  return `${col(bar)} ${s.hp}/${s.maxHp}`;
}

function oneLine(state: SafeZoneState, p: Player): string {
  const now = state.now();
  const circles = state.safeZones().map((z) => zoneAt(z, now));
  const parts = [c.bold(p.username.padEnd(22)), hpBar(p)];
  const m = p.location ? unionMarginM(p.location, circles) : null;
  if (m !== null) {
    parts.push(m >= 0 ? c.green(`${formatDistance(m)} inside`) : c.red(`${formatDistance(m)} OUTSIDE`));
  } else parts.push(c.dim("no location"));
  if (p.location) parts.push(c.dim(`updated ${formatDuration(now - p.location.recordedAt)} ago`));
  if (state.isStale(p, now) && p.location) parts.push(c.yellow("stale"));
  return parts.join("  ");
}

function detail(state: SafeZoneState, p: Player): string {
  const now = state.now();
  const lines = [oneLine(state, p)];
  const s = p.status;
  if (s) {
    if (s.badges.length) lines.push(`  badges: ${s.badges.join(", ")}`);
    if (s.poison && s.poison.endsAt > now) lines.push(c.yellow(`  poisoned, ends in ${formatDuration(s.poison.endsAt - now)}`));
    if (s.droneLandsAt && s.droneLandsAt > now) lines.push(c.red(`  drone lands in ${formatDuration(s.droneLandsAt - now)}`));
    if (s.outsideSince) lines.push(c.red(`  outside zone for ${formatDuration(now - s.outsideSince)}`));
    if (s.nextDamageAt && s.nextDamageAt > now) lines.push(c.red(`  next zone damage in ${formatDuration(s.nextDamageAt - now)}`));
  }
  const loc = p.location;
  if (loc) {
    lines.push(`  position: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} ±${loc.accuracyM}m${loc.mock ? c.red(" (MOCK GPS)") : ""}`);
    lines.push(c.dim(`  https://www.google.com/maps?q=${loc.lat},${loc.lng}`));
    const zones = state.safeZones();
    const center = nearestCircle(loc, zones.map((z) => zoneAt(z, now)));
    if (center) {
      lines.push(`  ${zones.length > 1 ? "nearest zone centre" : "zone centre"}: ${formatDistance(distanceM(loc, center))} ${compass(bearingDeg(loc, center))}`);
      if (zones.some((z) => z.transition)) {
        const m = unionMarginM(loc, zones.map(zoneTarget))!;
        lines.push(`  after current shrink: ${m >= 0 ? c.green(formatDistance(m) + " inside") : c.red(formatDistance(m) + " outside")}`);
      }
    }
    const chasers = state.zombies().filter((z) => z.targetUserId === p.userId);
    if (chasers.length) {
      const nearest = Math.min(...chasers.map((z) => distanceM(loc, z)));
      lines.push(c.yellow(`  ${chasers.length} zombie(s) chasing, nearest ${formatDistance(nearest)}`));
    }
    const nearby = describeNearby(state, p);
    if (nearby.length) lines.push(`  nearby: ${nearby.slice(0, 8).join("; ")}`);
  } else if (p.lastKnown) {
    lines.push(c.yellow(`  hidden — last known ${p.lastKnown.lat.toFixed(5)}, ${p.lastKnown.lng.toFixed(5)}`));
  }
  const slug = p.roster?.kick_slug ?? guessKickSlug(p.username);
  lines.push(`  stream: ${kickChannelUrl(slug)}`);
  return lines.join("\n");
}

async function kickLine(p: Player): Promise<string> {
  const slug = p.roster?.kick_slug ?? guessKickSlug(p.username);
  try {
    const ch = await fetchKickChannel(slug, p.kickUserId);
    if (!ch) return c.dim(`  kick: no channel "${slug}"`);
    const v = ch.verified ? c.green("✓ verified") : c.yellow("unverified match");
    return ch.live
      ? `  kick: ${c.red("● LIVE")} ${ch.viewers ?? "?"} viewers — ${ch.title ?? ""} (${v})`
      : `  kick: offline (${v})`;
  } catch (e) {
    return c.dim(`  kick: lookup failed (${(e as Error).message})`);
  }
}

function findOne(state: SafeZoneState, query: string): Player {
  const [p] = state.search(query, 1);
  if (!p) {
    console.error(`No player matching "${query}"`);
    process.exit(1);
  }
  return p;
}

async function cmdStats() {
  const state = await loadSnapshot();
  const players = state.players();
  const alive = players.filter((p) => p.status?.alive && p.status.status !== "eliminated");
  const now = state.now();
  console.log(c.bold("Safe Zone"), `upstream: ${state.event?.upstream ?? "?"}`, `clock: ${state.event?.game?.clock ?? "?"}`, state.blackout ? c.red(`BLACKOUT (${state.blackout.source}) until ${state.blackout.until}`) : "");
  const zones = state.movingZones();
  for (const { zone, motion } of zones) {
    const g = zoneAt(zone, now);
    const drift = motion && motion.speedMps >= STATIONARY_MPS ? c.dim(` drifting ${compass(motion.headingDeg)} ${(motion.speedMps * 3.6).toFixed(1)} km/h`) : "";
    console.log(`zone${zones.length > 1 ? " (one of " + zones.length + ", safe inside any)" : ""}: r=${Math.round(g.radius)}m at ${g.lat.toFixed(5)},${g.lng.toFixed(5)}${zone.transition ? c.yellow(` → shrinking to ${Math.round(zone.transition.to.radius)}m by ${zone.transition.ends_at}`) : ""}${drift}`);
  }
  console.log(`players: ${players.length} registered, ${c.green(String(alive.length))} alive, ${c.red(String(players.length - alive.length))} out, ${players.filter((p) => state.isStale(p, now)).length} without fresh location`);
  console.log(`zombies: ${state.zombies().length}, projectiles in flight: ${state.projectiles.length}, items on map: ${state.items.length}`);
  const outside = alive.filter((p) => p.status?.status === "outside");
  if (outside.length) {
    console.log(c.bold("\nOutside the zone:"));
    for (const p of outside) console.log(" ", oneLine(state, p));
  }
  console.log(c.bold("\nLowest HP:"));
  for (const p of [...alive].sort((a, b) => a.status!.hp / a.status!.maxHp - b.status!.hp / b.status!.maxHp).slice(0, 10)) {
    console.log(" ", oneLine(state, p));
  }
}

async function cmdSearch(query: string) {
  const state = await loadSnapshot();
  const results = state.search(query, 15);
  if (!results.length) console.log(`No players matching "${query}"`);
  for (const p of results) console.log(oneLine(state, p));
}

async function cmdPlayer(query: string, withKick: boolean) {
  const state = await loadSnapshot();
  const p = findOne(state, query);
  console.log(detail(state, p));
  if (withKick) console.log(await kickLine(p));
}

function cmdWatch(names: string[]) {
  const engine = new AlertEngine();
  let watched: Set<string> | null = null;
  const client = new SafeZoneClient({
    onStatus: (s, d) => console.log(c.dim(`[socket] ${s}${d ? ` (${d})` : ""}`)),
  });
  client.state.onChange((changes) => {
    const state = client.state;
    if (!watched && state.slots.size && changes.has("status")) {
      const all = names.length === 1 && names[0] === "all";
      const players = all ? state.players() : names.map((n) => findOne(state, n));
      watched = new Set(players.map((p) => p.userId));
      console.log(c.bold(`Watching ${all ? `all ${watched.size} players` : players.map((p) => p.username).join(", ")}`));
      if (!all) for (const p of players) console.log(detail(state, p));
    }
    if (!watched) return;
    for (const a of engine.evaluate(state, watched)) {
      const col = a.severity === "danger" ? c.red : a.severity === "warn" ? c.yellow : c.cyan;
      console.log(`${c.dim(new Date().toLocaleTimeString())} ${col(a.message)}`);
    }
  });
  client.start();
  process.on("SIGINT", () => {
    client.stop();
    process.exit(0);
  });
}

function cmdCapture(out: string, seconds: number) {
  const stream = fs.createWriteStream(out);
  let n = 0;
  const client = new SafeZoneClient({
    snapshotUrl: null,
    onStatus: (s, d) => console.log(`[socket] ${s}${d ? ` (${d})` : ""}`),
    onRawFrame: (f) => {
      n++;
      const rec = typeof f === "string" ? { t: Date.now(), text: f } : { t: Date.now(), binary: Buffer.from(f).toString("base64") };
      stream.write(JSON.stringify(rec) + "\n");
    },
  });
  client.start();
  setTimeout(() => {
    client.stop();
    stream.end(() => {
      console.log(`captured ${n} frames to ${out}`);
      process.exit(0);
    });
  }, seconds * 1000);
}

const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

switch (cmd) {
  case "stats":
    await cmdStats();
    break;
  case "search":
    await cmdSearch(positional.join(" "));
    break;
  case "player":
    await cmdPlayer(positional.join(" "), flags.has("--kick"));
    break;
  case "watch":
    if (!positional.length) {
      console.error("usage: watch <name> [<name> ...] | watch all");
      process.exit(1);
    }
    cmdWatch(positional);
    break;
  case "capture":
    cmdCapture(positional[0] ?? `captures/capture-${Date.now()}.ndjson`, Number(positional[1] ?? 60));
    break;
  default:
    console.log(`SafeZone+ CLI
  stats                      overview: zone, alive count, outside-zone and low-HP players
  search <query>             fuzzy-search players
  player <name> [--kick]     full detail for one player (+ Kick live status)
  watch <name...> | all      live alerts for players
  capture <file> [seconds]   record raw socket frames to NDJSON`);
}
