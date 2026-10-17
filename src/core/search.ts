/** Small dependency-free fuzzy matcher for player names. Higher score = better. */

const normalize = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

export function fuzzyScore(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q) return 0;
  if (!c) return -1;
  if (c === q) return 1000;
  if (c.startsWith(q)) return 800 - (c.length - q.length);
  const idx = c.indexOf(q);
  if (idx >= 0) return 600 - idx * 5 - (c.length - q.length);
  // Subsequence match with gap penalties ("icpsdn" -> "iceposeidon").
  let score = 300;
  let ci = 0;
  let last = -1;
  for (const ch of q) {
    const found = c.indexOf(ch, ci);
    if (found < 0) return -1;
    if (last >= 0) score -= (found - last - 1) * 4;
    last = found;
    ci = found + 1;
  }
  return Math.max(1, score - (c.length - q.length));
}

export function fuzzySearch<T>(items: Iterable<T>, query: string, key: (item: T) => string, limit = 20): T[] {
  if (!query.trim()) return [];
  return [...items]
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
