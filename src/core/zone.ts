/**
 * Safe-zone motion. The server moves the zone by patching its centre every ~1.6s (observed:
 * a steady ~1 m/s drift, no `transition` object), so we estimate velocity by least squares
 * over recent samples and extrapolate. An explicit `transition` always takes precedence.
 */
import { edgeMarginM, fromLocalM, toLocalM, zoneAt, type LatLng } from "./geo.js";
import type { CircleGeometry, SafeZoneObject } from "./messages.js";

export interface ZoneMotion {
  /** Metres per second, east / north components. */
  vEast: number;
  vNorth: number;
  speedMps: number;
  /** Direction of travel, degrees clockwise from north. */
  headingDeg: number;
  /** Radius change in m/s (negative = shrinking). */
  radiusRateMps: number;
  /** Seconds of history the estimate is based on. */
  spanS: number;
}

interface Sample {
  t: number;
  lat: number;
  lng: number;
  r: number;
}

const WINDOW_MS = 5 * 60_000;
const MIN_SPAN_MS = 15_000;
const MIN_SAMPLES = 4;
/** A centre jump this large between samples means the zone was repositioned, not moving. */
const TELEPORT_MPS = 50;
/** Below this the zone is treated as stationary. */
export const STATIONARY_MPS = 0.05;

export class ZoneTracker {
  private samples: Sample[] = [];

  observe(t: number, c: CircleGeometry): void {
    const last = this.samples.at(-1);
    if (last && last.lat === c.lat && last.lng === c.lng && last.r === c.radius && t - last.t < 30_000) return;
    if (last) {
      const { e, n } = toLocalM(last, c);
      const dt = Math.max(1, (t - last.t) / 1000);
      if (Math.hypot(e, n) / dt > TELEPORT_MPS || Math.abs(c.radius - last.r) / dt > TELEPORT_MPS) this.samples = [];
    }
    this.samples.push({ t, lat: c.lat, lng: c.lng, r: c.radius });
    const cutoff = t - WINDOW_MS;
    while (this.samples.length && this.samples[0]!.t < cutoff) this.samples.shift();
  }

  reset(): void {
    this.samples = [];
  }

  motion(): ZoneMotion | null {
    const s = this.samples;
    if (s.length < MIN_SAMPLES) return null;
    const t0 = s[0]!.t;
    const span = s.at(-1)!.t - t0;
    if (span < MIN_SPAN_MS) return null;
    // Least-squares slopes of east, north and radius against time.
    let st = 0, se = 0, sn = 0, sr = 0, stt = 0, ste = 0, stn = 0, str = 0;
    for (const x of s) {
      const t = (x.t - t0) / 1000;
      const { e, n } = toLocalM(s[0]!, x);
      st += t; se += e; sn += n; sr += x.r;
      stt += t * t; ste += t * e; stn += t * n; str += t * x.r;
    }
    const k = s.length;
    const den = k * stt - st * st;
    if (den <= 0) return null;
    const vEast = (k * ste - st * se) / den;
    const vNorth = (k * stn - st * sn) / den;
    const radiusRateMps = (k * str - st * sr) / den;
    const speedMps = Math.hypot(vEast, vNorth);
    return {
      vEast,
      vNorth,
      speedMps,
      headingDeg: ((Math.atan2(vEast, vNorth) * 180) / Math.PI + 360) % 360,
      radiusRateMps,
      spanS: span / 1000,
    };
  }
}

/** Zone geometry `dtMs` after `now`: the scheduled transition if any, else linear extrapolation. */
export function predictZone(zone: SafeZoneObject, motion: ZoneMotion | null, now: number, dtMs: number): CircleGeometry {
  const t = zone.transition;
  if (t && Date.parse(t.ends_at) > now && !t.paused_at) return zoneAt(zone, now + dtMs);
  const c = zoneAt(zone, now);
  if (!motion || (motion.speedMps < STATIONARY_MPS && Math.abs(motion.radiusRateMps) < STATIONARY_MPS)) return c;
  const s = dtMs / 1000;
  return { ...fromLocalM(c, motion.vEast * s, motion.vNorth * s), radius: Math.max(0, c.radius + motion.radiusRateMps * s) };
}

export interface EdgeEta {
  /** Milliseconds from now until the zone edge crosses the (stationary) point. */
  ms: number;
  /** "exits" = the point will end up outside, "enters" = the zone will reach it. */
  kind: "exits" | "enters";
}

const HORIZON_MS = 2 * 3_600_000;

/**
 * When will the zone edge pass over a stationary point? Solved analytically for linear motion
 * (|d0 - v·t| = R0 + r·t), numerically for scheduled transitions. Null if not within 2h.
 */
export function edgeEta(point: LatLng, zone: SafeZoneObject, motion: ZoneMotion | null, now: number): EdgeEta | null {
  const c0 = zoneAt(zone, now);
  const inside = edgeMarginM(point, c0) >= 0;
  const kind = inside ? "exits" : "enters";
  const t = zone.transition;
  if (t && Date.parse(t.ends_at) > now && !t.paused_at) {
    // Numeric: coarse scan then bisection.
    const outsideAt = (ms: number) => edgeMarginM(point, predictZone(zone, motion, now, ms)) < 0;
    let prev = 0;
    for (let ms = 10_000; ms <= HORIZON_MS; ms += 10_000) {
      if (outsideAt(ms) === inside) {
        let lo = prev, hi = ms;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (outsideAt(mid) === inside) hi = mid;
          else lo = mid;
        }
        return { ms: hi, kind };
      }
      prev = ms;
    }
    return null;
  }
  if (!motion) return null;
  const { e, n } = toLocalM(c0, point);
  const { vEast: ve, vNorth: vn, radiusRateMps: r } = motion;
  const R0 = c0.radius;
  // (|v|² - r²) t² - 2 (d0·v + R0 r) t + (|d0|² - R0²) = 0
  const a = ve * ve + vn * vn - r * r;
  const b = -2 * (e * ve + n * vn + R0 * r);
  const c = e * e + n * n - R0 * R0;
  let roots: number[];
  if (Math.abs(a) < 1e-12) roots = Math.abs(b) < 1e-12 ? [] : [-c / b];
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    roots = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
  }
  const tS = roots.filter((x) => x > 0 && R0 + r * x > 0).sort((x, y) => x - y)[0];
  if (tS === undefined || tS * 1000 > HORIZON_MS) return null;
  return { ms: tS * 1000, kind };
}
