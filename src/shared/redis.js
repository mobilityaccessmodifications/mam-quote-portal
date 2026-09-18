/** Minimal Redis REST transport. Never include provider bodies/tokens in errors. */
export class SharedStoreError extends Error {
  constructor() { super('Shared coordination is unavailable'); this.code = 'shared_unavailable'; }
}
export class RedisRest {
  constructor({ url, token, timeoutMs = 3000 }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Shared Redis requires a credential-free HTTPS endpoint');
    }
    this.url = parsed.href; this.token = token; this.timeoutMs = timeoutMs;
  }
  async command(args) {
    try {
      const response = await fetch(this.url, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new SharedStoreError();
      const data = await response.json();
      if (data.error || !Object.hasOwn(data, 'result')) throw new SharedStoreError();
      return data.result;
    } catch { throw new SharedStoreError(); }
  }
  eval(script, keys, args = []) { return this.command(['EVAL', script, keys.length, ...keys, ...args.map(String)]); }
}
