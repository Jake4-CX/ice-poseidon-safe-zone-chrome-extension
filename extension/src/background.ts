/**
 * Service worker: Kick API lookups (content scripts can't make cross-origin requests),
 * desktop notifications, and the toolbar button.
 */
import { fetchKickChannel, type KickChannelInfo } from "../../src/core/kick.js";
import type { KickResponse, ToBackground } from "./shared.js";

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
