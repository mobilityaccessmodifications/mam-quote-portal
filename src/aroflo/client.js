import { createHmac } from 'node:crypto';
import { createTtlCache } from '../util/cache.js';
import { refreshUpdates } from './updates.js';
import { readRateLimits, dailyResetSeconds, retryAfterSeconds } from './limits.js';

/**
 * AroFlo API client.
 *
 * Implements the exact HMAC-SHA512 request signing that AroFlo documents in its
 * Postman pre-request script. Every request is individually signed.
 *
 * The signed payload is the following fields joined with "+", in this order:
 *   1. method            ("GET" | "POST")
 *   2. HostIP            (ONLY included if an IP is configured)
 *   3. urlPath           (always an empty string "")
 *   4. accept            ("text/json")
 *   5. Authorization     ("uencoded=..&pencoded=..&orgEncoded=.." — each value URI-encoded)
 *   6. afdatetimeutc     (ISO-8601 UTC timestamp, e.g. 2018-07-25T01:39:57.135Z)
 *   7. varString         (the query string WITHOUT a leading "?", e.g. "zone=Quotes&where=..")
 *
 * signature = HMAC_SHA512(payload, secretKey) as a lowercase hex string.
 *
 * Headers sent:
 *   Authentication: HMAC <signature>
 *   Authorization:  <the same Authorization string used in the payload>
 *   Accept:         text/json
 *   afdatetimeutc:  <the same timestamp used in the payload>
 *   HostIP:         <ip>   (only if configured)
 *
 * The request URL is `${baseUrl}?${varString}` — the varString in the URL must be
 * byte-for-byte identical to the one that was signed.
 */
export class ArofloClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} opts.secretKey
   * @param {string} opts.uEncoded
   * @param {string} opts.pEncoded
   * @param {string} opts.orgEncoded
   * @param {string} [opts.hostIp]
   * @param {string} [opts.accept]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.minRequestIntervalMs]
   * @param {number} [opts.cacheTtlSeconds] Completed-result TTL; default 0 (disabled).
   * @param {number} [opts.emptyCacheTtlSeconds] Empty-collection TTL; default 15.
 */
  constructor(opts) {
    this.baseUrl = opts.baseUrl || 'https://api.aroflo.com/';
    this.secretKey = opts.secretKey;
    this.uEncoded = opts.uEncoded;
    this.pEncoded = opts.pEncoded;
    this.orgEncoded = opts.orgEncoded;
    this.hostIp = (opts.hostIp || '').trim() || undefined;
    this.accept = opts.accept || 'text/json';
    this.timeoutMs = opts.timeoutMs || 30000;
    // AroFlo enforces a per-second request limit. Keep requests from this client
    // instance spaced by default; concurrent callers reserve their own slot.
    this.minRequestIntervalMs = Number.isFinite(opts.minRequestIntervalMs)
      ? Math.max(0, opts.minRequestIntervalMs)
      : 600;
    /** @type {import('../shared/coordinator.js').Coordinator | null} */
    this.shared = opts.coordinator || null;
    this.nextRequestAt = 0;
    this.slotQueue = Promise.resolve();
    this.cooldownUntil = 0;
    this.cacheTtlSeconds = opts.cacheTtlSeconds ?? 0; // recon scripts stay uncached
    this.emptyCacheTtlSeconds = Math.min(this.cacheTtlSeconds, opts.emptyCacheTtlSeconds ?? 15);
    this.cache = createTtlCache(this.cacheTtlSeconds);
    this.inFlight = new Map();
    this.metrics = { requests: 0, cacheHits: 0, coalesced: 0, errors: 0, throttled: 0,
      coordination: this.shared ? 'shared' : 'local', durationMs: 0, rateLimits: {}, rateLimitsObservedAt: null };
  }

  /** Build the Authorization string. Each encoded credential is URI-encoded. */
  buildAuthorization() {
    const u = encodeURIComponent(this.uEncoded);
    const p = encodeURIComponent(this.pEncoded);
    const org = encodeURIComponent(this.orgEncoded);
    return `uencoded=${u}&pencoded=${p}&orgEncoded=${org}`;
  }

  /**
   * Build the "+"-joined canonical payload string that gets HMAC-signed.
   * Exposed for unit testing against AroFlo's documented example.
   */
  buildPayload({ method, authorization, afDateTimeUtc, varString }) {
    const parts = [method];
    if (this.hostIp) parts.push(this.hostIp);
    parts.push(''); // urlPath — always empty
    parts.push(this.accept);
    parts.push(authorization);
    parts.push(afDateTimeUtc);
    parts.push(varString);
    return parts.join('+');
  }

  sign(payload) {
    if (!this.secretKey) throw new Error('AroFlo secret key is required for signing');
    return createHmac('sha512', this.secretKey).update(payload, 'utf8').digest('hex');
  }

  /**
   * Build a GET varString from a zone + filters.
   * @param {object} q
   * @param {string} q.zone
   * @param {string[]} [q.where]  e.g. ["and|jobnumber|=|1048"]
   * @param {string[]} [q.join]
   * @param {string[]} [q.order]
   * @param {number} [q.page]
   * @param {number} [q.pageSize]
   */
  static buildVarString(q) {
    const parts = [`zone=${encodeURIComponent(q.zone)}`];
    for (const w of q.where ?? []) parts.push(`where=${encodeURIComponent(w)}`);
    for (const j of q.join ?? []) parts.push(`join=${encodeURIComponent(j)}`);
    for (const o of q.order ?? []) parts.push(`order=${encodeURIComponent(o)}`);
    if (typeof q.page === 'number') parts.push(`page=${encodeURIComponent(q.page)}`);
    if (typeof q.pageSize === 'number') parts.push(`pageSize=${encodeURIComponent(q.pageSize)}`);
    return parts.join('&');
  }

  /**
   * Perform a signed GET against a zone.
   * @returns {Promise<{ httpStatus:number, status:string, statusMessage:string, zoneResponse:object, raw:object }>}
   */
  async get(query) {
    const varString = ArofloClient.buildVarString(query);
    const cached = this.shared ? undefined : this.cache.get(varString);
    if (cached !== undefined) {
      this.metrics.cacheHits++;
      return cached;
    }
    if (this.inFlight.has(varString)) {
      this.metrics.coalesced++;
      return this.inFlight.get(varString);
    }
    // Bound the number of distinct outstanding queries as well as stored data.
    if (this.inFlight.size >= 32) throw this.#throttled(1);
    const pending = this.#read(query, varString).catch((error) => {
      if (error.code === 'rate_limit' && !(error instanceof ArofloError)) throw this.#throttled(error.retryAfter);
      if (error.code === 'shared_unavailable') throw new ArofloError('Shared coordination unavailable', { code: 'unavailable' });
      throw error;
    });
    this.inFlight.set(varString, pending);
    try { return await pending; }
    finally { this.inFlight.delete(varString); }
  }

  async #read(query, varString) {
    if (!this.shared || String(query.zone).toLowerCase() === 'lastupdate') return this.#getFresh(varString, query);
    const generation = await this.shared.generation();
    return this.shared.cached(varString, (result) => this.#ttl(result, query.zone),
      () => this.#getFresh(varString, query), { generation });
  }

  #ttl(result, zone) {
    const rows = result.zoneResponse?.[String(zone).toLowerCase()];
    return Array.isArray(rows) && rows.length === 0 ? this.emptyCacheTtlSeconds : this.cacheTtlSeconds;
  }

  async getCollection(query) {
    const result = await this.get(query);
    const zone = String(query.zone).toLowerCase();
    const rows = result.zoneResponse[zone];
    const max = Number(result.zoneResponse.maxpageresults);
    if (!Array.isArray(rows) || !max || rows.length < max) return result;
    const all = rows.slice();
    for (let page = (query.page || 1) + 1; page <= 10; page++) {
      const next = await this.get({ ...query, page });
      const batch = next.zoneResponse[zone];
      if (!Array.isArray(batch)) throw new ArofloError('Invalid collection page', { code: 'api' });
      all.push(...batch);
      if (batch.length < (Number(next.zoneResponse.maxpageresults) || max)) {
        return { ...result, zoneResponse: { ...result.zoneResponse, [zone]: all } };
      }
    }
    throw new ArofloError('Collection pagination incomplete', { code: 'api' });
  }

  async refreshUpdates() {
    if (!this.shared) return false;
    try {
      const result = await refreshUpdates(this, this.shared);
      return result.healthy;
    } catch (error) {
      // A quota cooldown must still allow already-fresh collection resources.
      // Bypass ID mappings; any actual refresh still passes shared admission.
      if (error.code === 'rate_limit') return false;
      throw error;
    }
  }

  /** Keep discovery separate from fresh data: a healthy update feed invalidates
   * ID mappings on any relevant event, including newly created sibling records.
   * Multi-record results keep using the original collection query.
   */
  async getByJob(zone, job, { join, updatesHealthy = false } = {}) {
    const query = { zone, where: [`and|jobnumber|=|${job}`], ...(join ? { join } : {}) };
    if (!this.shared || !updatesHealthy) return this.getCollection(query);
    const generation = await this.shared.generation();
    const idField = zone.toLowerCase() === 'quotes' ? 'quoteid' : 'taskid';
    let discovered;
    const ids = await this.shared.cached(`discovery:${ArofloClient.buildVarString(query)}`,
      () => remainingTtl(discovered, 600), async () => {
      discovered = await this.getCollection(query);
      const rows = discovered.zoneResponse[zone.toLowerCase()] || [];
      if (rows.length === 1 && rows[0][idField]) {
        const recordQuery = { zone, where: [`and|${idField}|=|${rows[0][idField]}`], ...(join ? { join } : {}) };
        await this.shared.cached(ArofloClient.buildVarString(recordQuery), remainingTtl(discovered, this.#ttl(discovered, zone)),
          async () => discovered, { generation });
        return [rows[0][idField]];
      }
      return [];
    }, { generation });
    if (discovered) return discovered;
    if (ids.length !== 1) return this.getCollection(query);
    const result = await this.get({ zone, where: [`and|${idField}|=|${ids[0]}`], ...(join ? { join } : {}) });
    const rows = result.zoneResponse[zone.toLowerCase()] || [];
    // Missing/deleted/moved records require fresh membership discovery.
    if (rows.length !== 1 || String(rows[0].jobnumber) !== String(job)) {
      await this.shared.invalidate();
      return this.getCollection(query);
    }
    return result;
  }

  #throttled(retryAfter) {
    this.metrics.throttled++;
    return new ArofloError('AroFlo is temporarily rate limited', { code: 'rate_limit', retryAfter });
  }

  #checkCooldown() {
    if (this.cooldownUntil > Date.now()) {
      throw this.#throttled(Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    }
  }

  async #getFresh(varString, query) {
    const zone = String(query.zone).toLowerCase();
    const idField = { quotes: 'quoteid', tasks: 'taskid', locations: 'locationid', schedules: 'scheduleid' }[zone];
    const singleId = idField && query.where?.length === 1 && query.where[0].startsWith(`and|${idField}|=|`);
    if (this.shared) await this.shared.admit(zone === 'lastupdate' ? 'exempt' : singleId ? 'secondary' : 'ordinary');
    else await this.#waitForRequestSlot();
    const startedAt = Date.now();
    this.metrics.requests++;
    try {
      const result = await this.#send('GET', varString);
      result.fetchedAt = Date.now();
      if (!this.shared) this.cache.set(varString, result, this.#ttl(result, zone));
      return result;
    } catch (error) {
      this.metrics.errors++;
      throw error;
    } finally {
      this.metrics.durationMs += Date.now() - startedAt;
    }
  }

  /** Serialize admissions, not responses. Delayed timers must not release a burst. */
  async #waitForRequestSlot() {
    const admission = this.slotQueue.then(async () => {
      this.#checkCooldown();
      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.#checkCooldown(); // another request may have returned a 429 while waiting
      this.nextRequestAt = Date.now() + this.minRequestIntervalMs;
    });
    this.slotQueue = admission.catch(() => {});
    return admission;
  }

  async #send(method, varString) {
    const afDateTimeUtc = new Date().toISOString();
    const authorization = this.buildAuthorization();
    const payload = this.buildPayload({ method, authorization, afDateTimeUtc, varString });
    const signature = this.sign(payload);

    const headers = {
      Authentication: `HMAC ${signature}`,
      Authorization: authorization,
      Accept: this.accept,
      afdatetimeutc: afDateTimeUtc,
    };
    if (this.hostIp) headers.HostIP = this.hostIp;

    const url = new URL(this.baseUrl);
    url.search = varString;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    let text;
    try {
      response = await fetch(url, { method, headers, signal: controller.signal });
      this.metrics.rateLimits = readRateLimits(response.headers);
      this.metrics.rateLimitsObservedAt = new Date().toISOString();
      if (this.shared) await this.shared.observe(this.metrics.rateLimits);
      if (response.status === 429) {
        const seconds = retryAfterSeconds(response.headers.get('retry-after'));
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + seconds * 1000);
        if (this.shared) await this.shared.cooldown(seconds);
        // Rate-limit responses may be HTML; never misclassify them as authentication.
        if (response.body) await response.body.cancel();
        throw this.#throttled(seconds);
      }
      text = await response.text();
    } catch (err) {
      if (err instanceof ArofloError || err.code === 'shared_unavailable') throw err;
      if (err.name === 'AbortError') {
        throw new ArofloError('AroFlo request timed out', { code: 'timeout' });
      }
      throw new ArofloError(`Could not reach AroFlo: ${err.message}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // The base URL greeting ("Login Failed - Invalid Request") is not JSON.
      throw new ArofloError(
        'AroFlo returned a non-JSON response — usually an authentication problem.',
        { code: 'auth', httpStatus: response.status, body: text.slice(0, 300) }
      );
    }

    const status = data.status;
    const statusMessage = data.statusmessage;

    // AroFlo uses status "0" / "Login OK" for success. Anything else is an error.
    const statusNum = Number(status);
    // AroFlo also reports throttling in its JSON status, sometimes with HTTP 200.
    if ([6, 7, 429].includes(statusNum)) {
      const seconds = statusNum === 7 ? dailyResetSeconds() : retryAfterSeconds(response.headers.get('retry-after'));
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + seconds * 1000);
      if (this.shared) await this.shared.cooldown(seconds);
      throw this.#throttled(seconds);
    }
    const ok = response.ok && (status === '0' || statusNum === 0);
    if (!ok) {
      // Classify as auth strictly on AroFlo's documented auth code (-99999) or a 401/403,
      // not on substring-matching the message (which could misroute a normal API error).
      const code =
        statusNum === -99999 || response.status === 401 || response.status === 403
          ? 'auth'
          : 'api';
      throw new ArofloError(statusMessage || `AroFlo error (status ${status})`, {
        code,
        httpStatus: response.status,
        status,
      });
    }

    return {
      httpStatus: response.status,
      status,
      statusMessage,
      zoneResponse: data.zoneresponse || {},
      raw: data,
    };
  }
}

export class ArofloError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ArofloError';
    this.code = meta.code || 'api';
    this.httpStatus = meta.httpStatus;
    this.status = meta.status;
    this.body = meta.body;
    this.retryAfter = meta.retryAfter;
  }
}

function remainingTtl(result, seconds) {
  if (!Number.isFinite(result?.fetchedAt)) return 0;
  return Math.max(0, seconds - (Date.now() - result.fetchedAt) / 1000);
}
