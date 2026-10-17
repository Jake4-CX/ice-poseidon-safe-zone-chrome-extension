import type { Alert } from "../../../src/core/index.js";

const CSS = /* css */ `
:host { all: initial; }
.stack { display: grid; gap: 6px; width: min(320px, calc(100vw - 40px)); }
.toast {
  display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; cursor: pointer;
  font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #f4f4f5;
  background: rgba(10, 10, 12, 0.86); border: 1px solid rgba(255,255,255,.12); border-left-width: 3px;
  box-shadow: 0 6px 20px rgba(0,0,0,.4); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  animation: in .2s ease-out; transition: opacity .3s;
}
.toast:hover { background: rgba(24, 24, 27, 0.95); }
.toast.info { border-left-color: #38bdf8; }
.toast.warn { border-left-color: #facc15; }
.toast.danger { border-left-color: #f87171; }
.toast .t { margin-left: auto; color: #71717a; font-size: 11px; flex: none; }
.toast.out { opacity: 0; }
@keyframes in { from { transform: translateX(-8px); opacity: 0; } }
`;

const LIFETIME_MS = 8000;
const MAX = 4;

/** Alert toasts docked in the map's top-left control corner, under the site's own controls. */
export class MapToasts {
  private host: HTMLDivElement | null = null;
  private stack: HTMLDivElement | null = null;

  constructor(private onClick: (userId: string) => void) {}

  private ensure(): boolean {
    if (this.host?.isConnected) return true;
    const map = [...document.querySelectorAll<HTMLElement>(".maplibregl-map")].sort(
      (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
    )[0];
    const corner = map?.querySelector(".maplibregl-ctrl-top-left");
    if (!corner) return false;
    this.host = document.createElement("div");
    this.host.className = "maplibregl-ctrl"; // MapLibre gives controls margins + pointer events
    this.host.style.clear = "both";
    const root = this.host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="stack" role="log" aria-live="polite"></div>`;
    this.stack = root.querySelector(".stack");
    this.stack!.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-user]");
      if (!el) return;
      el.remove();
      this.onClick(el.dataset.user!);
    });
    corner.appendChild(this.host);
    return true;
  }

  /** Returns false when the map isn't on the page (caller can fall back). */
  show(a: Alert): boolean {
    if (!this.ensure()) return false;
    const el = document.createElement("div");
    el.className = `toast ${a.severity}`;
    el.dataset.user = a.userId;
    el.title = "Show on map";
    const msg = document.createElement("span");
    msg.textContent = a.message;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.append(msg, t);
    this.stack!.prepend(el);
    while (this.stack!.childElementCount > MAX) this.stack!.lastElementChild!.remove();
    setTimeout(() => el.classList.add("out"), LIFETIME_MS - 300);
    setTimeout(() => el.remove(), LIFETIME_MS);
    return true;
  }

  destroy(): void {
    this.host?.remove();
    this.host = this.stack = null;
  }
}
