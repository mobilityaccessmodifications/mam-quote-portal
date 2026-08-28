import { createHmac } from 'node:crypto';

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
    await this.#waitForRequestSlot();
    return this.#send('GET', varString);
  }

  /** Reserve an evenly spaced request slot, including for concurrent callers. */
  async #waitForRequestSlot() {
    if (this.minRequestIntervalMs <= 0) return;
    const now = Date.now();
    const requestAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = requestAt + this.minRequestIntervalMs;
    const waitMs = requestAt - now;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
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
      text = await response.text();
    } catch (err) {
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
  }
}
