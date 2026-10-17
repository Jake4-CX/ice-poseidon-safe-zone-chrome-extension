import type { CircleGeometry, SafeZoneObject } from "./messages.js";

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees (0 = north). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Point reached travelling `distM` metres from `p` on initial bearing `bearing` (degrees). */
export function destination(p: LatLng, bearing: number, distM: number): LatLng {
  const d = distM / EARTH_RADIUS_M;
  const b = toRad(bearing);
  const lat1 = toRad(p.lat);
  const lng1 = toRad(p.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: (lat2 * 180) / Math.PI, lng: ((((lng2 * 180) / Math.PI + 540) % 360) - 180) };
}

/** Closed GeoJSON ring ([lng, lat] pairs) approximating a circle on the ground. */
export function circlePolygon(c: LatLng, radiusM: number, steps = 96): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const p = destination(c, (i / steps) * 360, radiusM);
    ring.push([p.lng, p.lat]);
  }
  return ring;
}

/** Local east/north metres of `p` relative to `origin` (equirectangular; fine at city scale). */
export function toLocalM(origin: LatLng, p: LatLng): { e: number; n: number } {
  return {
    e: toRad(p.lng - origin.lng) * EARTH_RADIUS_M * Math.cos(toRad(origin.lat)),
    n: toRad(p.lat - origin.lat) * EARTH_RADIUS_M,
  };
}

export function fromLocalM(origin: LatLng, e: number, n: number): LatLng {
  return {
    lat: origin.lat + ((n / EARTH_RADIUS_M) * 180) / Math.PI,
    lng: origin.lng + ((e / (EARTH_RADIUS_M * Math.cos(toRad(origin.lat)))) * 180) / Math.PI,
  };
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export const COMPASS_ARROWS: Record<(typeof COMPASS)[number], string> = { N: "↑", NE: "↗", E: "→", SE: "↘", S: "↓", SW: "↙", W: "←", NW: "↖" };
export const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8]!;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Zone geometry at time `now`, interpolated linearly through any active transition (matches the site). */
export function zoneAt(zone: SafeZoneObject, now = Date.now()): CircleGeometry {
  const t = zone.transition;
  if (!t) return { lat: zone.lat, lng: zone.lng, radius: zone.radius };
  const startedAt = Date.parse(t.started_at);
  const endsAt = Date.parse(t.ends_at);
  const clock = t.paused_at ? Math.min(now, Date.parse(t.paused_at)) : now;
  const p = endsAt > startedAt ? clamp01((clock - startedAt) / (endsAt - startedAt)) : 1;
  return {
    lat: t.from.lat + (t.to.lat - t.from.lat) * p,
    lng: t.from.lng + (t.to.lng - t.from.lng) * p,
    radius: t.from.radius + (t.to.radius - t.from.radius) * p,
  };
}

/** Final geometry the zone is heading to (equals the current zone when not moving). */
export function zoneTarget(zone: SafeZoneObject): CircleGeometry {
  return zone.transition ? { ...zone.transition.to } : { lat: zone.lat, lng: zone.lng, radius: zone.radius };
}

/** Metres from the zone edge: positive = inside by that margin, negative = outside. */
export function edgeMarginM(point: LatLng, circle: CircleGeometry): number {
  return circle.radius - distanceM(point, circle);
}

export function formatDistance(m: number): string {
  const a = Math.abs(m);
  return a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)} km` : `${Math.round(a)} m`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
