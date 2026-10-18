/**
 * Service worker: Kick API lookups (content scripts can't make cross-origin requests),
 * desktop notifications, the toolbar button and the update check.
 */
import { fetchKickChannel, type KickChannelInfo } from "../../src/core/kick.js";
import type { KickResponse, ToBackground, UpdateStatus } from "./shared.js";
import { checkForUpdate } from "./update.js";

const MAP_URL = "https://iceposeidon.com/safezone/map";
const KICK_TTL_MS = 2 * 60_000;
const kickCache = new Map<string, { at: number; channel: KickChannelInfo | null }>();
const inflight = new Map<string, Promise<KickChannelInfo | null>>();
/** notification id -> tab that raised it */
const notificationTabs = new Map<string, number>();

async function kickLookup(slug: string, expectedUserId: number | null): Promise<KickChannelInfo | null> {
  const key = slug.toLowerCase();
  const hit = kickCache.get(key);
  if (hit && Date.now() - hit.at < KICK_TTL_MS) return hit.channel;
  let p = inflight.get(key);
  if (!p) {
    p = fetchKickChannel(key, expectedUserId).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const channel = await p;
  kickCache.set(key, { at: Date.now(), channel });
  return channel;
}

async function openMap(): Promise<void> {
  const [tab] = await chrome.tabs.query({ url: `${MAP_URL}*` });
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MAP_URL });
  }
}

chrome.runtime.onMessage.addListener((msg: ToBackground, sender, sendResponse) => {
  switch (msg.type) {
    case "kick":
      kickLookup(msg.slug, msg.expectedUserId).then(
        (channel) => sendResponse({ ok: true, channel } satisfies KickResponse),
        (e: Error) => sendResponse({ ok: false, error: e.message } satisfies KickResponse),
      );
      return true; // async response
    case "notify": {
      const id = `szp-${msg.id}-${Date.now()}`;
      if (sender.tab?.id !== undefined) notificationTabs.set(id, sender.tab.id);
      chrome.notifications.create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: msg.title,
        message: msg.message,
        priority: 1,
      });
      return false;
    }
    case "openMap":
      void openMap();
      return false;
    case "checkUpdate":
      updateCheck(msg.force).then(sendResponse, (e: Error) => sendResponse({ current: chrome.runtime.getManifest().version, latest: null, available: false, checkedAt: Date.now(), error: e.message } satisfies UpdateStatus));
      return true;
  }
  return false;
});

chrome.notifications.onClicked.addListener(async (id) => {
  const tabId = notificationTabs.get(id);
  notificationTabs.delete(id);
  chrome.notifications.clear(id);
  if (tabId === undefined) return openMap();
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    await openMap();
  }
});

chrome.action.onClicked.addListener(() => void openMap());

/** Check GitHub for a newer release and flag the toolbar icon when there is one. */
async function updateCheck(force = false): Promise<UpdateStatus> {
  const status = await checkForUpdate(chrome.runtime.getManifest().version, force);
  await chrome.action.setBadgeText({ text: status.available ? "NEW" : "" });
  if (status.available) {
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    await chrome.action.setTitle({ title: `SafeZone+ ${status.latest!.version} is available. Click to open the map.` });
  }
  return status;
}

chrome.runtime.onStartup.addListener(() => void updateCheck());
chrome.runtime.onInstalled.addListener(() => void updateCheck(true));
