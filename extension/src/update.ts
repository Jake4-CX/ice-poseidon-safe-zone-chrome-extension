/**
 * Update check: the published version lives in version.json at the root of the public repo.
 * Chrome won't auto-update an unpacked extension, so we can only tell people a new zip exists.
 */
import type { ReleaseInfo, UpdateStatus } from "./shared.js";

export const REPO_URL = "https://github.com/Jake4-CX/ice-poseidon-safe-zone-chrome-extension";
export const VERSION_URL = "https://raw.githubusercontent.com/Jake4-CX/ice-poseidon-safe-zone-chrome-extension/main/version.json";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
const CHECK_TTL_MS = 6 * 3_600_000;

/** Numeric dotted-version compare ("0.10.0" > "0.9.3"); pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function isReleaseInfo(x: unknown): x is ReleaseInfo {
  return !!x && typeof x === "object" && typeof (x as ReleaseInfo).version === "string" && /^v?\d+(\.\d+)*/.test((x as ReleaseInfo).version);
}

/** Only allow download links into this repo, so a bad version.json can't send people elsewhere. */
function safeDownload(url: string | undefined): string {
  return url && url.startsWith(`${REPO_URL}/`) ? url : RELEASES_URL;
}

export async function checkForUpdate(current: string, force = false, fetchImpl: typeof fetch = fetch): Promise<UpdateStatus> {
  const { updateCheck } = (await chrome.storage.local.get("updateCheck")) as { updateCheck?: UpdateStatus };
  if (!force && updateCheck && updateCheck.current === current && Date.now() - updateCheck.checkedAt < CHECK_TTL_MS) return updateCheck;
  let status: UpdateStatus;
  try {
    const res = await fetchImpl(VERSION_URL, { cache: force ? "no-cache" : "default" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: unknown = await res.json();
    if (!isReleaseInfo(json)) throw new Error("malformed version.json");
    const latest: ReleaseInfo = {
      version: json.version.replace(/^v/i, ""),
      released: typeof json.released === "string" ? json.released : undefined,
      notes: typeof json.notes === "string" ? json.notes.slice(0, 300) : undefined,
      download: safeDownload(json.download),
    };
    status = { current, latest, available: compareVersions(latest.version, current) > 0, checkedAt: Date.now() };
  } catch (e) {
    // Keep the last good answer; retry sooner than the normal TTL.
    status = {
      current,
      latest: updateCheck?.latest ?? null,
      available: !!updateCheck?.latest && compareVersions(updateCheck.latest.version, current) > 0,
      checkedAt: Date.now() - CHECK_TTL_MS + 30 * 60_000,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  await chrome.storage.local.set({ updateCheck: status });
  return status;
}
