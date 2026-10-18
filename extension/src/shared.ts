import type { AlertKind, KickChannelInfo } from "../../src/core/index.js";

// ------------------------------------------------------------- content <-> page bridge
// The content script (isolated world) talks to bridge.ts (page/MAIN world, where the
// site's MapLibre instance lives) with CustomEvents carrying JSON strings.

export const TO_PAGE = "szp:to-page";
export const TO_CONTENT = "szp:to-content";

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  /** "fav" = starred player, "focus" = currently selected/followed player. */
  style: "fav" | "focus" | "fav-focus";
  dead?: boolean;
}

/**
 * A player drawn by SafeZone+ itself while the site hides its own sprites (blackout with
 * "show players during blackouts" on). `live` = position still updating; otherwise frozen.
 */
export interface GhostMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  avatar: string | null;
  live: boolean;
  /** "4m" for frozen positions. */
  age: string | null;
  dead: boolean;
}

export interface PlayerPoint {
  id: string;
  lat: number;
  lng: number;
}

export type ToPage =
  | { type: "flyTo"; lat: number; lng: number; zoom?: number }
  | { type: "follow"; id: string; lat: number; lng: number }
  | { type: "unfollow" }
  | { type: "markers"; markers: MapMarker[] }
  /** All visible player positions, used to hit-test clicks on the map. */
  | { type: "players"; players: PlayerPoint[] }
  /** Players whose on-screen position should be reported (action bar, pinned stream). */
  | { type: "anchors"; ids: string[] }
  /** Players to draw ourselves where the site isn't drawing a sprite; [] turns this off. */
  | { type: "ghosts"; ghosts: GhostMarker[] }
  /** Zone forecast drawn as native map layers; null clears it. */
  | { type: "zoneForecast"; forecast: ZoneForecast | null }
  | { type: "ping" };

export interface ZoneForecast {
  /** GeoJSON FeatureCollection; features carry `kind: "future" | "outline" | "path"`. */
  geojson: { type: "FeatureCollection"; features: object[] };
  label: { lat: number; lng: number; text: string };
}

export type ToContent =
  /** `native` = the site's own sprite renderer was found (rings sit exactly on the sprites). */
  | { type: "mapStatus"; found: boolean; native: boolean }
  | { type: "followStopped"; reason: "user" | "map-lost" }
  /** A click on the map hit a player (id) or empty map (null). */
  | { type: "playerClicked"; id: string | null }
  /** Viewport point just below a player's sprite (incl. name label). */
  | { type: "anchor"; id: string; x: number; y: number; visible: boolean };

// ------------------------------------------------------------- content <-> background

export type ToBackground =
  | { type: "kick"; slug: string; expectedUserId: number | null }
  | { type: "notify"; id: string; title: string; message: string }
  | { type: "openMap" }
  /** Compare this build with version.json on GitHub (cached for a few hours unless forced). */
  | { type: "checkUpdate"; force?: boolean };

/** version.json at the root of the GitHub repo. */
export interface ReleaseInfo {
  version: string;
  /** ISO date. */
  released?: string;
  /** One-line summary shown in the update notice. */
  notes?: string;
  /** Where to download the new zip. */
  download?: string;
}

export interface UpdateStatus {
  current: string;
  latest: ReleaseInfo | null;
  /** latest.version > current */
  available: boolean;
  checkedAt: number;
  error?: string;
}

export type KickResponse = { ok: true; channel: KickChannelInfo | null } | { ok: false; error: string };

// ------------------------------------------------------------- settings & storage

export type NotifyMode = "off" | "hidden" | "always";

export interface Settings {
  notify: NotifyMode;
  alertKinds: Record<AlertKind, boolean>;
  mapLabels: boolean;
  /** Show alert toasts in the map's top-left corner (instead of inside the panel). */
  mapAlerts: boolean;
  /** Draw where the zone is heading. */
  zoneForecast: boolean;
  /** How far ahead the forecast circle is drawn. */
  forecastMinutes: number;
  /** Zoom used when jumping to a player. */
  locateZoom: number;
  /**
   * Keep showing players while an EMP/smoke blackout hides them on the site. The EMP is meant
   * to blind contestants, not viewers (confirmed by the event developer).
   */
  showDuringBlackout: boolean;
  /** Show inventory, sigil and activity from the site's contestant card in player details. */
  contestantInfo: boolean;
  /** Tuck the site's header (logo, tabs, account) away; it slides back in on demand. */
  hideHeader: boolean;
}

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  eliminated: "Eliminated",
  hp_drop: "Big damage / low HP",
  healed: "Healed",
  left_zone: "Left the safe zone",
  entered_zone: "Back in the safe zone",
  poisoned: "Poisoned",
  drone: "Drone inbound",
  zombie_target: "Chased by zombies",
  projectile: "Missile / nuke incoming",
  went_dark: "Location went stale",
  back_online: "Location updating again",
  mock_gps: "Mock GPS detected",
};

export const DEFAULT_SETTINGS: Settings = {
  notify: "hidden",
  alertKinds: {
    eliminated: true,
    hp_drop: true,
    healed: false,
    left_zone: true,
    entered_zone: false,
    poisoned: true,
    drone: true,
    zombie_target: true,
    projectile: true,
    went_dark: false,
    back_online: false,
    mock_gps: true,
  },
  mapLabels: true,
  mapAlerts: true,
  zoneForecast: true,
  forecastMinutes: 10,
  locateZoom: 17,
  showDuringBlackout: false,
  contestantInfo: true,
  hideHeader: false,
};

export interface Favourite {
  username: string;
  addedAt: number;
}
export type Favourites = Record<string, Favourite>;
