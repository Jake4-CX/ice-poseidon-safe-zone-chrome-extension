/**
 * Optionally tucks the site's header (logo, tabs, account menu) away so the map gets the whole
 * screen. It slides back down while the pointer is at the very top of the window, or when the
 * small pull tab is clicked, so the tabs and the logged-in account stay reachable.
 *
 * The header is the element right before the page's <main> (its class names are hashed CSS
 * modules, so they aren't stable across deploys).
 */
const STYLE_ID = "szp-header-style";
const ATTR = "data-szp-header";
const HIDE = "szp-hide-header";
const PEEK = "szp-header-peek";
/** Pointer this close to the top edge reveals the header. */
const EDGE_PX = 6;
const HIDE_DELAY_MS = 450;

const PAGE_CSS = `
html.${HIDE} [${ATTR}] {
  position: fixed !important; top: 0; left: 0; right: 0; z-index: 2147482000;
  transform: translateY(-100%); transition: transform .18s ease, box-shadow .18s ease;
}
html.${HIDE}.${PEEK} [${ATTR}] { transform: none; box-shadow: 0 8px 28px rgba(0,0,0,.55); }
`;

export class SiteHeader {
  private enabled = false;
  private pinned = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private tab: HTMLButtonElement;
  private disposers: (() => void)[] = [];

  /** `tab` is the pull-tab button, created in the caller's shadow root. */
  constructor(tab: HTMLButtonElement) {
    this.tab = tab;
    tab.addEventListener("click", () => {
      this.pinned = !this.peeking;
      this.setPeek(this.pinned);
    });
    const onMove = (e: PointerEvent) => {
      if (!this.enabled) return;
      if (e.clientY <= EDGE_PX) this.setPeek(true);
      else if (this.peeking && !this.pinned && !this.insideHeader(e)) this.scheduleHide();
      else if (this.insideHeader(e)) clearTimeout(this.hideTimer);
    };
    const onDown = (e: PointerEvent) => {
      // Clicking the map closes a pinned header.
      if (this.pinned && !this.insideHeader(e) && !e.composedPath().includes(this.tab)) {
        this.pinned = false;
        this.setPeek(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.peeking) {
        this.pinned = false;
        this.setPeek(false);
      }
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    this.disposers.push(
      () => document.removeEventListener("pointermove", onMove),
      () => document.removeEventListener("pointerdown", onDown, true),
      () => document.removeEventListener("keydown", onKey),
    );
  }

  private get peeking() {
    return document.documentElement.classList.contains(PEEK);
  }

  /** The site's header element (re-found after Astro page swaps). */
  find(): HTMLElement | null {
    const tagged = document.querySelector<HTMLElement>(`[${ATTR}]`);
    if (tagged) return tagged;
    const main = document.querySelector("main");
    const prev = main?.previousElementSibling as HTMLElement | null | undefined;
    if (!prev || !/^(SECTION|HEADER)$/.test(prev.tagName) || !prev.querySelector("nav, astro-island")) return null;
    prev.setAttribute(ATTR, "");
    return prev;
  }

  /** Apply the setting; cheap enough to call on every tick (handles page swaps). */
  sync(enabled: boolean): void {
    const header = enabled ? this.find() : null;
    const on = enabled && !!header;
    if (on && !document.getElementById(STYLE_ID)) {
      const s = document.createElement("style");
      s.id = STYLE_ID;
      s.textContent = PAGE_CSS;
      document.head.appendChild(s);
    }
    this.tab.hidden = !on;
    if (on === this.enabled) return;
    this.enabled = on;
    document.documentElement.classList.toggle(HIDE, on);
    if (!on) this.setPeek(false);
    // The map fills the freed space; make sure MapLibre notices the new size.
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  private insideHeader(e: Event): boolean {
    const header = document.querySelector(`[${ATTR}]`);
    if (!header) return false;
    const path = e.composedPath();
    if (path.includes(header)) return true;
    // The account menu opens in a popover outside the header: keep the header while it's open.
    return path.some((n) => n instanceof Element && n.closest('[role="menu"], [role="listbox"], [data-rac][data-placement]'));
  }

  private scheduleHide() {
    if (this.hideTimer) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      const header = document.querySelector(`[${ATTR}]`);
      // Don't yank it away while one of its menus is open.
      if (header?.querySelector('[aria-expanded="true"]')) return;
      if (!this.pinned) this.setPeek(false);
    }, HIDE_DELAY_MS);
  }

  private setPeek(on: boolean) {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    document.documentElement.classList.toggle(PEEK, on && this.enabled);
    this.tab.classList.toggle("open", on && this.enabled);
    this.tab.title = on ? "Hide the site header" : "Show the site header";
  }

  destroy(): void {
    for (const d of this.disposers) d();
    clearTimeout(this.hideTimer);
    document.documentElement.classList.remove(HIDE, PEEK);
    document.querySelector(`[${ATTR}]`)?.removeAttribute(ATTR);
    document.getElementById(STYLE_ID)?.remove();
  }
}
