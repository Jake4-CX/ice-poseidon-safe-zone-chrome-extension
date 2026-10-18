/**
 * Optionally replaces the site's EMP/smoke animation (lightning bolts, flashes, scanlines and a
 * flickering, warping map) with a calm, static indicator: a blue frame around the map and a
 * countdown pill, so it's still obvious a blackout is on.
 *
 * The site's effect is a CSS-module overlay (`._storm_<hash>`) plus classes it adds to the map
 * canvas/container (`_shocked_`, `_humming_`, `_bursting_`, `_displaced_`). Hashes change between
 * deploys, so we match on the class-name prefix.
 */
const STYLE_ID = "szp-emp-style";
const CALM = "szp-calm-emp";

const PAGE_CSS = `
html.${CALM} [class*="_storm_"] { display: none !important; }
html.${CALM} [class*="_shocked_"],
html.${CALM} [class*="_displaced_"] { filter: none !important; animation: none !important; }
`;

export interface Blackout {
  until: string;
  source: string;
}

export class EmpEffect {
  constructor(
    private frame: HTMLElement,
    private pill: HTMLElement,
  ) {}

  /** Call every second: toggles the site's animation and positions/updates our indicator. */
  sync(calm: boolean, blackout: Blackout | null, now: number): void {
    const until = blackout ? Date.parse(blackout.until) : 0;
    const active = !!blackout && until > now;
    const on = calm && active;
    if (calm && !document.getElementById(STYLE_ID)) {
      const s = document.createElement("style");
      s.id = STYLE_ID;
      s.textContent = PAGE_CSS;
      document.head.appendChild(s);
    }
    document.documentElement.classList.toggle(CALM, calm);
    const rect = on ? mapRect() : null;
    this.frame.hidden = this.pill.hidden = !rect;
    if (!rect || !blackout) return;
    for (const el of [this.frame]) {
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
    }
    this.pill.style.left = `${rect.left + rect.width / 2}px`;
    this.pill.style.top = `${rect.top + 10}px`;
    const what = blackout.source === "smoke" ? "Smoke blackout" : "EMP blackout";
    this.pill.textContent = `⚡ ${what} · ends in ${countdown(until - now)}`;
    this.pill.title = `The map is blacked out until ${new Date(until).toLocaleTimeString()}. SafeZone+ turned off the site's flashing effect (Settings → Blackouts).`;
  }

  destroy(): void {
    document.documentElement.classList.remove(CALM);
    document.getElementById(STYLE_ID)?.remove();
    this.frame.hidden = this.pill.hidden = true;
  }
}

/** "4:07", or "1:02:07" for long ones. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Screen box of the site's (largest) MapLibre map. */
function mapRect(): DOMRect | null {
  let best: DOMRect | null = null;
  for (const el of document.querySelectorAll(".maplibregl-map")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (!best || r.width * r.height > best.width * best.height)) best = r;
  }
  return best;
}
