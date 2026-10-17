// Downloads the Safe Zone map's client bundles and makes them readable, so protocol
// changes can be diffed after the site redeploys.
//
//   npm run site:pull            -> .site/raw/*.js  (as served)
//                                   .site/clean/*.js (deobfuscated + proxy-inlined)
//
// Start reading at .site/clean/cx-client.*.js — search for "public-map-ws",
// "Unsupported binary kind" (binary decoder) and "map-snapshot".
import fs from "node:fs";
import path from "node:path";
import { webcrack } from "webcrack";
import { inlineProxies } from "./inline-proxies.mjs";

const ORIGIN = "https://iceposeidon.com";
const PAGES = ["/safezone/map", "/safezone"];
const root = path.resolve(import.meta.dirname, "../../.site");
const rawDir = path.join(root, "raw");
const cleanDir = path.join(root, "clean");
fs.mkdirSync(rawDir, { recursive: true });
fs.mkdirSync(cleanDir, { recursive: true });

const UA = { "User-Agent": "Mozilla/5.0 (SafeZone+ protocol research)" };
const chunkRe = /(?:["'(]|^)(\/_astro\/[\w.@-]+\.js|\.\/[\w.@-]+\.js)["')]/gm;

const queue = new Set();
for (const page of PAGES) {
  const html = await (await fetch(ORIGIN + page, { headers: UA })).text();
  fs.writeFileSync(path.join(root, `${page.replaceAll("/", "_") || "_index"}.html`), html);
  for (const m of html.matchAll(/\/_astro\/[\w.@-]+\.js/g)) queue.add(m[0]);
}

const done = new Set();
while (queue.size) {
  const [p] = queue;
  queue.delete(p);
  if (done.has(p)) continue;
  done.add(p);
  const res = await fetch(ORIGIN + p, { headers: UA });
  if (!res.ok) {
    console.warn("skip", p, res.status);
    continue;
  }
  const code = await res.text();
  fs.writeFileSync(path.join(rawDir, path.basename(p)), code);
  for (const m of code.matchAll(chunkRe)) queue.add(m[1].startsWith("./") ? `/_astro/${m[1].slice(2)}` : m[1]);
}
console.log(`downloaded ${done.size} chunks → ${path.relative(process.cwd(), rawDir)}`);

for (const file of fs.readdirSync(rawDir)) {
  const src = fs.readFileSync(path.join(rawDir, file), "utf8");
  if (!/_0x[0-9a-f]{4,}/.test(src)) continue; // not obfuscated (react, maplibre, ...)
  const t0 = Date.now();
  try {
    const { code } = await webcrack(src, { unpack: false, deobfuscate: true, unminify: true, mangle: false });
    const { code: clean, inlined } = inlineProxies(code);
    fs.writeFileSync(path.join(cleanDir, file), clean);
    console.log(`clean ${file} (${inlined} proxy objects, ${Date.now() - t0} ms)`);
  } catch (e) {
    console.warn(`failed ${file}: ${e.message}`);
  }
}
