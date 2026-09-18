/** Bounded, process-local LRU cache. Reads never extend a record's freshness. */
export function createTtlCache(ttlSeconds, { maxEntries = 256, maxBytes = 8 * 1024 * 1024 } = {}) {
  const store = new Map();
  let bytes = 0;
  function remove(key) {
    const rec = store.get(key);
    if (rec) bytes -= rec.bytes;
    store.delete(key);
  }
  return {
    get(key) {
      const rec = store.get(key);
      if (!rec) return undefined;
      if (rec.expiresAt <= Date.now()) {
        remove(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, rec);
      return rec.value;
    },
    set(key, value, lifetimeSeconds = ttlSeconds) {
      remove(key);
      if (!(lifetimeSeconds > 0) || maxEntries <= 0 || maxBytes <= 0) return;
      // Purge expired entries even when nobody asks for the same key again.
      const now = Date.now();
      for (const [existingKey, rec] of store) if (rec.expiresAt <= now) remove(existingKey);
      const size = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
      if (size > maxBytes) return;
      while (store.size >= maxEntries || bytes + size > maxBytes) remove(store.keys().next().value);
      store.set(key, { value, expiresAt: now + lifetimeSeconds * 1000, bytes: size });
      bytes += size;
    },
  };
}
