import { kickChannelUrl, kickPlayerUrl } from "../../../src/core/index.js";

export interface StreamUi {
  x: number | null;
  y: number | null;
  w: number;
  pinned: boolean;
  muted: boolean;
}

export interface StreamTarget {
  userId: string;
  slug: string;
  name: string;
}

const MIN_W = 240;
const MARGIN = 8;
const PIN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
const EXT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const SPEAKER = '<path d="M11 5 6 9H2v6h4l5 4V5z"/>';
const MUTED_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SPEAKER}<path d="m23 9-6 6M17 9l6 6"/></svg>`;
const SOUND_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SPEAKER}<path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const X_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/**
 * Floating Kick player. Free mode: draggable (header) and resizable (corner), position saved.
 * Pinned mode: follows the player's sprite on the map (positions come from the page bridge).
 */
export class StreamWindow {
  readonly el: HTMLDivElement;
  current: StreamTarget | null = null;
  private iframe: HTMLIFrameElement;
  private title: HTMLSpanElement;
  private pin: HTMLButtonElement;
  private mute: HTMLButtonElement;
  private link: HTMLAnchorElement;

  constructor(
    root: ShadowRoot,
    private ui: StreamUi,
    private hooks: {
      save(ui: StreamUi): void;
      /** Called when opened/closed/pinned so the app can update bridge anchors. */
      onChange(): void;
      /** Rect to avoid when choosing the default position (the panel). */
      avoid(): DOMRect | null;
    },
  ) {
    this.el = document.createElement("div");
    this.el.className = "stream";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="sbar">
        <span class="ttl"></span>
        <button class="icon-btn" data-sact="mute"></button>
        <button class="icon-btn" data-sact="pin">${PIN_ICON}</button>
        <a class="icon-btn" data-sact="kick" target="_blank" rel="noopener" title="Open on Kick">${EXT_ICON}</a>
        <button class="icon-btn" data-sact="close" title="Close stream">${X_ICON}</button>
      </div>
      <iframe allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>
      <div class="sresize" title="Drag to resize"></div>`;
    root.appendChild(this.el);
    this.iframe = this.el.querySelector("iframe")!;
    this.title = this.el.querySelector(".ttl")!;
    this.pin = this.el.querySelector('[data-sact="pin"]')!;
    this.mute = this.el.querySelector('[data-sact="mute"]')!;
    this.link = this.el.querySelector('[data-sact="kick"]')!;
    this.pin.addEventListener("click", () => this.setPinned(!this.ui.pinned));
    this.mute.addEventListener("click", () => this.setMuted(!this.ui.muted));
    this.syncMute();
    this.el.querySelector('[data-sact="close"]')!.addEventListener("click", () => this.close());
    this.wireDrag(this.el.querySelector(".sbar")!);
    this.wireResize(this.el.querySelector(".sresize")!);
  }

  /** User id of the player the window is pinned to, if any. */
  get pinnedId(): string | null {
    return this.current && this.ui.pinned ? this.current.userId : null;
  }

  open(target: StreamTarget): void {
    const changed = this.current?.slug !== target.slug;
    this.current = target;
    if (changed) {
      this.iframe.src = kickPlayerUrl(target.slug, this.ui.muted);
      this.iframe.title = `${target.name} on Kick`;
      this.link.href = kickChannelUrl(target.slug);
    }
    this.title.textContent = `▶ ${target.name}`;
    this.el.hidden = false;
    this.el.style.visibility = "";
    this.applySize();
    if (!this.ui.pinned) this.placeFree();
    this.syncPin();
    this.hooks.onChange();
  }

  close(): void {
    this.current = null;
    this.iframe.src = "about:blank";
    this.el.hidden = true;
    this.hooks.onChange();
  }

  /** Title HTML (caller escapes), e.g. with live viewer count. */
  setTitle(html: string): void {
    if (this.title.innerHTML !== html) this.title.innerHTML = html;
  }

  /**
   * Position update for the pinned player. While they're off screen the window is hidden
   * (visibility only, so the stream keeps playing and audio continues).
   */
  anchor(pos: { x: number; y: number; visible: boolean }, extraY = 0): void {
    if (!this.ui.pinned || this.el.hidden) return;
    this.el.style.visibility = pos.visible ? "" : "hidden";
    if (!pos.visible) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const x = Math.max(MARGIN, Math.min(window.innerWidth - w - MARGIN, pos.x - w / 2));
    const y = Math.max(MARGIN, Math.min(window.innerHeight - h - MARGIN, pos.y + 8 + extraY));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  /**
   * The Kick embed only takes mute state from its URL, so toggling reloads it. The click is a
   * user gesture, which (with allow="autoplay") lets Chrome autoplay it with sound.
   */
  private setMuted(muted: boolean) {
    this.ui.muted = muted;
    if (this.current) this.iframe.src = kickPlayerUrl(this.current.slug, muted);
    this.syncMute();
    this.hooks.save(this.ui);
  }

  private syncMute() {
    this.mute.innerHTML = this.ui.muted ? MUTED_ICON : SOUND_ICON;
    this.mute.title = this.ui.muted ? "Unmute (reloads the player)" : "Mute (reloads the player)";
    this.mute.classList.toggle("on-accent", !this.ui.muted);
  }

  private setPinned(pinned: boolean) {
    this.ui.pinned = pinned;
    if (!pinned) this.el.style.visibility = "";
    if (!pinned && !this.el.hidden) {
      // Stay where it is now rather than jumping back to the old free position.
      const r = this.el.getBoundingClientRect();
      this.ui.x = r.left;
      this.ui.y = r.top;
      this.placeFree();
    }
    this.syncPin();
    this.hooks.save(this.ui);
    this.hooks.onChange();
  }

  private syncPin() {
    this.pin.classList.toggle("on-accent", this.ui.pinned);
    this.pin.title = this.ui.pinned ? "Unpin (float freely)" : "Pin under the player on the map";
  }

  private applySize() {
    const w = Math.max(MIN_W, Math.min(this.ui.w, window.innerWidth - 2 * MARGIN));
    this.el.style.width = `${w}px`;
  }

  /** Saved position, or top-right while staying clear of the panel. */
  private placeFree() {
    const w = this.el.offsetWidth || this.ui.w;
    const h = this.el.offsetHeight || (this.ui.w * 9) / 16 + 34;
    let x = this.ui.x;
    let y = this.ui.y;
    if (x === null || y === null) {
      x = window.innerWidth - w - 16;
      y = 72;
      const avoid = this.hooks.avoid();
      if (avoid && x < avoid.right && x + w > avoid.left && y < avoid.bottom && y + h > avoid.top) {
        x = avoid.left - w - 12 >= MARGIN ? avoid.left - w - 12 : x;
      }
    }
    this.el.style.left = `${Math.max(MARGIN, Math.min(window.innerWidth - w - MARGIN, x))}px`;
    this.el.style.top = `${Math.max(MARGIN, Math.min(window.innerHeight - 40, y))}px`;
  }

  private wireDrag(handle: HTMLElement) {
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button, a") || e.button !== 0) return;
      const rect = this.el.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      this.el.classList.add("dragging");
      if (this.ui.pinned) {
        this.ui.pinned = false; // grabbing the window detaches it from the player
        this.el.style.visibility = "";
        this.syncPin();
        this.hooks.onChange();
      }
      const move = (ev: PointerEvent) => {
        this.ui.x = ev.clientX - dx;
        this.ui.y = ev.clientY - dy;
        this.placeFree();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        this.el.classList.remove("dragging");
        this.hooks.save(this.ui);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  private wireResize(handle: HTMLElement) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.el.offsetWidth;
      handle.setPointerCapture(e.pointerId);
      this.el.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        this.ui.w = Math.max(MIN_W, Math.min(window.innerWidth - 2 * MARGIN, startW + ev.clientX - startX));
        this.applySize();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        this.el.classList.remove("dragging");
        this.hooks.save(this.ui);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }
}
