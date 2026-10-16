// A short in-memory cache per Worker isolate, for lookups that every API request repeats (who a token
// belongs to, a board and your role on it). Back-to-back CLI commands then skip D1 entirely (FR-20).
// Entries live a minute at most, well inside the ten-minute access recheck (FR-2).

const TTL_MS = 60_000;
const MAX = 1_000;
const store = new Map<string, { value: unknown; until: number }>();

export async function memo<T>(key: string, load: () => Promise<T>, keep: (v: T) => boolean = v => v != null): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  const value = await load();
  if (keep(value)) {
    if (store.size >= MAX) store.delete(store.keys().next().value!);
    store.set(key, { value, until: Date.now() + TTL_MS });
  }
  return value;
}

/** Forget everything, e.g. after a token is revoked here. Other isolates catch up within a minute. */
export function clearMemo() {
  store.clear();
}
