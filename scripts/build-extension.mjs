// Builds the unpacked extension into extension/dist (load it via chrome://extensions → Load unpacked).
//   node scripts/build-extension.mjs [--watch]
import { context, build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const ext = path.join(root, "extension");
const out = path.join(ext, "dist");
const watch = process.argv.includes("--watch");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "icons"), { recursive: true });
fs.copyFileSync(path.join(ext, "manifest.json"), path.join(out, "manifest.json"));
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, "icons", `icon${size}.png`), drawIcon(size));

const options = {
  entryPoints: {
    content: path.join(ext, "src/content/index.ts"),
    bridge: path.join(ext, "src/bridge.ts"),
    background: path.join(ext, "src/background.ts"),
  },
  outdir: out,
  bundle: true,
  format: "iife",
  target: "chrome111",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching… reload the extension in chrome://extensions after changes");
} else {
  await build(options);
  console.log(`built → ${path.relative(root, out)}`);
}

// ---------------------------------------------------------------- icon (tiny PNG encoder)

function drawIcon(size) {
  const ss = 4; // supersampling for anti-aliasing
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const radius = size * 0.13; // rounded-square corner radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss;
          const fy = y + (sy + 0.5) / ss;
          if (!inRoundedSquare(fx, fy, size, radius)) continue;
          const d = Math.hypot(fx - c, fy - c);
          let col = [12, 12, 16];
          if (Math.abs(d - size * 0.32) < size * 0.065) col = [34, 255, 0]; // zone ring
          else if (d < size * 0.11) col = [250, 204, 21]; // player dot
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      px[i] = a ? (r * 255) / a : 0;
      px[i + 1] = a ? (g * 255) / a : 0;
      px[i + 2] = a ? (b * 255) / a : 0;
      px[i + 3] = a / n;
    }
  }
  return encodePng(size, size, px);
}

function inRoundedSquare(x, y, s, r) {
  const dx = Math.max(r - x, 0, x - (s - r));
  const dy = Math.max(r - y, 0, y - (s - r));
  return dx * dx + dy * dy <= r * r;
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c;
}
