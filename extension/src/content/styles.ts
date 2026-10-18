export const CSS = /* css */ `
:host {
  all: initial;
  --bg: rgba(10, 10, 12, 0.88);
  --line: rgba(255, 255, 255, 0.12);
  --text: #f4f4f5;
  --muted: #a1a1aa;
  --dim: #71717a;
  --zone: #22ff00;
  --ok: #4ade80;
  --warn: #facc15;
  --bad: #f87171;
  --live: #ef4444;
  --accent: #38bdf8;
}
* { box-sizing: border-box; }
/* Author display rules (e.g. .settings { display: grid }) would otherwise beat the hidden attribute. */
[hidden] { display: none !important; }
.panel {
  position: fixed; z-index: 2147483000; width: 360px; max-height: min(78vh, 760px);
  display: flex; flex-direction: column;
  font: 13px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text);
  background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,.45); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  overflow: hidden;
}
.panel.collapsed { width: auto; max-height: none; }
.panel.collapsed > :not(header) { display: none !important; }
header {
  display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px;
  border-bottom: 1px solid var(--line); cursor: grab; user-select: none;
}
.panel.collapsed header { border-bottom: 0; }
header:active { cursor: grabbing; }
.brand { font-weight: 700; letter-spacing: .2px; }
.brand b { color: var(--zone); }
.conn { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
.conn.live { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.conn.reconnecting, .conn.connecting { background: var(--warn); }
.hstats { color: var(--muted); font-size: 12px; margin-left: auto; white-space: nowrap; }
.hstats .n { color: var(--text); font-weight: 600; }
.icon-btn {
  all: unset; display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px;
  color: var(--muted); cursor: pointer; flex: none;
}
.icon-btn:hover { background: rgba(255,255,255,.08); color: var(--text); }
.icon-btn:focus-visible { outline: 2px solid var(--accent); }
.icon-btn[disabled] { opacity: .3; cursor: default; background: none; }
.icon-btn.on { color: var(--warn); }
.icon-btn.on-accent { color: var(--accent); background: rgba(56,189,248,.12); }
svg { width: 16px; height: 16px; display: block; }

.banner { padding: 8px 12px; font-size: 12px; border-bottom: 1px solid var(--line); background: rgba(250,204,21,.1); color: #fde68a; }
.banner.bad { background: rgba(248,113,113,.12); color: #fecaca; }
.update {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px 7px 12px; font-size: 12px;
  border-bottom: 1px solid var(--line); background: rgba(34,255,0,.08); color: #d9f99d;
}
.update[hidden] { display: none; }
.update > span { flex: 1 1 auto; min-width: 0; }
.update .pbtn { flex: none; }
.about { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.about > span { flex: 1 1 100%; }

/* Calm stand-in for the site's EMP animation: a static frame round the map and a countdown. */
.emp-frame {
  position: fixed; z-index: 2147482900; pointer-events: none;
  box-shadow: inset 0 0 0 2px rgba(96,165,250,.75), inset 0 0 70px rgba(59,130,246,.28);
}
.emp-pill {
  position: fixed; z-index: 2147482905; transform: translateX(-50%); pointer-events: auto; cursor: default;
  padding: 5px 12px; border-radius: 999px; white-space: nowrap;
  font: 600 13px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #dbeafe;
  background: rgba(15, 23, 42, .88); border: 1px solid rgba(96,165,250,.8); box-shadow: 0 4px 18px rgba(0,0,0,.45);
  font-variant-numeric: tabular-nums;
}
.hstats .emp { color: #93c5fd; font-weight: 600; font-variant-numeric: tabular-nums; }

/* Pull tab that brings the site's hidden header back. */
.hdr-tab {
  position: fixed; z-index: 2147482995; top: 0; left: 50%; transform: translateX(-50%);
  width: 46px; height: 16px; padding: 0; display: grid; place-items: center; cursor: pointer;
  color: var(--muted); background: var(--bg); border: 1px solid var(--line); border-top: 0;
  border-radius: 0 0 10px 10px; opacity: .55; transition: opacity .15s, top .18s ease;
}
.hdr-tab:hover, .hdr-tab.open { opacity: 1; color: var(--text); }
.hdr-tab svg { width: 14px; height: 14px; }
.hdr-tab.open svg { transform: rotate(180deg); }
.banner.warn { background: rgba(56,189,248,.12); color: #bae6fd; }

.tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--line); }
.tab { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px 8px 0 0; color: var(--muted); font-weight: 600; font-size: 12px; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); box-shadow: inset 0 -2px 0 var(--zone); }
.badge { display: inline-block; min-width: 16px; padding: 0 5px; margin-left: 4px; border-radius: 999px; background: var(--live); color: #fff; font-size: 10px; line-height: 16px; text-align: center; }

.search { padding: 10px 10px 6px; position: relative; }
.search input {
  width: 100%; padding: 8px 34px 8px 32px; border-radius: 10px; border: 1px solid var(--line);
  background: rgba(255,255,255,.06); color: var(--text); font: inherit; outline: none;
}
.search input:focus { border-color: rgba(56,189,248,.6); background: rgba(255,255,255,.09); }
.search .field { position: relative; }
.search .lens { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--dim); display: grid; pointer-events: none; }
.search kbd { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font: 11px/16px ui-monospace, monospace; color: var(--dim); border: 1px solid var(--line); border-radius: 5px; padding: 0 5px; pointer-events: none; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 2px 10px 8px; }
.chip { all: unset; cursor: pointer; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.chip:hover { color: var(--text); border-color: rgba(255,255,255,.25); }
.chip.active { color: #000; background: var(--zone); border-color: var(--zone); font-weight: 600; }
.chip .c { opacity: .7; margin-left: 3px; }

.list { overflow-y: auto; flex: 1 1 auto; min-height: 60px; padding: 2px 6px 8px; overscroll-behavior: contain; }
.list::-webkit-scrollbar { width: 8px; }
.list::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 8px; }
.section { padding: 8px 6px 4px; color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
.empty { padding: 18px 12px; color: var(--muted); text-align: center; }

.row { display: flex; flex-wrap: wrap; gap: 0 9px; padding: 7px 6px; border-radius: 10px; cursor: pointer; align-items: flex-start; }
/* Expanded details take the full row width, below avatar, name and buttons. */
.row > .more { flex: 0 0 100%; min-width: 0; }
.row > .more .details { margin-top: 7px; cursor: auto; }
.row:hover { background: rgba(255,255,255,.05); }
.row.focus { background: rgba(56,189,248,.1); box-shadow: inset 2px 0 0 var(--accent); }
.row.dead .name { color: var(--muted); text-decoration: line-through; }
.av { width: 32px; height: 32px; border-radius: 50%; flex: none; background: #27272a center/cover; display: grid; place-items: center; font-weight: 700; color: var(--muted); overflow: hidden; }
.av img { width: 100%; height: 100%; object-fit: cover; }
.body { flex: 1 1 0; min-width: 0; }
.l1 { display: flex; align-items: center; gap: 6px; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live { color: var(--live); font-size: 11px; font-weight: 700; white-space: nowrap; }
.offline { color: var(--dim); font-size: 11px; }
.l2 { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; }
.hp { width: 54px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.12); overflow: hidden; flex: none; }
.hp i { display: block; height: 100%; border-radius: 3px; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .dim { color: var(--dim); }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.tag { font-size: 11px; padding: 0 6px; border-radius: 6px; background: rgba(255,255,255,.07); color: var(--muted); line-height: 17px; }
.tag.bad { background: rgba(248,113,113,.15); color: #fecaca; }
.tag.warn { background: rgba(250,204,21,.13); color: #fde68a; }
.actions { display: flex; gap: 1px; flex: none; }
.details { margin-top: 6px; padding: 7px 8px; border-radius: 8px; background: rgba(255,255,255,.04); color: var(--muted); font-size: 12px; display: grid; gap: 3px; white-space: normal; }
.details a { color: var(--accent); text-decoration: none; }
.details a:hover { text-decoration: underline; }
.details .k { color: var(--dim); }
.btns { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
.pbtn {
  all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px;
  border-radius: 8px; border: 1px solid var(--line); color: var(--text); font-size: 12px; font-weight: 600;
  background: rgba(255,255,255,.05); text-decoration: none;
}
.pbtn:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.25); }
.pbtn.primary { background: #53fc18; border-color: #53fc18; color: #000; }
.pbtn.primary:hover { background: #6bff3a; }
.pbtn[disabled] { opacity: .35; cursor: default; }
.pbtn svg { width: 14px; height: 14px; }

/* Panel and stream window share a layer; the last one interacted with is raised. The
   map-anchored action bar always sits below both. */
.panel.front, .stream.front { z-index: 2147483001; }

/* Action bar shown under a player clicked on the map. */
.card {
  position: fixed; z-index: 2147482990; transform: translateX(-50%);
  display: flex; align-items: center; gap: 4px; padding: 5px 5px 5px 10px;
  font: 13px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text);
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 8px 26px rgba(0,0,0,.5); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  white-space: nowrap; animation: pop .15s ease-out;
}
.card::before {
  content: ""; position: absolute; top: -6px; left: 50%; width: 10px; height: 10px; transform: translateX(-50%) rotate(45deg);
  background: var(--bg); border-left: 1px solid var(--line); border-top: 1px solid var(--line);
}
.card .cname { font-weight: 700; max-width: 140px; overflow: hidden; text-overflow: ellipsis; margin-right: 4px; }
/* The same actions placed inside the site's own contestant card. */
.card.inline {
  position: static; transform: none; animation: none; box-shadow: none; flex-wrap: wrap;
  background: rgba(255,255,255,.05); backdrop-filter: none; -webkit-backdrop-filter: none;
}
.card.inline::before { display: none; }
.card.inline .cname { font-size: 12px; color: var(--muted); }
.card.inline .cname b { color: var(--zone); }

/* Contestant info (inventory, activity) in player details. */
.inv { display: flex; flex-wrap: wrap; gap: 4px; }
.inv span { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px 1px 2px; border-radius: 6px; background: rgba(255,255,255,.06); font-size: 11px; color: var(--text); }
.inv img { width: 18px; height: 18px; }
.act { display: grid; gap: 4px; max-height: 190px; overflow-y: auto; padding-right: 2px; }
.act > div { display: flex; gap: 6px; align-items: flex-start; color: var(--text); }
.act img, .act .noicon { width: 16px; height: 16px; flex: none; margin-top: 1px; }
.act .when { margin-left: auto; padding-left: 6px; color: var(--dim); font-size: 11px; white-space: nowrap; }
.act .attack > span:first-of-type { color: var(--warn); }
.act .damage > span:first-of-type { color: var(--bad); }
@keyframes pop { from { opacity: 0; transform: translateX(-50%) translateY(-4px); } }

.alerts { overflow-y: auto; flex: 1 1 auto; padding: 6px 8px 10px; }
.alert { display: flex; gap: 8px; padding: 7px 6px; border-radius: 8px; cursor: pointer; }
.alert:hover { background: rgba(255,255,255,.05); }
.alert .t { color: var(--dim); font-size: 11px; flex: none; width: 56px; padding-top: 1px; }
.alert.danger .m { color: #fecaca; } .alert.warn .m { color: #fde68a; }

.toasts { position: absolute; left: 8px; right: 8px; bottom: 8px; display: grid; gap: 6px; pointer-events: none; }
.toast { pointer-events: auto; padding: 8px 10px; border-radius: 10px; background: #18181b; border: 1px solid var(--line); box-shadow: 0 6px 20px rgba(0,0,0,.4); font-size: 12px; cursor: pointer; animation: in .18s ease-out; }
.toast.danger { border-color: rgba(248,113,113,.6); } .toast.warn { border-color: rgba(250,204,21,.5); }
@keyframes in { from { transform: translateY(6px); opacity: 0; } }

.settings { overflow-y: auto; padding: 10px 12px 14px; display: grid; gap: 12px; }
.settings h4 { margin: 0 0 6px; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .6px; }
.settings label { display: flex; align-items: center; gap: 8px; padding: 3px 0; color: var(--text); cursor: pointer; }
.settings select, .settings input[type=range] { font: inherit; color: var(--text); background: #18181b; border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px; }
.settings .hint { color: var(--dim); font-size: 12px; }
.btn { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.btn:hover { color: var(--text); border-color: rgba(255,255,255,.25); }

/* Floating stream window */
.stream {
  position: fixed; z-index: 2147483000; min-width: 240px; border-radius: 12px; overflow: hidden;
  background: #000; border: 1px solid var(--line); box-shadow: 0 14px 44px rgba(0,0,0,.55);
  font: 12px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text);
}
.stream .sbar { display: flex; align-items: center; gap: 2px; padding: 4px 4px 4px 10px; background: var(--bg); cursor: grab; user-select: none; }
.stream .sbar:active { cursor: grabbing; }
.stream .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.stream a.icon-btn { text-decoration: none; }
.stream iframe { display: block; width: 100%; aspect-ratio: 16 / 9; border: 0; background: #000; }
.stream.dragging iframe { pointer-events: none; }
.stream .sresize {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, rgba(255,255,255,.35) 50% 60%, transparent 60% 70%, rgba(255,255,255,.35) 70% 80%, transparent 80%);
}
.zmove { color: var(--zone); }
`;
