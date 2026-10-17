import type { MapSnapshotResponse } from "./messages.js";
import { ResyncRequired, SafeZoneState } from "./state.js";

export const PUBLIC_API = "https://event-public.iceposeidon.com";
export const PUBLIC_MAP_WS = "wss://event-public.iceposeidon.com/public-map-ws";
export const MAP_SNAPSHOT_URL = `${PUBLIC_API}/event/map-snapshot`;

export type ConnectionStatus = "idle" | "connecting" | "live" | "reconnecting" | "closed";

export interface SafeZoneClientOptions {
  url?: string;
  snapshotUrl?: string | null;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  /** Reconnect when no message (incl. heartbeats) arrives for this long. */
  silenceTimeoutMs?: number;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  /** Observe every raw frame (useful for capture/debugging). */
  onRawFrame?: (frame: string | ArrayBuffer) => void;
  state?: SafeZoneState;
}

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function fetchSnapshotFrames(url = MAP_SNAPSHOT_URL, fetchImpl: typeof fetch = fetch): Promise<(string | ArrayBuffer)[]> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`map-snapshot HTTP ${res.status}`);
  const body = (await res.json()) as MapSnapshotResponse;
  return body.frames.map((f) => ("text" in f ? f.text : decodeBase64(f.binary)));
}

/**
 * Connects to the public map socket and keeps a SafeZoneState up to date.
 * Works in browsers and Node >= 22 (global WebSocket + fetch).
 */
export class SafeZoneClient {
  readonly state: SafeZoneState;
  status: ConnectionStatus = "idle";

  private opts: Required<Omit<SafeZoneClientOptions, "onStatus" | "onRawFrame" | "state" | "snapshotUrl">> &
    Pick<SafeZoneClientOptions, "onStatus" | "onRawFrame" | "snapshotUrl">;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setInterval> | undefined;
  private gotSocketMessage = false;
  private lastMessageAt = 0;

  constructor(options: SafeZoneClientOptions = {}) {
    this.state = options.state ?? new SafeZoneState();
    this.opts = {
      url: options.url ?? PUBLIC_MAP_WS,
      snapshotUrl: options.snapshotUrl === undefined ? MAP_SNAPSHOT_URL : options.snapshotUrl,
      WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      silenceTimeoutMs: options.silenceTimeoutMs ?? 45_000,
      onStatus: options.onStatus,
      onRawFrame: options.onRawFrame,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.gotSocketMessage = false;
    if (this.opts.snapshotUrl) {
      // Paint quickly from the CDN snapshot, unless the socket beats it.
      fetchSnapshotFrames(this.opts.snapshotUrl, this.opts.fetchImpl)
        .then((frames) => {
          if (this.stopped || this.gotSocketMessage) return;
          try {
            this.state.ingestAll(frames);
          } catch {
            /* the socket will provide a clean baseline */
          }
          this.state.resetStreams();
        })
        .catch(() => {});
    }
    this.connect();
    this.silenceTimer = setInterval(() => {
      if (this.ws && this.lastMessageAt && Date.now() - this.lastMessageAt > this.opts.silenceTimeoutMs) {
        this.retire("silent");
      }
    }, 5_000);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.silenceTimer);
    this.detach(true);
    this.setStatus("closed");
  }

  private setStatus(s: ConnectionStatus, detail?: string) {
    this.status = s;
    this.opts.onStatus?.(s, detail);
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new this.opts.WebSocketImpl(this.opts.url);
    } catch (e) {
      this.scheduleRetry(String(e));
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.lastMessageAt = Date.now();
    let fresh = true;
    ws.onmessage = (ev: MessageEvent) => {
      this.lastMessageAt = Date.now();
      this.gotSocketMessage = true;
      if (fresh) {
        fresh = false;
        this.state.resetStreams();
      }
      const data = ev.data as string | ArrayBuffer;
      this.opts.onRawFrame?.(data);
      try {
        this.state.ingest(data);
        if (this.status !== "live") {
          this.attempt = 0;
          this.setStatus("live");
        }
      } catch (e) {
        if (e instanceof ResyncRequired) this.retire(e.message);
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.detach(false);
      this.scheduleRetry(`closed ${ev.code}`);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.detach(true);
      this.scheduleRetry("error");
    };
  }

  /** Drop the current socket and reconnect immediately for a fresh baseline. */
  private retire(reason: string) {
    this.detach(true);
    this.scheduleRetry(reason, 250);
  }

  private detach(close: boolean) {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    if (close) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleRetry(reason: string, fixedDelay?: number) {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    // Full-jitter exponential backoff, capped at 30s (like the site).
    const delay = fixedDelay ?? Math.floor(Math.random() * Math.min(30_000, 1_000 * 2 ** this.attempt));
    this.attempt++;
    this.setStatus("reconnecting", reason);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
