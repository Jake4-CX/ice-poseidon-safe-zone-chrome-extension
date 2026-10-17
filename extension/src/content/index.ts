/**
 * Content script entry. The site uses Astro view transitions (client-side navigation),
 * so the panel is mounted/unmounted on `astro:page-load` rather than only at load time.
 */
import { App } from "./app.js";

const MAP_PATH = /^\/safezone\/map\/?$/;
let app: App | null = null;

function sync() {
  const onMap = MAP_PATH.test(location.pathname);
  if (onMap && !app) {
    app = new App();
    app.mount().catch((e) => console.error("[SafeZone+] failed to start", e));
  } else if (!onMap && app) {
    app.unmount();
    app = null;
  }
}

document.addEventListener("astro:page-load", sync);
sync();
