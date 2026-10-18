import {
  COMPASS_ARROWS,
  STATIONARY_MPS,
  bearingDeg,
  circlePolygon,
  compass,
  destination,
  distanceM,
  predictZone,
  zoneAt,
  type CircleGeometry,
  type MovingZone,
  type SafeZoneObject,
  type ZoneMotion,
} from "../../../src/core/index.js";
import type { ZoneForecast } from "../shared.js";

const kmh = (mps: number) => (mps * 3.6).toFixed(mps * 3.6 < 10 ? 1 : 0);

/** "↖ NW 3.6 km/h", or null while the zone is stationary / not yet estimated. */
export function zoneMotionText(motion: ZoneMotion | null): string | null {
  if (!motion || motion.speedMps < STATIONARY_MPS) return null;
  const dir = compass(motion.headingDeg);
  return `${COMPASS_ARROWS[dir]} ${dir} ${kmh(motion.speedMps)} km/h`;
}

const isScheduled = (zone: SafeZoneObject, now: number) =>
  !!zone.transition && Date.parse(zone.transition.ends_at) > now && !zone.transition.paused_at;

const isMoving = (m: ZoneMotion | null) => !!m && (m.speedMps >= STATIONARY_MPS || Math.abs(m.radiusRateMps) >= STATIONARY_MPS);

/** Area-weighted centre of a set of circles (the union's rough middle). */
function centreOf(circles: CircleGeometry[]): { lat: number; lng: number } {
  let w = 0, lat = 0, lng = 0;
  for (const c of circles) {
    const a = c.radius * c.radius;
    w += a;
    lat += c.lat * a;
    lng += c.lng * a;
  }
  return w ? { lat: lat / w, lng: lng / w } : { lat: circles[0]!.lat, lng: circles[0]!.lng };
}

/**
 * The outer boundary of a union of circles as line segments: each circle's outline with the
 * parts that fall inside another circle cut away, so overlapping zones read as one shape.
 */
export function unionOutline(circles: CircleGeometry[]): [number, number][][] {
  const lines: [number, number][][] = [];
  circles.forEach((c, i) => {
    const others = circles.filter((_, j) => j !== i);
    const ring = circlePolygon(c, c.radius, 180);
    const outside = ring.map(([lng, lat]) => others.every((o) => distanceM({ lat, lng }, o) >= o.radius));
    // Start the walk at an inside point so a run never wraps around the seam.
    const startAt = outside.indexOf(false);
    if (startAt === -1) {
      lines.push(ring);
      return;
    }
    let run: [number, number][] = [];
    for (let k = 1; k <= ring.length; k++) {
      const idx = (startAt + k) % (ring.length - 1); // ring is closed: last point == first
      if (outside[idx]) run.push(ring[idx]!);
      else if (run.length) {
        if (run.length > 1) lines.push(run);
        run = [];
      }
    }
    if (run.length > 1) lines.push(run);
  });
  return lines;
}

/**
 * Where the safe area will be in `minutes`: a dashed outline of the future zones (merged into
 * one shape when they overlap), a path from the current centre with a chevron at the tip, and
 * a label. Null when no zone is moving.
 */
export function buildForecast(zones: MovingZone[], now: number, minutes: number): ZoneForecast | null {
  const active = zones.filter(({ zone, motion }) => isScheduled(zone, now) || isMoving(motion));
  if (!active.length) return null;
  const horizonFor = ({ zone }: MovingZone) =>
    isScheduled(zone, now) ? Math.min(minutes * 60_000, Date.parse(zone.transition!.ends_at) - now) : minutes * 60_000;
  const horizonMs = Math.max(...active.map(horizonFor));
  const curs = zones.map(({ zone }) => zoneAt(zone, now));
  const futs = zones.map((z) => predictZone(z.zone, z.motion, now, Math.min(horizonMs, horizonFor(z))));
  const cur = centreOf(curs);
  const fut = centreOf(futs);
  const len = distanceM(cur, fut);
  const main = active.reduce((a, b) => (zoneAt(b.zone, now).radius > zoneAt(a.zone, now).radius ? b : a));
  const heading = len > 1 ? bearingDeg(cur, fut) : (main.motion?.headingDeg ?? 0);

  const features: object[] = futs.map((c) => ({
    type: "Feature",
    properties: { kind: "future" },
    geometry: { type: "Polygon", coordinates: [circlePolygon(c, c.radius)] },
  }));
  features.push({
    type: "Feature",
    properties: { kind: "outline" },
    geometry: { type: "MultiLineString", coordinates: unionOutline(futs) },
  });
  const size = Math.min(120, Math.max(20, len * 0.15));
  if (len > 5) {
    const wingL = destination(fut, heading + 180 - 30, size);
    const wingR = destination(fut, heading + 180 + 30, size);
    features.push(
      { type: "Feature", properties: { kind: "path" }, geometry: { type: "LineString", coordinates: [[cur.lng, cur.lat], [fut.lng, fut.lat]] } },
      { type: "Feature", properties: { kind: "path" }, geometry: { type: "LineString", coordinates: [[wingL.lng, wingL.lat], [fut.lng, fut.lat], [wingR.lng, wingR.lat]] } },
    );
  }

  const mins = Math.round(horizonMs / 60_000);
  const parts: string[] = [];
  const speedText = isScheduled(main.zone, now) ? null : zoneMotionText(main.motion);
  if (speedText) parts.push(speedText);
  else if (len > 5) parts.push(`${COMPASS_ARROWS[compass(heading)]} ${Math.round(len)} m`);
  if (zones.length === 1 && Math.abs(futs[0]!.radius - curs[0]!.radius) >= 1) parts.push(`r ${Math.round(curs[0]!.radius)}→${Math.round(futs[0]!.radius)} m`);
  parts.push(`in ${mins} min`);
  const labelAt = len > 5 ? destination(fut, heading, size + 25) : fut;
  return {
    geojson: { type: "FeatureCollection", features },
    label: { lat: labelAt.lat, lng: labelAt.lng, text: parts.join(" · ") },
  };
}
