/**
 * Tiny in-memory TTL cache to conserve AroFlo's 2000-calls/day limit.
 * Keys are job + optional verification-detail lookups; values are the service result.
 */
export function createTtlCache(ttlSeconds) {
  const ttlMs = ttlSeconds * 1000;
  const store = new Map(); // key -> { value, expiresAt }

  return {
    get(key) {
      const rec = store.get(key);
      if (!rec) return undefined;
      if (rec.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return rec.value;
    },
    set(key, value) {
      if (ttlMs <= 0) return;
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}
