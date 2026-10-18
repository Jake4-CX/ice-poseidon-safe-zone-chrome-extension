import { DEFAULT_SETTINGS, type Favourites, type Settings } from "../shared.js";
import type { StreamUi } from "./stream-window.js";

/** Favourites + settings in chrome.storage.sync (follows the user across devices). */
export class Store {
  favourites: Favourites = {};
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private listeners = new Set<() => void>();

  async load(): Promise<void> {
    const data = await chrome.storage.sync.get(["favourites", "settings"]);
    this.favourites = (data.favourites as Favourites | undefined) ?? {};
    this.settings = mergeSettings(data.settings as Partial<Settings> | undefined);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.favourites) this.favourites = (changes.favourites.newValue as Favourites | undefined) ?? {};
      if (changes.settings) this.settings = mergeSettings(changes.settings.newValue as Partial<Settings> | undefined);
      if (changes.favourites || changes.settings) this.emit();
    });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  isFavourite(userId: string): boolean {
    return userId in this.favourites;
  }

  async toggleFavourite(userId: string, username: string): Promise<void> {
    const next = { ...this.favourites };
    if (next[userId]) delete next[userId];
    else next[userId] = { username, addedAt: Date.now() };
    this.favourites = next;
    this.emit();
    await chrome.storage.sync.set({ favourites: next });
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    this.emit();
    await chrome.storage.sync.set({ settings: this.settings });
  }
}

function mergeSettings(saved: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    alertKinds: { ...DEFAULT_SETTINGS.alertKinds, ...saved?.alertKinds },
  };
}

/** Per-device UI state (panel position etc.) in chrome.storage.local. */
export interface UiState {
  x: number | null;
  y: number | null;
  collapsed: boolean;
  filter: string;
  stream: StreamUi;
  /** Update notice the user closed (shown again for newer versions). */
  dismissedUpdate: string | null;
}
const DEFAULT_UI: UiState = {
  x: null,
  y: null,
  collapsed: false,
  filter: "favourites",
  stream: { x: null, y: null, w: 400, pinned: false, muted: true },
  dismissedUpdate: null,
};

export async function loadUi(): Promise<UiState> {
  const { ui } = await chrome.storage.local.get("ui");
  const saved = ui as Partial<UiState> | undefined;
  return { ...DEFAULT_UI, ...saved, stream: { ...DEFAULT_UI.stream, ...saved?.stream } };
}
export function saveUi(ui: UiState): void {
  void chrome.storage.local.set({ ui });
}
