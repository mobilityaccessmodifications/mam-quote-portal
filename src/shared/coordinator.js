import { createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { RedisRest, SharedStoreError } from './redis.js';
import * as scripts from './scripts.js';
import { dailyResetSeconds } from '../aroflo/limits.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class SharedLimitError extends Error {
  constructor(seconds) { super('Shared request budget is unavailable'); this.code = 'rate_limit'; this.retryAfter = Math.max(1, seconds); }
}
export class Coordinator {
  constructor({ redis, url, token, secret, scope = 'production', credentials = '', intervalMs = 600,
    dailyBudget = 1900, secondaryBudget = 19000, waitMs = 8000, leaseMs = 60000 }) {
    /** @type {RedisRest} */
    this.redis = redis || new RedisRest({ url, token });
    this.key = createHmac('sha256', secret).update('mam-quote-cache-encryption-v1').digest();
    this.prefix = `mam-quote:v2:${this.hash(scope)}:`;
    this.cachePrefix = this.prefix + this.hash(credentials) + ':';
    this.intervalMs = Math.max(600, intervalMs); this.dailyBudget = dailyBudget;
    this.secondaryBudget = secondaryBudget; this.waitMs = waitMs; this.leaseMs = leaseMs;
  }
  hash(text) { return createHmac('sha256', this.key).update(String(text)).digest('hex'); }
  seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  open(value) {
    try {
      const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
    } catch { throw new SharedStoreError(); }
  }
  async generation() { return String(await this.redis.eval("return redis.call('GET',KEYS[1])", [this.cachePrefix+'generation']) || '0'); }
  async invalidate() { await this.redis.command(['SET', this.cachePrefix + 'generation', randomUUID(), 'EX', 86400]); }
  async cached(key, ttl, load, { generation = 'stable' } = {}) {
    const base = this.cachePrefix + this.hash(`${generation}:${key}`), owner = randomUUID();
    const start = Date.now();
    while (Date.now() - start <= this.waitMs) {
      const result = await this.redis.eval(scripts.acquire, [base, base + ':lock', this.prefix+'metrics', this.cachePrefix+'pending'], [owner, this.leaseMs]);
      if (result[0] === 'busy') throw new SharedLimitError(1);
      if (result[0] === 'hit') return this.open(result[1]);
      if (result[0] === 'owner') {
        try {
          const value = await load();
          const seconds = typeof ttl === 'function' ? ttl(value) : ttl;
          await this.redis.eval(scripts.publish,
            [base, base + ':lock', this.cachePrefix + 'entries', this.cachePrefix + 'sizes', this.cachePrefix+'pending'],
            [owner, this.seal(value), Math.max(0, Math.floor(Math.min(3600, seconds) * 1000)), 256, 8 * 1024 * 1024, 3600000]);
          return value;
        } finally { await this.redis.eval(scripts.release, [base + ':lock', this.cachePrefix+'pending'], [owner]); }
      }
      await sleep(100 + Math.floor(Math.random() * 100));
    }
    throw new SharedLimitError(1);
  }
  async admit(category) {
    const start = Date.now();
    while (Date.now() - start <= this.waitMs) {
      const sentAt = Date.now();
      const result = await this.redis.eval(scripts.admit,
        [this.prefix+'cooldown', this.prefix+'next', this.prefix+'daily:'+category,
          this.prefix+'remaining:'+category, this.prefix+'metrics'],
        [this.intervalMs, category, category === 'secondary' ? this.secondaryBudget : this.dailyBudget, dailyResetSeconds()*1000]);
      if (result[0] === 'ok') {
        // Discard delayed grants so independent instances cannot release a burst
        // after a suspended process/network response. Reservations stay consumed.
        if (Date.now() - sentAt <= 500) return;
        continue;
      }
      if (result[0] === 'limited') throw new SharedLimitError(Math.ceil(result[1]/1000));
      await sleep(Math.max(1, Number(result[1])));
    }
    throw new SharedLimitError(1);
  }
  async observe(limits) {
    for (const [name, key] of [['dailyRemaining','ordinary'], ['secondaryDailyRemaining','secondary']]) {
      if (Number.isSafeInteger(limits[name])) await this.redis.eval(scripts.remaining,
        [this.prefix+'remaining:'+key], [limits[name], dailyResetSeconds()*1000]);
    }
  }
  async cooldown(seconds) { await this.redis.eval(scripts.cooldown, [this.prefix+'cooldown'], [seconds*1000]); }
  async usage() {
    const values = await this.redis.eval("return redis.call('HGETALL',KEYS[1])", [this.prefix+'metrics']);
    const result = {};
    for (let i=0; i<values.length; i+=2) {
      if (['admissions','ordinary','secondary','exempt','cacheHits'].includes(values[i])) result[values[i]]=Number(values[i+1]);
    }
    return result;
  }
  async limitIp(ip, windowSeconds) {
    const [count, ttl] = await this.redis.eval(scripts.ipLimit, [this.prefix+'ip:'+this.hash(ip)], [windowSeconds*1000]);
    return { count, retryAfter: Math.max(1, Math.ceil(ttl/1000)) };
  }
}
export function createCoordinator(cfg) {
  if (!cfg.shared?.enabled || cfg.mockMode) return null;
  return new Coordinator({ ...cfg.shared, secret: cfg.aroflo.secretKey,
    scope: `${cfg.shared.scope}:${cfg.aroflo.baseUrl}:${cfg.aroflo.orgEncoded}`,
    credentials: `${cfg.aroflo.uEncoded}:${cfg.aroflo.pEncoded}:${cfg.aroflo.accept}`,
    intervalMs: cfg.aroflo.minRequestIntervalMs });
}
