import {
  AlertEngine,
  SafeZoneClient,
  bearingDeg,
  compass,
  describeNearby,
  distanceM,
  edgeEta,
  edgeMarginM,
  formatDistance,
  formatDuration,
  guessKickSlug,
  kickChannelUrl,
  zoneAt,
  zoneTarget,
  type Alert,
  type ConnectionStatus,
  type EdgeEta,
  type KickChannelInfo,
  type Player,
  type StateChange,
  type Zombie,
} from "../../../src/core/index.js";
import {
  ALERT_KIND_LABELS,
  TO_CONTENT,
  TO_PAGE,
  type KickResponse,
  type MapMarker,
  type NotifyMode,
  type PlayerPoint,
  type ToBackground,
  type ToContent,
  type ToPage,
} from "../shared.js";
import { buildForecast, zoneMotionText } from "./forecast.js";
import { MapToasts } from "./map-toasts.js";
import { Store, loadUi, saveUi, type UiState } from "./store.js";
import { StreamWindow } from "./stream-window.js";
import { CSS } from "./styles.js";

type Filter = "favourites" | "alive" | "outside" | "lowhp" | "chased" | "eliminated";
type Tab = "players" | "alerts" | "settings";
type Mode = "normal" | "blackout" | "anonymous" | "disabled";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "favourites", label: "★ Favourites" },
  { id: "alive", label: "Alive" },
  { id: "outside", label: "Outside zone" },
  { id: "lowhp", label: "Low HP" },
  { id: "chased", label: "Chased" },
  { id: "eliminated", label: "Eliminated" },
];

const svg = (body: string, fill = "none") =>
  `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const STAR_PATH = '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>';
const ICON = {
  star: svg(STAR_PATH, "currentColor"),
  starOff: svg(STAR_PATH),
  pin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
  follow: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>'),
  tv: svg('<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>'),
  collapse: svg('<polyline points="18 15 12 9 6 15"/>'),
  expand: svg('<polyline points="6 9 12 15 18 9"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  panel: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>'),
  external: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

interface KickEntry {
  at: number;
  channel: KickChannelInfo | null;
  failed?: boolean;
  pending?: boolean;
}

interface RowView {
  p: Player;
  fav: boolean;
  dead: boolean;
  margin: number | null;
  stale: boolean;
  chasers: Zombie[];
  /** When the (moving) zone edge reaches them if they stay put. */
  eta: EdgeEta | null;
}

/** Show the "edge reaches them" tag when it's this close. */
const ETA_TAG_MS = 30 * 60_000;

const KICK_TTL_MS = 2 * 60_000;
const KICK_CONCURRENCY = 3;
const RENDER_INTERVAL_MS = 700;
const MAX_ROWS = 80;

export class App {
  private client = new SafeZoneClient({
    onStatus: (s) => {
      this.conn = s;
      this.scheduleRender();
    },
  });
  private store = new Store();
  private engine = new AlertEngine();
  private ui!: UiState;
  private conn: ConnectionStatus = "idle";
  private tab: Tab = "players";
  private query = "";
  private expanded: string | null = null;
  private focusId: string | null = null;
  private followId: string | null = null;
  private stream!: StreamWindow;
  private alerts: Alert[] = [];
  private unread = 0;
  private kick = new Map<string, KickEntry>();
  private kickQueue: { slug: string; expected: number | null }[] = [];
  private kickActive = 0;
  private mapFound = false;
  /** Bridge reached the site's own sprite renderer. */
  private mapNative = false;
  private lastForecast = "";
  private lastAnchors = "";
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRender = 0;
  private lastFollowSent = "";
  private lastMarkers = "";
  private lastPlayers = "";
  private mapToasts = new MapToasts((id) => this.revealPlayer(id));
  /** Player clicked on the map, shown in the floating action bar. */
  private cardId: string | null = null;
  private cardPos: { x: number; y: number; visible: boolean } | null = null;
  private cardKey = "";
  private rows = new Map<string, { el: HTMLDivElement; key: string }>();
  private disposers: (() => void)[] = [];

  private host!: HTMLDivElement;
  private root!: ShadowRoot;
  private $!: {
    panel: HTMLDivElement;
    conn: HTMLSpanElement;
    hstats: HTMLSpanElement;
    collapse: HTMLButtonElement;
    banner: HTMLDivElement;
    tabs: HTMLDivElement;
    playersView: HTMLDivElement;
    input: HTMLInputElement;
    chips: HTMLDivElement;
    list: HTMLDivElement;
    alertsView: HTMLDivElement;
    settingsView: HTMLDivElement;
    toasts: HTMLDivElement;
    card: HTMLDivElement;
  };

  // ------------------------------------------------------------------ lifecycle

  async mount(): Promise<void> {
    await this.store.load();
    this.ui = await loadUi();
    this.buildDom();
    this.disposers.push(this.store.onChange(() => {
      this.lastMarkers = "";
      this.lastForecast = "";
      this.renderSettings();
      this.syncMap();
      this.renderNow();
    }));
    const onBridge = (e: Event) => this.onBridge(JSON.parse((e as CustomEvent<string>).detail) as ToContent);
    document.addEventListener(TO_CONTENT, onBridge);
    this.disposers.push(() => document.removeEventListener(TO_CONTENT, onBridge));
    const onKey = (e: KeyboardEvent) => this.onGlobalKey(e);
    document.addEventListener("keydown", onKey, true);
    this.disposers.push(() => document.removeEventListener("keydown", onKey, true));
    this.disposers.push(this.client.state.onChange((c) => this.onState(c)));
    // Countdowns ("drone lands in 12s") need ticking even without new data.
    const tick = setInterval(() => this.scheduleRender(), 1000);
    this.disposers.push(() => clearInterval(tick));
    this.client.start();
    this.toPage({ type: "ping" });
    this.renderNow();
  }

  unmount(): void {
    this.client.stop();
    for (const d of this.disposers) d();
    this.disposers = [];
    clearTimeout(this.renderTimer);
    this.toPage({ type: "markers", markers: [] });
    this.toPage({ type: "players", players: [] });
    this.toPage({ type: "anchors", ids: [] });
    this.toPage({ type: "zoneForecast", forecast: null });
    this.toPage({ type: "unfollow" });
    this.mapToasts.destroy();
    this.host?.remove();
  }

  private toPage(msg: ToPage) {
    document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));
  }

  private toBackground<T = unknown>(msg: ToBackground): Promise<T> {
    return chrome.runtime.sendMessage(msg) as Promise<T>;
  }

  // ------------------------------------------------------------------ DOM

  private buildDom() {
    this.host = document.createElement("div");
    this.host.id = "safezone-plus";
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>${CSS}</style>
      <div class="panel" part="panel">
        <header>
          <span class="conn"></span>
          <span class="brand">SafeZone<b>+</b></span>
          <span class="hstats"></span>
          <button class="icon-btn" data-ui="collapse" title="Collapse"></button>
        </header>
        <div class="banner" hidden></div>
        <div class="tabs">
          <button class="tab" data-tab="players">Players</button>
          <button class="tab" data-tab="alerts">Alerts</button>
          <button class="tab" data-tab="settings">Settings</button>
        </div>
        <div class="view" data-view="players" style="display:flex;flex-direction:column;min-height:0;flex:1 1 auto">
          <div class="search"><div class="field"><span class="lens">${ICON.search}</span><input type="search" placeholder="Search players…" spellcheck="false" autocomplete="off" aria-label="Search players"><kbd>/</kbd></div></div>
          <div class="chips" role="tablist"></div>
          <div class="list" role="list"></div>
        </div>
        <div class="view alerts" data-view="alerts" hidden></div>
        <div class="view settings" data-view="settings" hidden></div>
        <div class="toasts"></div>
      </div>
      <div class="card" role="dialog" aria-label="Player actions" hidden></div>`;
    const q = <T extends Element>(sel: string) => this.root.querySelector(sel) as T;
    this.$ = {
      panel: q(".panel"),
      conn: q(".conn"),
      hstats: q(".hstats"),
      collapse: q('[data-ui="collapse"]'),
      banner: q(".banner"),
      tabs: q(".tabs"),
      playersView: q('[data-view="players"]'),
      input: q("input"),
      chips: q(".chips"),
      list: q(".list"),
      alertsView: q('[data-view="alerts"]'),
      settingsView: q('[data-view="settings"]'),
      toasts: q(".toasts"),
      card: q(".card"),
    };
    // Outside <body>: Astro view transitions swap the body element.
    document.documentElement.appendChild(this.host);
    this.stream = new StreamWindow(this.root, this.ui.stream, {
      save: () => saveUi(this.ui),
      onChange: () => this.syncAnchors(),
      avoid: () => this.$.panel.getBoundingClientRect(),
    });
    // Raise whichever of panel / stream window was touched last.
    const raise = (front: HTMLElement, back: HTMLElement) => () => {
      front.classList.add("front");
      back.classList.remove("front");
    };
    this.$.panel.addEventListener("pointerdown", raise(this.$.panel, this.stream.el), true);
    this.stream.el.addEventListener("pointerdown", raise(this.stream.el, this.$.panel), true);
    this.applyPosition();
    this.applyCollapsed();
    this.wireEvents();
    this.renderSettings();
  }

  private wireEvents() {
    const { panel, input, chips, list, tabs, alertsView, settingsView, toasts, card } = this.$;
    card.addEventListener("click", (e) => this.onCardClick(e));
    this.$.collapse.addEventListener("click", () => {
      this.ui.collapsed = !this.ui.collapsed;
      saveUi(this.ui);
      this.applyCollapsed();
    });
    tabs.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (t) this.setTab(t.dataset.tab as Tab);
    });
    input.addEventListener("input", () => {
      this.query = input.value;
      this.renderNow();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.value = this.query = "";
        input.blur();
        this.renderNow();
      } else if (e.key === "Enter") {
        const [first] = this.client.state.search(this.query, 1);
        if (first) this.locate(first);
      }
      e.stopPropagation(); // keep the site's map shortcuts from firing while typing
    });
    chips.addEventListener("click", (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>("[data-filter]");
      if (!c) return;
      this.ui.filter = c.dataset.filter!;
      saveUi(this.ui);
      this.renderNow();
    });
    list.addEventListener("click", (e) => this.onListClick(e));
    alertsView.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-user]");
      if (a) this.revealPlayer(a.dataset.user!);
    });
    toasts.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-user]");
      if (t) {
        t.remove();
        this.revealPlayer(t.dataset.user!);
      }
    });
    settingsView.addEventListener("change", (e) => this.onSettingsChange(e));
    settingsView.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest('[data-ui="clear-favs"]') && confirm("Remove all favourites?")) {
        void chrome.storage.sync.set({ favourites: {} });
      }
    });
    this.makeDraggable(panel.querySelector("header")!);
  }

  private makeDraggable(handle: HTMLElement) {
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
      const rect = this.$.panel.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.ui.x = ev.clientX - dx;
        this.ui.y = ev.clientY - dy;
        this.applyPosition();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        saveUi(this.ui);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    const onResize = () => this.applyPosition();
    window.addEventListener("resize", onResize);
    this.disposers.push(() => window.removeEventListener("resize", onResize));
  }

  private applyPosition() {
    const p = this.$.panel;
    const w = p.offsetWidth || 360;
    const x = this.ui.x ?? window.innerWidth - w - 64;
    const y = this.ui.y ?? 72;
    p.style.left = `${Math.max(0, Math.min(window.innerWidth - Math.min(w, 120), x))}px`;
    p.style.top = `${Math.max(0, Math.min(window.innerHeight - 44, y))}px`;
  }

  private applyCollapsed() {
    this.$.panel.classList.toggle("collapsed", this.ui.collapsed);
    this.$.collapse.innerHTML = this.ui.collapsed ? ICON.expand : ICON.collapse;
    this.$.collapse.title = this.ui.collapsed ? "Expand" : "Collapse";
    this.applyPosition();
  }

  private setTab(tab: Tab) {
    this.tab = tab;
    if (tab === "alerts") this.unread = 0;
    if (this.ui.collapsed) {
      this.ui.collapsed = false;
      this.applyCollapsed();
    }
    this.renderNow();
  }

  private onGlobalKey(e: KeyboardEvent) {
    const target = e.composedPath()[0] as HTMLElement | undefined;
    const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape" && this.cardId) this.closeCard();
    if (e.key === "/") {
      e.preventDefault();
      this.setTab("players");
      this.$.input.focus();
      this.$.input.select();
    }
  }

  // ------------------------------------------------------------------ data flow

  private get mode(): Mode {
    const s = this.client.state;
    const map = s.event?.map;
    if (map && !map.enabled) return "disabled";
    if (map?.anonymous) return "anonymous";
    if (s.blackout && Date.parse(s.blackout.until) > s.now()) return "blackout";
    return "normal";
  }

  private onState(changes: Set<StateChange>) {
    const relevant = ["status", "locations", "zombies", "projectiles", "slots"] as const;
    if (this.mode === "normal" && relevant.some((c) => changes.has(c))) this.checkAlerts();
    this.syncMap();
    this.scheduleRender();
  }

  private onBridge(msg: ToContent) {
    if (msg.type === "mapStatus") {
      this.mapFound = msg.found;
      this.mapNative = msg.native;
      this.renderSettings();
      if (msg.found) {
        // The bridge may have (re)loaded: resend everything it needs.
        this.lastMarkers = this.lastPlayers = this.lastForecast = this.lastAnchors = "";
      }
      this.syncMap();
      this.scheduleRender();
    } else if (msg.type === "followStopped") {
      this.followId = null;
      this.lastFollowSent = "";
      this.renderNow();
    } else if (msg.type === "playerClicked") {
      this.cardId = msg.id;
      this.cardPos = null;
      this.cardKey = "";
      this.syncAnchors();
      this.renderCard();
    } else if (msg.type === "anchor") {
      if (msg.id === this.cardId) {
        this.cardPos = msg;
        this.positionCard();
      }
      if (msg.id === this.stream.pinnedId) {
        // Sit below the action bar when both belong to the same player.
        const barOpen = this.cardId === msg.id && !this.$.card.hidden;
        this.stream.anchor(msg, barOpen ? this.$.card.offsetHeight + 8 : 0);
      }
    }
  }

  /** Ask the bridge for screen positions of the action-bar player and the pinned stream's player. */
  private syncAnchors() {
    const ids = [...new Set([this.cardId, this.stream?.pinnedId].filter((x): x is string => !!x))];
    const key = ids.join(",");
    if (key === this.lastAnchors) return;
    this.lastAnchors = key;
    this.toPage({ type: "anchors", ids });
  }

  /** Forecast of where the zone is heading, drawn natively on the map by the bridge. */
  private syncForecast() {
    const state = this.client.state;
    const zone = state.safeZone();
    const s = this.store.settings;
    const forecast = zone && s.zoneForecast && this.mode !== "disabled"
      ? buildForecast(zone, state.zoneMotion(), state.now(), s.forecastMinutes)
      : null;
    const key = JSON.stringify(forecast);
    if (key === this.lastForecast) return;
    this.lastForecast = key;
    this.toPage({ type: "zoneForecast", forecast });
  }

  private checkAlerts() {
    const favs = new Set(Object.keys(this.store.favourites));
    if (!favs.size) return;
    const kinds = this.store.settings.alertKinds;
    const fresh = this.engine.evaluate(this.client.state, favs).filter((a) => kinds[a.kind]);
    if (!fresh.length) return;
    this.alerts = [...fresh.reverse(), ...this.alerts].slice(0, 200);
    if (this.tab !== "alerts") this.unread += fresh.length;
    for (const a of fresh) {
      this.toast(a);
      if (this.shouldNotify(this.store.settings.notify)) {
        void this.toBackground({ type: "notify", id: a.userId, title: `SafeZone+ · ${a.username}`, message: a.message });
      }
    }
  }

  private shouldNotify(mode: NotifyMode) {
    return mode === "always" || (mode === "hidden" && document.visibilityState === "hidden");
  }

  private toast(a: Alert) {
    if (this.store.settings.mapAlerts && this.mapToasts.show(a)) return;
    const el = document.createElement("div");
    el.className = `toast ${a.severity}`;
    el.dataset.user = a.userId;
    el.textContent = a.message;
    this.$.toasts.prepend(el);
    while (this.$.toasts.childElementCount > 3) this.$.toasts.lastElementChild!.remove();
    setTimeout(() => el.remove(), 7000);
  }

  /** Push favourite/focus markers and follow-cam updates to the page bridge. */
  private syncMap() {
    const state = this.client.state;
    const visible = this.mode === "normal";
    const markers: MapMarker[] = [];
    if (visible) {
      const favs = this.store.favourites;
      for (const p of state.players()) {
        if (!p.location) continue;
        const fav = p.userId in favs;
        const focus = p.userId === this.focusId || p.userId === this.followId;
        if (!(focus || (fav && this.store.settings.mapLabels))) continue;
        markers.push({
          id: p.userId,
          lat: p.location.lat,
          lng: p.location.lng,
          label: p.username,
          style: fav && focus ? "fav-focus" : focus ? "focus" : "fav",
          dead: !!p.status && !p.status.alive,
        });
      }
    }
    const key = JSON.stringify(markers);
    if (key !== this.lastMarkers) {
      this.lastMarkers = key;
      this.toPage({ type: "markers", markers });
    }
    const points: PlayerPoint[] = visible
      ? state.players().flatMap((p) => (p.location ? [{ id: p.userId, lat: p.location.lat, lng: p.location.lng }] : []))
      : [];
    const pointsKey = JSON.stringify(points);
    if (pointsKey !== this.lastPlayers) {
      this.lastPlayers = pointsKey;
      this.toPage({ type: "players", players: points });
    }
    if (!visible && this.cardId) this.closeCard();
    this.syncForecast();
    if (this.followId) {
      const p = visible ? state.player(this.followId) : undefined;
      if (!p?.location) return;
      const k = `${p.userId}:${p.location.lat}:${p.location.lng}`;
      if (k !== this.lastFollowSent) {
        this.lastFollowSent = k;
        this.toPage({ type: "follow", id: p.userId, lat: p.location.lat, lng: p.location.lng });
      }
    }
  }

  private locate(p: Player) {
    if (this.mode !== "normal") return;
    const pos = p.location ?? p.lastKnown;
    if (!pos) return;
    this.focusId = p.userId;
    this.followId = null;
    this.lastFollowSent = "";
    this.toPage({ type: "unfollow" });
    this.toPage({ type: "flyTo", lat: pos.lat, lng: pos.lng, zoom: this.store.settings.locateZoom });
    this.syncMap();
    this.renderNow();
  }

  private toggleFollow(p: Player) {
    if (this.followId === p.userId) {
      this.followId = null;
      this.toPage({ type: "unfollow" });
    } else {
      this.followId = this.focusId = p.userId;
      this.lastFollowSent = "";
    }
    this.syncMap();
    this.renderNow();
  }

  /** Open the panel on one player (search set to their name so the row is visible). */
  private revealPlayer(userId: string, fly = true) {
    const p = this.client.state.player(userId);
    if (!p) return;
    this.$.input.value = this.query = p.username;
    this.expanded = userId;
    this.setTab("players");
    if (fly) this.locate(p);
    else this.renderNow();
  }

  // ------------------------------------------------------------------ map action bar

  private closeCard() {
    this.cardId = null;
    this.cardPos = null;
    this.syncAnchors();
    this.renderCard();
  }

  private onCardClick(e: MouseEvent) {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    const p = this.cardId ? this.client.state.player(this.cardId) : undefined;
    if (!act || !p) return;
    switch (act) {
      case "fav":
        void this.store.toggleFavourite(p.userId, p.username);
        return;
      case "watch":
        this.watch(p);
        return;
      case "details":
        this.revealPlayer(p.userId, false);
        return;
      case "close":
        this.closeCard();
    }
  }

  private renderCard() {
    const el = this.$.card;
    const p = this.cardId && this.mode === "normal" ? this.client.state.player(this.cardId) : undefined;
    if (!p) {
      el.hidden = true;
      this.cardKey = "";
      return;
    }
    this.ensureKick(p);
    const { entry, channel } = this.kickFor(p);
    const fav = this.store.isFavourite(p.userId);
    const html =
      `<span class="cname">${esc(p.username)}</span>` +
      (channel?.live ? `<span class="live">● LIVE${channel.viewers != null ? ` ${channel.viewers.toLocaleString()}` : ""}</span>` : "") +
      `<button class="icon-btn ${fav ? "on" : ""}" data-act="fav" title="${fav ? "Unfavourite" : "Favourite"}">${fav ? ICON.star : ICON.starOff}</button>` +
      `<button class="pbtn primary" data-act="watch"${channel ? "" : " disabled"} title="${channel ? `Watch ${esc(channel.slug)} in a floating player` : entry?.pending ? "Checking Kick…" : "No Kick channel found"}">${ICON.tv} Watch</button>` +
      (channel ? `<a class="pbtn" href="${kickChannelUrl(channel.slug)}" target="_blank" rel="noopener" title="Open on Kick">Kick ${ICON.external}</a>` : "") +
      `<button class="icon-btn" data-act="details" title="Details in SafeZone+">${ICON.panel}</button>` +
      `<button class="icon-btn" data-act="close" title="Close (Esc)">${ICON.x}</button>`;
    if (html !== this.cardKey) {
      this.cardKey = html;
      el.innerHTML = html;
    }
    this.positionCard();
  }

  private positionCard() {
    const el = this.$.card;
    const pos = this.cardPos;
    if (!this.cardId || !pos?.visible || this.mode !== "normal") {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    // pos is just below the sprite (and its name label); keep the whole bar on screen.
    const half = el.offsetWidth / 2 || 140;
    el.style.left = `${Math.max(half + 8, Math.min(window.innerWidth - half - 8, pos.x))}px`;
    el.style.top = `${Math.min(window.innerHeight - 56, pos.y + 8)}px`;
  }

  // ------------------------------------------------------------------ kick

  private kickSlug(p: Player) {
    return p.roster?.kick_slug ?? guessKickSlug(p.username);
  }

  /** Usable channel for a player: verified via avatar id, or unverifiable but existing. */
  private kickFor(p: Player): { entry: KickEntry | undefined; channel: KickChannelInfo | null } {
    const entry = this.kick.get(this.kickSlug(p));
    const ch = entry?.channel ?? null;
    const usable = ch && (ch.verified || p.kickUserId === null || !!p.roster?.kick_slug) ? ch : null;
    return { entry, channel: usable };
  }

  private ensureKick(p: Player) {
    const slug = this.kickSlug(p);
    const e = this.kick.get(slug);
    if (e && (e.pending || Date.now() - e.at < KICK_TTL_MS)) return;
    this.kick.set(slug, { at: e?.at ?? 0, channel: e?.channel ?? null, pending: true });
    this.kickQueue.push({ slug, expected: p.kickUserId });
    this.pumpKick();
  }

  private pumpKick() {
    while (this.kickActive < KICK_CONCURRENCY && this.kickQueue.length) {
      const { slug, expected } = this.kickQueue.shift()!;
      this.kickActive++;
      this.toBackground<KickResponse>({ type: "kick", slug, expectedUserId: expected })
        .then((res) => {
          this.kick.set(slug, res?.ok ? { at: Date.now(), channel: res.channel } : { at: Date.now(), channel: null, failed: true });
        })
        .catch(() => this.kick.set(slug, { at: Date.now(), channel: null, failed: true }))
        .finally(() => {
          this.kickActive--;
          this.pumpKick();
          this.scheduleRender();
        });
    }
  }

  private watch(p: Player) {
    const { channel } = this.kickFor(p);
    if (!channel) return;
    this.stream.open({ userId: p.userId, slug: channel.slug, name: p.username });
    this.stream.el.classList.add("front");
    this.$.panel.classList.remove("front");
    this.renderStreamTitle();
  }

  private renderStreamTitle() {
    const cur = this.stream?.current;
    if (!cur) return;
    const p = this.client.state.player(cur.userId);
    const ch = p ? this.kickFor(p).channel : null;
    this.stream.setTitle(
      `▶ ${esc(cur.name)}` + (ch?.live ? ` <span class="live">● LIVE${ch.viewers != null ? ` ${ch.viewers.toLocaleString()}` : ""}</span>` : ""),
    );
  }

  // ------------------------------------------------------------------ list actions

  private onListClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("a")) return;
    const row = target.closest<HTMLElement>(".row");
    const id = row?.dataset.id;
    if (!id) return;
    const p = this.client.state.player(id);
    if (!p) return;
    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    switch (act) {
      case "fav":
        void this.store.toggleFavourite(p.userId, p.username);
        if (!this.store.isFavourite(p.userId)) this.engine.forget(p.userId);
        return;
      case "locate":
        this.locate(p);
        return;
      case "follow":
        this.toggleFollow(p);
        return;
      case "watch":
        this.watch(p);
        return;
      case undefined:
        this.expanded = this.expanded === id ? null : id;
        this.renderNow();
    }
  }

  private onSettingsChange(e: Event) {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const s = this.store.settings;
    if (el.name === "notify") void this.store.updateSettings({ notify: el.value as NotifyMode });
    else if (el.name === "mapLabels") void this.store.updateSettings({ mapLabels: (el as HTMLInputElement).checked });
    else if (el.name === "mapAlerts") void this.store.updateSettings({ mapAlerts: (el as HTMLInputElement).checked });
    else if (el.name === "locateZoom") void this.store.updateSettings({ locateZoom: Number(el.value) });
    else if (el.name === "zoneForecast") void this.store.updateSettings({ zoneForecast: (el as HTMLInputElement).checked });
    else if (el.name === "forecastMinutes") void this.store.updateSettings({ forecastMinutes: Number(el.value) });
    else if (el.name.startsWith("kind:")) {
      const kind = el.name.slice(5) as keyof typeof s.alertKinds;
      void this.store.updateSettings({ alertKinds: { ...s.alertKinds, [kind]: (el as HTMLInputElement).checked } });
    }
  }

  // ------------------------------------------------------------------ rendering

  private scheduleRender() {
    if (this.renderTimer) return;
    const wait = Math.max(0, RENDER_INTERVAL_MS - (Date.now() - this.lastRender));
    this.renderTimer = setTimeout(() => this.renderNow(), wait);
  }

  private renderNow() {
    clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.lastRender = Date.now();
    this.renderHeader();
    this.renderBanner();
    this.renderTabs();
    this.$.playersView.style.display = this.tab === "players" ? "flex" : "none";
    this.$.alertsView.hidden = this.tab !== "alerts";
    this.$.settingsView.hidden = this.tab !== "settings";
    if (this.tab === "players") this.renderPlayers();
    if (this.tab === "alerts") this.renderAlerts();
    this.renderCard();
    this.renderStreamTitle();
  }

  private renderHeader() {
    const state = this.client.state;
    this.$.conn.className = `conn ${this.conn}`;
    this.$.conn.title = `Feed: ${this.conn}${this.mapFound ? "" : " · map not detected yet"}`;
    if (this.mode !== "normal" || !state.slots.size) {
      this.$.hstats.textContent = state.slots.size ? "" : "loading…";
      return;
    }
    const players = state.players();
    const alive = players.filter((p) => p.status?.alive).length;
    const zone = state.safeZone();
    const z = zone ? zoneAt(zone, state.now()) : null;
    const shrinking = zone?.transition && Date.parse(zone.transition.ends_at) > state.now();
    const moving = zoneMotionText(state.zoneMotion());
    this.$.hstats.innerHTML =
      `<span class="n">${alive}</span>/${players.length} alive` +
      (z ? ` · zone ${formatDistance(z.radius)}${shrinking ? ' <span class="warn" title="Zone is shrinking">▼</span>' : ""}` : "") +
      (moving ? ` <span class="zmove" title="Zone drift (estimated from recent updates)">${moving.replace(/ [NSEW]+ /, " ")}</span>` : "") +
      (this.unread && this.ui.collapsed ? ` <span class="badge">${this.unread}</span>` : "");
  }

  private renderBanner() {
    const state = this.client.state;
    const b = this.$.banner;
    let text = "";
    let bad = false;
    switch (this.mode) {
      case "disabled":
        text = "The public map is currently disabled.";
        break;
      case "anonymous":
        text = "Contestants are anonymous right now — SafeZone+ respects that and hides the player list.";
        break;
      case "blackout": {
        const bo = state.blackout!;
        text = `${bo.source === "emp" ? "An EMP" : "A smoke bomb"} has blacked out the map until ${timeOf(Date.parse(bo.until))}. Positions and health are hidden until then.`;
        bad = true;
        break;
      }
      default:
        if (state.event?.upstream === "down") text = "The event feed is reporting upstream issues — data may be stale.";
        else if (this.conn === "reconnecting") text = "Reconnecting to the live feed…";
    }
    b.hidden = !text;
    b.textContent = text;
    b.classList.toggle("bad", bad);
  }

  private renderTabs() {
    for (const t of this.$.tabs.querySelectorAll<HTMLElement>("[data-tab]")) {
      const id = t.dataset.tab as Tab;
      t.classList.toggle("active", id === this.tab);
      if (id === "alerts") t.innerHTML = `Alerts${this.unread ? `<span class="badge">${this.unread}</span>` : ""}`;
    }
  }

  private views(): { all: RowView[]; byId: Map<string, RowView> } {
    const state = this.client.state;
    const zone = state.safeZone();
    const circle = zone ? zoneAt(zone, state.now()) : null;
    const zombies = state.zombies();
    const chasing = new Map<string, Zombie[]>();
    for (const z of zombies) if (z.targetUserId) chasing.set(z.targetUserId, [...(chasing.get(z.targetUserId) ?? []), z]);
    const now = state.now();
    const motion = state.zoneMotion();
    const all = state.players().map((p) => {
      const dead = !!p.status && (!p.status.alive || p.status.status === "eliminated");
      return {
        p,
        fav: p.userId in this.store.favourites,
        dead,
        margin: p.location && circle ? edgeMarginM(p.location, circle) : null,
        stale: state.isStale(p, now),
        chasers: chasing.get(p.userId) ?? [],
        eta: !dead && p.location && zone ? edgeEta(p.location, zone, motion, now) : null,
      };
    });
    return { all, byId: new Map(all.map((v) => [v.p.userId, v])) };
  }

  private renderPlayers() {
    const state = this.client.state;
    const { all, byId } = this.views();
    const alive = all.filter((v) => !v.dead);
    const hp = (v: RowView) => v.p.status?.hp ?? -1;
    const byName = (a: RowView, b: RowView) => a.p.username.localeCompare(b.p.username);
    const favFirst = (a: RowView, b: RowView) => Number(b.fav) - Number(a.fav);
    const diedAt = (v: RowView) => v.p.death?.at ?? -Infinity;
    const sets: Record<Filter, () => RowView[]> = {
      favourites: () => all.filter((v) => v.fav).sort((a, b) => Number(a.dead) - Number(b.dead) || hp(b) - hp(a) || byName(a, b)),
      // Healthiest first, starred players on top.
      alive: () => [...alive].sort((a, b) => favFirst(a, b) || hp(b) - hp(a) || byName(a, b)),
      outside: () => alive.filter((v) => v.p.status?.status === "outside" || (v.margin !== null && v.margin < 0)).sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0)),
      // Lowest HP first.
      lowhp: () => alive.filter((v) => v.p.status).sort((a, b) => hp(a) - hp(b) || byName(a, b)).slice(0, 30),
      chased: () => alive.filter((v) => v.chasers.length).sort((a, b) => b.chasers.length - a.chasers.length),
      // Most recent death first; unknown times last.
      eliminated: () => all.filter((v) => v.dead).sort((a, b) => diedAt(b) - diedAt(a) || byName(a, b)),
    };
    const filter = (FILTERS.some((f) => f.id === this.ui.filter) ? this.ui.filter : "favourites") as Filter;
    const restricted = this.mode === "anonymous" || this.mode === "disabled";
    const counts = Object.fromEntries(FILTERS.map((f) => [f.id, restricted ? 0 : sets[f.id]().length]));
    this.$.chips.innerHTML = FILTERS.map(
      (f) => `<button class="chip${f.id === filter && !this.query ? " active" : ""}" data-filter="${f.id}">${f.label}<span class="c">${counts[f.id]}</span></button>`,
    ).join("");

    const nodes: Node[] = [];
    const section = (text: string) => {
      const d = document.createElement("div");
      d.className = "section";
      d.textContent = text;
      nodes.push(d);
    };
    const empty = (html: string) => {
      const d = document.createElement("div");
      d.className = "empty";
      d.innerHTML = html;
      nodes.push(d);
    };

    let shown: RowView[] = [];
    if (restricted) {
      empty(this.mode === "anonymous" ? "Player list hidden while contestants are anonymous." : "The public map is disabled.");
    } else if (!state.slots.size) {
      empty("Connecting to the live feed…");
    } else if (this.query.trim()) {
      shown = state.search(this.query, 40).map((p) => byId.get(p.userId)!);
      section(`${shown.length} result${shown.length === 1 ? "" : "s"}`);
      if (!shown.length) empty(`No players match “${esc(this.query)}”.`);
    } else {
      shown = sets[filter]();
      if (!shown.length) {
        empty(filter === "favourites"
          ? "No favourites yet.<br>Search for a player and tap ☆ to follow them here, get alerts and see them highlighted on the map."
          : "Nobody here right now.");
      }
    }

    const keep = new Set<string>();
    for (const v of shown.slice(0, MAX_ROWS)) {
      keep.add(v.p.userId);
      nodes.push(this.row(v));
    }
    if (shown.length > MAX_ROWS) section(`+${shown.length - MAX_ROWS} more — refine your search`);
    for (const id of this.rows.keys()) if (!keep.has(id)) this.rows.delete(id);
    this.$.list.replaceChildren(...nodes);

    // Kick lookups for what's on screen, favourites first.
    if (!restricted) {
      for (const v of all) if (v.fav) this.ensureKick(v.p);
      for (const v of shown.slice(0, 25)) this.ensureKick(v.p);
    }
  }

  private row(v: RowView): HTMLDivElement {
    const { p } = v;
    let cached = this.rows.get(p.userId);
    if (!cached) {
      const el = document.createElement("div");
      el.className = "row";
      el.dataset.id = p.userId;
      el.setAttribute("role", "listitem");
      const av = document.createElement("div");
      av.className = "av";
      if (p.avatarUrl) {
        const img = document.createElement("img");
        img.src = p.avatarUrl;
        img.alt = "";
        img.loading = "lazy";
        av.appendChild(img);
      } else av.textContent = p.username.slice(0, 1).toUpperCase();
      const body = document.createElement("div");
      body.className = "body";
      const actions = document.createElement("div");
      actions.className = "actions";
      el.append(av, body, actions);
      cached = { el, key: "" };
      this.rows.set(p.userId, cached);
    }
    const { body, actions } = this.rowHtml(v);
    const key = body + actions;
    if (key !== cached.key) {
      cached.key = key;
      (cached.el.children[1] as HTMLElement).innerHTML = body;
      (cached.el.children[2] as HTMLElement).innerHTML = actions;
    }
    cached.el.classList.toggle("dead", v.dead);
    cached.el.classList.toggle("focus", p.userId === this.focusId || p.userId === this.followId);
    return cached.el;
  }

  private rowHtml(v: RowView): { body: string; actions: string } {
    const { p } = v;
    const state = this.client.state;
    const now = state.now();
    const hidden = this.mode === "blackout";
    const { entry, channel } = this.kickFor(p);
    const s = p.status;

    let kick = "";
    if (channel?.live) kick = `<span class="live" title="${esc(channel.title ?? "Live on Kick")}">● LIVE${channel.viewers != null ? ` ${channel.viewers.toLocaleString()}` : ""}</span>`;
    else if (channel) kick = '<span class="offline">offline</span>';

    let l2: string;
    if (hidden) l2 = '<span class="dim">hidden during blackout</span>';
    else if (v.dead) l2 = `<span class="bad">Eliminated</span>${this.deathText(p) ? `<span class="dim">· ${esc(this.deathText(p)!)}</span>` : ""}`;
    else {
      const parts: string[] = [];
      if (s) {
        const frac = Math.max(0, Math.min(1, s.hp / s.maxHp));
        const col = frac > 0.5 ? "var(--ok)" : frac > 0.25 ? "var(--warn)" : "var(--bad)";
        parts.push(`<span class="hp"><i style="width:${(frac * 100).toFixed(0)}%;background:${col}"></i></span><span>${s.hp}/${s.maxHp}</span>`);
      }
      if (v.margin !== null) parts.push(v.margin >= 0 ? `<span class="ok">${formatDistance(v.margin)} in</span>` : `<span class="bad">${formatDistance(v.margin)} out</span>`);
      if (p.location) parts.push(`<span class="${v.stale ? "warn" : "dim"}">${formatDuration(now - p.location.recordedAt)}</span>`);
      else if (p.lastKnown) parts.push('<span class="warn">hidden</span>');
      else parts.push('<span class="dim">no location</span>');
      l2 = parts.join("<span class=dim>·</span>");
    }

    const tags: string[] = [];
    if (!hidden && s && !v.dead) {
      if (s.badges.includes("kick_shield")) tags.push('<span class="tag" title="Kick shield">🛡 shield</span>');
      if (s.badges.includes("faith_shield")) tags.push('<span class="tag" title="Faith shield">✝ faith</span>');
      if (s.poison && s.poison.endsAt > now) tags.push(`<span class="tag warn">☠ poison ${formatDuration(s.poison.endsAt - now)}</span>`);
      if (s.droneLandsAt && s.droneLandsAt > now) tags.push(`<span class="tag bad">🛸 drone ${formatDuration(s.droneLandsAt - now)}</span>`);
      if (s.outsideSince) tags.push(`<span class="tag bad">outside ${formatDuration(now - s.outsideSince)}</span>`);
      if (v.chasers.length && p.location) {
        const nearest = Math.min(...v.chasers.map((z) => distanceM(p.location!, z)));
        tags.push(`<span class="tag warn">🧟 ×${v.chasers.length} · ${formatDistance(nearest)}</span>`);
      }
      if (p.location?.mock) tags.push('<span class="tag bad" title="Device reports a mock location provider">mock GPS</span>');
      if (v.eta && v.eta.ms <= ETA_TAG_MS) {
        const soon = v.eta.ms < 5 * 60_000;
        tags.push(v.eta.kind === "exits"
          ? `<span class="tag ${soon ? "bad" : "warn"}" title="If they stay put, the moving zone edge passes them in this long">⏳ edge in ${formatDuration(v.eta.ms)}</span>`
          : `<span class="tag" title="If they stay put, the moving zone reaches them in this long">⏳ zone in ${formatDuration(v.eta.ms)}</span>`);
      }
      for (const pr of state.projectiles) {
        if (p.location && pr.kind !== "gods_fruit" && distanceM(p.location, { lat: pr.targetLat, lng: pr.targetLng }) <= pr.targetRadiusM + 50) {
          tags.push(`<span class="tag bad">${pr.kind === "nuke" ? "☢ nuke" : "🚀 missile"} ${formatDuration(pr.landsAt - now)}</span>`);
        }
      }
    }

    const details = this.expanded === p.userId ? this.detailsHtml(v, entry, channel) : "";
    const body =
      `<div class="l1"><span class="name">${esc(p.username)}</span>${kick}</div>` +
      `<div class="l2">${l2}</div>` +
      (tags.length ? `<div class="tags">${tags.join("")}</div>` : "") +
      details;

    const canMap = !hidden && !!(p.location ?? p.lastKnown);
    const following = this.followId === p.userId;
    const btn = (act: string, icon: string, title: string, enabled = true, cls = "") =>
      `<button class="icon-btn ${cls}" data-act="${act}" title="${esc(title)}"${enabled ? "" : " disabled"}>${icon}</button>`;
    const actions =
      btn("fav", v.fav ? ICON.star : ICON.starOff, v.fav ? "Unfavourite" : "Favourite", true, v.fav ? "on" : "") +
      btn("locate", ICON.pin, canMap ? "Show on map" : "No position available", canMap) +
      btn("follow", ICON.follow, following ? "Stop following" : "Follow on map", canMap && !!p.location, following ? "on-accent" : "") +
      btn("watch", ICON.tv, channel ? `Watch ${channel.slug}` : entry?.pending ? "Checking Kick…" : "No Kick channel found", !!channel);
    return { body, actions };
  }

  /** "12m ago · zone" / "3m ago · killed by X" for eliminated players. */
  private deathText(p: Player): string | null {
    const d = p.death;
    if (!d) return null;
    const ago = `${formatDuration(this.client.state.now() - d.at)} ago`;
    const how = d.killer ? `killed by ${d.killer}` : d.source ? d.source.replace(/_/g, " ") : null;
    return how ? `${ago} · ${how}` : ago;
  }

  private detailsHtml(v: RowView, entry: KickEntry | undefined, channel: KickChannelInfo | null): string {
    const { p } = v;
    const state = this.client.state;
    const rows: string[] = [];
    if (this.mode === "normal" && p.location) {
      const loc = p.location;
      rows.push(`<div><span class="k">Position</span> ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} ±${loc.accuracyM}m</div>`);
      const zone = state.safeZone();
      if (zone) {
        const c = zoneAt(zone, state.now());
        const moving = zoneMotionText(state.zoneMotion());
        rows.push(`<div><span class="k">Zone centre</span> ${formatDistance(distanceM(loc, c))} ${compass(bearingDeg(loc, c))}${moving ? ` · zone moving <span class="zmove">${moving}</span>` : ""}</div>`);
        if (v.eta) {
          rows.push(v.eta.kind === "exits"
            ? `<div><span class="k">If they stay put</span> <span class="${v.eta.ms < 5 * 60_000 ? "bad" : "warn"}">outside in ${formatDuration(v.eta.ms)}</span> (~${timeOf(state.now() + v.eta.ms)})</div>`
            : `<div><span class="k">If they stay put</span> zone reaches them in ${formatDuration(v.eta.ms)} (~${timeOf(state.now() + v.eta.ms)})</div>`);
        }
        if (zone.transition && Date.parse(zone.transition.ends_at) > state.now()) {
          const m = edgeMarginM(loc, zoneTarget(zone));
          rows.push(`<div><span class="k">After shrink</span> <span class="${m >= 0 ? "ok" : "bad"}">${formatDistance(m)} ${m >= 0 ? "inside" : "outside"}</span> by ${timeOf(Date.parse(zone.transition.ends_at))}</div>`);
        }
      }
      const near = describeNearby(state, p);
      if (near.length) rows.push(`<div><span class="k">Nearby</span> ${esc(near.slice(0, 6).join(" · "))}</div>`);
    } else if (this.mode === "normal" && p.lastKnown) {
      rows.push(`<div><span class="k">Last known</span> ${p.lastKnown.lat.toFixed(5)}, ${p.lastKnown.lng.toFixed(5)} (${formatDuration(state.now() - p.lastKnown.recordedAt)} ago)</div>`);
    }
    if (v.dead && p.death) {
      const d = p.death;
      rows.push(`<div><span class="k">Died</span> ${timeOf(d.at)} (${esc(this.deathText(p)!)})${d.cause ? ` · ${esc(d.cause)}` : ""}</div>`);
    }
    const slug = this.kickSlug(p);
    if (channel) {
      rows.push(`<div><span class="k">Kick</span> kick.com/${esc(channel.slug)}${channel.verified ? "" : ' <span class="dim">(unverified)</span>'}${channel.live ? ' <span class="live">● LIVE</span>' : ' <span class="offline">offline</span>'}</div>`);
      if (channel.live && channel.title) rows.push(`<div class="dim">${esc(channel.title)}</div>`);
    } else if (entry && !entry.pending) {
      rows.push(`<div><span class="k">Kick</span> <span class="dim">${entry.failed ? "lookup failed" : `no matching channel for “${esc(slug)}”`}</span></div>`);
    }
    const btns: string[] = [];
    if (channel) {
      btns.push(`<button class="pbtn primary" data-act="watch">${ICON.tv} Watch</button>`);
      btns.push(`<a class="pbtn" href="${kickChannelUrl(channel.slug)}" target="_blank" rel="noopener">Open on Kick ${ICON.external}</a>`);
    }
    if (this.mode === "normal" && p.location) {
      btns.push(`<a class="pbtn" href="https://www.google.com/maps?q=${p.location.lat},${p.location.lng}" target="_blank" rel="noopener">Google Maps ${ICON.external}</a>`);
    }
    if (btns.length) rows.push(`<div class="btns">${btns.join("")}</div>`);
    return `<div class="details">${rows.join("")}</div>`;
  }

  private renderAlerts() {
    const v = this.$.alertsView;
    if (!this.alerts.length) {
      const favCount = Object.keys(this.store.favourites).length;
      v.innerHTML = `<div class="empty">${favCount ? "No alerts yet. Alerts for your favourites will appear here." : "Favourite players (☆) to get alerts when they take damage, leave the zone, get targeted and more."}</div>`;
      return;
    }
    v.innerHTML = this.alerts
      .map((a) => `<div class="alert ${a.severity}" data-user="${a.userId}"><span class="t">${timeOf(a.at)}</span><span class="m">${esc(a.message)}</span></div>`)
      .join("");
  }

  private renderSettings() {
    const s = this.store.settings;
    const opt = (v: NotifyMode, label: string) => `<option value="${v}"${s.notify === v ? " selected" : ""}>${label}</option>`;
    this.$.settingsView.innerHTML = `
      <div>
        <h4>Desktop notifications</h4>
        <select name="notify">${opt("off", "Off")}${opt("hidden", "When this tab is in the background")}${opt("always", "Always")}</select>
      </div>
      <div>
        <h4>Alert me about favourites when they…</h4>
        ${(Object.keys(ALERT_KIND_LABELS) as (keyof typeof ALERT_KIND_LABELS)[])
          .map((k) => `<label><input type="checkbox" name="kind:${k}"${s.alertKinds[k] ? " checked" : ""}> ${ALERT_KIND_LABELS[k]}</label>`)
          .join("")}
      </div>
      <div>
        <h4>Map</h4>
        <label><input type="checkbox" name="mapLabels"${s.mapLabels ? " checked" : ""}> Highlight favourites on the map</label>
        <label><input type="checkbox" name="mapAlerts"${s.mapAlerts ? " checked" : ""}> Show alerts in the map's top-left corner</label>
        <label>Zoom when locating <input type="range" name="locateZoom" min="13" max="19" step="0.5" value="${s.locateZoom}"> ${s.locateZoom}</label>
      </div>
      <div>
        <h4>Zone</h4>
        <label><input type="checkbox" name="zoneForecast"${s.zoneForecast ? " checked" : ""}> Show where the zone is heading</label>
        <label>Forecast <select name="forecastMinutes">${[5, 10, 15, 30, 60].map((m) => `<option value="${m}"${s.forecastMinutes === m ? " selected" : ""}>${m} min</option>`).join("")}</select> ahead</label>
        <div class="hint">Speed and direction are estimated from the zone's recent movement (needs ~15s after loading).</div>
      </div>
      <div>
        <h4>Favourites</h4>
        <div class="hint">${Object.keys(this.store.favourites).length} favourites · synced with your browser profile.</div>
        <p><button class="btn" data-ui="clear-favs">Clear all favourites</button></p>
      </div>
      <div class="hint">Press <b>/</b> anywhere on the map to search. Enter jumps to the top result.</div>
      <div class="hint">Map markers: ${this.mapNative ? "attached to the site's own player sprites ✓" : this.mapFound ? "fallback overlay (site renderer not found)" : "waiting for the map…"}</div>`;
  }
}
