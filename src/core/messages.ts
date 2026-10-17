/**
 * JSON (text) messages on the public map socket and the /event/map-snapshot endpoint.
 * Field names match the wire format exactly. Types are intentionally permissive
 * (extra fields are tolerated) because the server evolves during the event.
 */

export type IsoDate = string;

export interface Blackout {
  until: IsoDate;
  source: "emp" | "smoke";
}

export interface MapSettings {
  enabled: boolean;
  /** When true the site hides contestant identities. */
  anonymous: boolean;
  location_stale_after_ms: number;
  damage: { active: boolean; paused: boolean; grace_distance_meters: number };
  /** An EMP/smoke blackout hides the public map until `until`. */
  blackout: Blackout | null;
}

export interface Minigame {
  id: string;
  title: string;
  instructions: string;
  reward_text: string;
  status: "running" | "paused" | "completed" | "cancelled";
  started_at: number;
  ends_at: number;
  score_label: string;
  message: string;
  areas: unknown[];
  standings: unknown[];
}

export interface GameSettings {
  minigames?: Minigame[];
  clock: "not_started" | "paused" | "running";
  clock_since: IsoDate;
  chest_items: { type: string; [k: string]: unknown }[];
  zombie_speed_mps: number;
  zombie_leech_distance_m: number;
}

export interface EventMessage {
  type: "event";
  data: { upstream: "live" | "down"; map: MapSettings | null; game: GameSettings | null };
}

/** Maps the numeric slot used by binary frames to a user. Usernames are Kick usernames. */
export interface Slot {
  slot: number;
  user_id: string;
  username: string;
  /** e.g. https://data.cx-live.com/v1/kick/avatars?id=<kick user id>&size=64 */
  avatar_url: string | null;
  shielded?: boolean;
  self?: boolean;
}

/** Curated contestant list. Often empty on the public socket; richer when populated. */
export interface RosterContestant {
  id: string;
  name: string;
  avatar_url: string | null;
  eliminated_at: IsoDate | null;
  sigil: string | null;
  inventory: unknown[] | null;
  kick_slug: string | null;
  live: boolean;
  /** Links to Slot.user_id. */
  map_user_id: string | null;
}

export interface ContestantsMessage {
  type: "contestants";
  data: {
    roster: { stale: boolean; stats_visible: boolean; contestants: RosterContestant[] } | null;
    slots: { definition_sequence: number; slots: Slot[] } | null;
  };
}

export interface CircleGeometry {
  lat: number;
  lng: number;
  radius: number;
}

export interface MapObjectBase {
  id: string;
  lat: number;
  lng: number;
  title?: string;
  description?: string;
}
export interface SafeZoneObject extends MapObjectBase {
  type: "safe_zone" | "circle";
  radius: number;
  /** Present while the zone is moving/shrinking. */
  transition?: { from: CircleGeometry; to: CircleGeometry; started_at: IsoDate; ends_at: IsoDate; paused_at: IsoDate | null } | null;
  strokeColor?: string;
  fillColor?: string;
}
export interface TextObject extends MapObjectBase {
  type: "text";
  text: string;
}
export interface ImageObject extends MapObjectBase {
  type: "image";
  url: string;
  width: number;
  height: number;
}
export interface ClaimableObject extends MapObjectBase {
  type: "claimable";
  url: string;
  claimed: boolean;
  claimed_at?: IsoDate | null;
  claimed_by_username?: string | null;
  claimable_at?: IsoDate | null;
  claimable_until?: IsoDate | null;
  claim_radius_meters: number;
  is_secret: boolean;
  rarity?: string | null;
}
export type MapObject = SafeZoneObject | TextObject | ImageObject | ClaimableObject;

export interface MapObjectsMessage {
  type: "map_objects";
  data: MapObject[];
}
export interface MapObjectsPatchMessage {
  type: "map_objects_patch";
  data: { upsert: MapObject[]; remove: string[] };
}

export type GameItemKind =
  | "dropped_item" | "gravestone" | "c4" | "claymore" | "bubble" | "tear_gas" | "zombie"
  | "fake_chest" | "fake_gravestone" | "unsafe_zone" | "crate" | "reality_shield"
  | "care_package_drop" | (string & {});

export interface GameItem {
  id: string;
  kind: GameItemKind;
  lat: number;
  lng: number;
  radius_m: number | null;
  expires_at: IsoDate | null;
  mine: boolean;
  contents: unknown[] | null;
  blood_tokens?: unknown;
  rarity: string | null;
  grave: { username?: string; [k: string]: unknown } | null;
  guard: boolean;
  damage?: number;
  damage_interval_seconds?: number;
}

/** Last known position of contestants who are hidden (e.g. invisibility cloak). */
export interface LastKnown {
  user_id: string;
  lat: number;
  lng: number;
  recorded_at: IsoDate;
}

export interface GameItemsMessage {
  type: "game_items";
  data: { items: GameItem[]; last_known: LastKnown[] };
}
export interface GameItemsPatchMessage {
  type: "game_items_patch";
  data: { upsert: GameItem[]; remove: string[]; last_known?: LastKnown[] };
}

export interface Explosion {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  radius_m: number;
  at: IsoDate;
}
export interface ExplosionsMessage {
  type: "explosions";
  data: Explosion[];
}

export interface HeartbeatMessage {
  type: "heartbeat";
  server_time?: IsoDate;
}

export type TextMessage =
  | EventMessage
  | ContestantsMessage
  | MapObjectsMessage
  | MapObjectsPatchMessage
  | GameItemsMessage
  | GameItemsPatchMessage
  | ExplosionsMessage
  | HeartbeatMessage;

export function parseTextMessage(text: string): TextMessage | null {
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg === "object" && typeof msg.type === "string" ? (msg as TextMessage) : null;
  } catch {
    return null;
  }
}

/** Shape of GET https://event-public.iceposeidon.com/event/map-snapshot */
export interface MapSnapshotResponse {
  frames: ({ text: string } | { binary: string })[];
}

/** Apply an upsert/remove patch to an id-keyed list, preserving order (same as the site). */
export function applyPatch<T extends { id: string }>(list: T[], patch: { upsert: T[]; remove: string[] }): T[] {
  const removed = new Set(patch.remove);
  const upserts = new Map(patch.upsert.map((x) => [x.id, x]));
  const out = list.flatMap((x) => (removed.has(x.id) ? [] : [upserts.get(x.id) ?? x]));
  const present = new Set(out.map((x) => x.id));
  for (const x of patch.upsert) if (!present.has(x.id)) out.push(x);
  return out;
}
