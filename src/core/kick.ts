/**
 * Kick helpers. Map slot usernames are Kick usernames (users log in with Kick), and the
 * slot avatar URL embeds the Kick user id: https://data.cx-live.com/v1/kick/avatars?id=<id>.
 * That lets us verify a guessed channel slug against https://kick.com/api/v2/channels/<slug>.
 */

export interface KickChannelInfo {
  slug: string;
  userId: number;
  username: string;
  live: boolean;
  viewers: number | null;
  title: string | null;
  thumbnailUrl: string | null;
  /** True when the channel's user id matched the id embedded in the map avatar URL. */
  verified: boolean;
}

/** Best-effort Kick slug from a username: lowercase, no spaces (underscores are kept). */
export function guessKickSlug(username: string): string {
  return username.trim().toLowerCase().replace(/\s+/g, "");
}

export function kickUserIdFromAvatar(avatarUrl: string | null | undefined): number | null {
  if (!avatarUrl) return null;
  try {
    const id = new URL(avatarUrl).searchParams.get("id");
    return id && /^\d+$/.test(id) ? Number(id) : null;
  } catch {
    return null;
  }
}

export const kickChannelUrl = (slug: string) => `https://kick.com/${encodeURIComponent(slug)}`;
export const kickPlayerUrl = (slug: string, muted = true) =>
  `https://player.kick.com/${encodeURIComponent(slug)}?autoplay=true&muted=${muted}`;

interface KickApiChannel {
  slug: string;
  user_id: number;
  user?: { username?: string };
  livestream: null | {
    is_live?: boolean;
    viewer_count?: number;
    session_title?: string;
    thumbnail?: { url?: string } | null;
  };
}

/**
 * Look up a channel via Kick's (unauthenticated) web API. Returns null when not found.
 * `expectedUserId` (from the avatar URL) is used to mark the match as verified.
 */
export async function fetchKickChannel(
  slug: string,
  expectedUserId: number | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<KickChannelInfo | null> {
  const res = await fetchImpl(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Kick API HTTP ${res.status}`);
  const ch = (await res.json()) as KickApiChannel;
  const ls = ch.livestream;
  return {
    slug: ch.slug,
    userId: ch.user_id,
    username: ch.user?.username ?? ch.slug,
    live: !!ls && ls.is_live !== false,
    viewers: ls?.viewer_count ?? null,
    title: ls?.session_title ?? null,
    thumbnailUrl: ls?.thumbnail?.url ?? null,
    verified: expectedUserId !== null && ch.user_id === expectedUserId,
  };
}
