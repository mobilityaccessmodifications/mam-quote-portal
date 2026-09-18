import { createHmac } from 'node:crypto';
import { createTtlCache } from '../util/cache.js';
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
    this.nextRequestAt = 0;
    this.slotQueue = Promise.resolve();
    this.cooldownUntil = 0;
    this.cacheTtlSeconds = opts.cacheTtlSeconds ?? 0; // recon scripts stay uncached
    this.emptyCacheTtlSeconds = Math.min(this.cacheTtlSeconds, opts.emptyCacheTtlSeconds ?? 15);
    this.cache = createTtlCache(this.cacheTtlSeconds);
    this.inFlight = new Map();
    this.metrics = { requests: 0, cacheHits: 0, coalesced: 0, errors: 0, throttled: 0,
      durationMs: 0, rateLimits: {}, rateLimitsObservedAt: null };
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
    const cached = this.cache.get(varString);
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
    const pending = this.#getFresh(varString, query.zone);
    this.inFlight.set(varString, pending);
    try { return await pending; }
    finally { this.inFlight.delete(varString); }
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

  async #getFresh(varString, zone) {
    await this.#waitForRequestSlot();
    const startedAt = Date.now();
    this.metrics.requests++;
    try {
      const result = await this.#send('GET', varString);
      const rows = result.zoneResponse?.[String(zone).toLowerCase()];
      const ttl = Array.isArray(rows) && rows.length === 0 ? this.emptyCacheTtlSeconds : this.cacheTtlSeconds;
      this.cache.set(varString, result, ttl);
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
      if (response.status === 429) {
        const seconds = retryAfterSeconds(response.headers.get('retry-after'));
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + seconds * 1000);
        // Rate-limit responses may be HTML; never misclassify them as authentication.
        if (response.body) await response.body.cancel();
        throw this.#throttled(seconds);
      }
      text = await response.text();
    } catch (err) {
      if (err instanceof ArofloError) throw err;
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
