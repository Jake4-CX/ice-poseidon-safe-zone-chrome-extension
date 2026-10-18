// Builds the extension and zips extension/dist into release/safezone-plus-v<version>.zip,
// ready to attach to a GitHub release. The manifest sits at the zip's root, so users can
// unzip it and point chrome://extensions → Load unpacked at the folder.
//   node scripts/package-extension.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "extension", "dist");
execFileSync(process.execPath, [path.join(root, "scripts", "build-extension.mjs")], { stdio: "inherit" });

const { version } = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
const outDir = path.join(root, "release");
const outFile = path.join(outDir, `safezone-plus-v${version}.zip`);
fs.mkdirSync(outDir, { recursive: true });

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else files.push({ name: path.relative(dist, abs).split(path.sep).join("/"), data: fs.readFileSync(abs) });
  }
})(dist);

fs.writeFileSync(outFile, zip(files));
console.log(`packaged ${files.length} files → ${path.relative(root, outFile)}`);

// version.json (repo root) is what installed copies poll for updates. Keep its version in step
// with the manifest; commit it only once the GitHub release with this zip is published.
const versionFile = path.join(root, "version.json");
const info = fs.existsSync(versionFile) ? JSON.parse(fs.readFileSync(versionFile, "utf8")) : {};
if (info.version !== version) {
  const next = { version, released: new Date().toISOString().slice(0, 10), notes: "", download: info.download ?? "https://github.com/Jake4-CX/ice-poseidon-safe-zone-chrome-extension/releases/latest" };
  fs.writeFileSync(versionFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`version.json → ${version}: add release notes, then commit it after publishing the release`);
}

// Minimal ZIP writer (deflate, no extra fields). Timestamps are fixed so rebuilds are byte-identical.
function zip(entries) {
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const common = (b, o) => {
      b.writeUInt16LE(20, o);            // version needed
      b.writeUInt16LE(0x0800, o + 2);    // flags: UTF-8 names
      b.writeUInt16LE(8, o + 4);         // deflate
      b.writeUInt16LE(DOS_TIME, o + 6);
      b.writeUInt16LE(DOS_DATE, o + 8);
      b.writeUInt32LE(crc, o + 10);
      b.writeUInt32LE(packed.length, o + 14);
      b.writeUInt32LE(data.length, o + 18);
      b.writeUInt16LE(nameBuf.length, o + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    common(local, 4);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    common(central, 6);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
