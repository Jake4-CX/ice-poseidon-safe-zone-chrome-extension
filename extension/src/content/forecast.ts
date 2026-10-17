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

/**
 * Where the zone will be in `minutes`: a dashed future circle, a path from the current centre
 * with a chevron at the tip, and a label. Null when the zone isn't moving.
 */
export function buildForecast(zone: SafeZoneObject, motion: ZoneMotion | null, now: number, minutes: number): ZoneForecast | null {
  const scheduled = isScheduled(zone, now);
  const moving = !!motion && (motion.speedMps >= STATIONARY_MPS || Math.abs(motion.radiusRateMps) >= STATIONARY_MPS);
  if (!scheduled && !moving) return null;
  const horizonMs = scheduled ? Math.min(minutes * 60_000, Date.parse(zone.transition!.ends_at) - now) : minutes * 60_000;
  const cur = zoneAt(zone, now);
  const fut = predictZone(zone, motion, now, horizonMs);
  const len = distanceM(cur, fut);
  const heading = len > 1 ? bearingDeg(cur, fut) : (motion?.headingDeg ?? 0);

  const features: object[] = [
    { type: "Feature", properties: { kind: "future" }, geometry: { type: "Polygon", coordinates: [circlePolygon(fut, fut.radius)] } },
  ];
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
  const speedText = scheduled ? null : zoneMotionText(motion);
  if (speedText) parts.push(speedText);
  else if (len > 5) parts.push(`${COMPASS_ARROWS[compass(heading)]} ${Math.round(len)} m`);
  if (Math.abs(fut.radius - cur.radius) >= 1) parts.push(`r ${Math.round(cur.radius)}→${Math.round(fut.radius)} m`);
  parts.push(`in ${mins} min`);
  const labelAt = len > 5 ? destination(fut, heading, size + 25) : fut;
  return {
    geojson: { type: "FeatureCollection", features },
    label: { lat: labelAt.lat, lng: labelAt.lng, text: parts.join(" · ") },
  };
}
