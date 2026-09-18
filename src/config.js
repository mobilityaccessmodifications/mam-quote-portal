import 'dotenv/config';

/**
 * Loads and validates configuration from environment variables.
 * Throws early (on boot) if something required is missing while NOT in mock mode,
 * so the operator gets a clear message instead of a confusing runtime auth failure.
 */

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** Strict integer parse: rejects junk like "20abc" or "3.9" instead of silently truncating. */
function int(value, fallback, { min } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) {
    console.warn(`[config] Ignoring invalid integer "${value}", using fallback ${fallback}.`);
    return fallback;
  }
  let n = Number.parseInt(s, 10);
  if (typeof min === 'number' && n < min) {
    console.warn(`[config] Value ${n} below minimum ${min}, using ${min}.`);
    n = min;
  }
  return n;
}

/**
 * Customer-facing scheduler timeframes are deliberately set in the deployment
 * environment, rather than inferred from internal AroFlo workload data. Keep
 * them short and single-line so they are safe to display as supporting copy.
 */
function publicTimeframe(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Parse the trust-proxy setting safely.
 *  - "false"/unset      -> { value: false }  (req.ip is the real socket address)
 *  - an integer N       -> { value: N }       (trust exactly N proxy hops)
 *  - a CIDR / "loopback"-> { value: string }  (passed through to Express)
 *  - "true"/"on"/"yes"  -> { value: false, unsafe: true }  REJECTED — blanket-trusting
 *      EVERY X-Forwarded-For header lets any client spoof its IP and defeat the rate
 *      limiter. We force the safe default (false) AND flag it so startup can fail.
 */
function parseTrustProxy(value) {
  if (value === undefined || value === null || value === '') return { value: false, unsafe: false };
  const s = String(value).trim();
  if (/^(false|off|no)$/i.test(s)) return { value: false, unsafe: false };
  if (/^(true|on|yes)$/i.test(s)) return { value: false, unsafe: true };
  if (/^\d+$/.test(s)) return { value: Number.parseInt(s, 10), unsafe: false };
  return { value: s, unsafe: false }; // e.g. "loopback", "10.0.0.0/8"
}

const mockMode = bool(process.env.MOCK_MODE, false);
const trustProxyParsed = parseTrustProxy(process.env.TRUST_PROXY);

const config = {
  mockMode,
  port: int(process.env.PORT, 3000, { min: 1 }),
  trustProxy: trustProxyParsed.value,
  trustProxyUnsafe: trustProxyParsed.unsafe,
  // Header a trusted platform proxy sets to the real client IP (e.g. "x-real-ip" on
  // Vercel). Used only for rate-limit keying. Blank = use the socket IP (req.ip).
  clientIpHeader: (process.env.CLIENT_IP_HEADER ?? (process.env.VERCEL === '1' ? 'x-real-ip' : '')).trim().toLowerCase(),
  verboseClientErrors: bool(process.env.VERBOSE_CLIENT_ERRORS, false),
  // Internal-testing mode: accept ONLY a job number and skip the client-name + post-code
  // verification. Leave false for production (the secure 3-field identity check).
  jobNumberOnly: bool(process.env.JOB_NUMBER_ONLY, false),
  emptyCacheTtlSeconds: int(process.env.EMPTY_CACHE_TTL_SECONDS, 15, { min: 0 }),
  cacheTtlSeconds: int(process.env.CACHE_TTL_SECONDS, 120, { min: 0 }),
  // Anti-enumeration: pad negative (not-found / wrong-details) responses to this floor
  // (+ jitter) so they cannot be distinguished from each other by latency. Set the
  // floor above your measured worst-case lookup latency (see README).
  negResponseFloorMs: int(process.env.NEG_RESPONSE_FLOOR_MS, 1500, { min: 0 }),
  negResponseJitterMs: int(process.env.NEG_RESPONSE_JITTER_MS, 250, { min: 0 }),
  // Set these to the scheduler-approved, current customer-facing contact
  // timeframes (for example, "within 5 business days"). A blank value is not
  // shown, so the portal never invents a promise from historical workload data.
  schedulerSla: {
    booking: publicTimeframe(process.env.SCHEDULER_BOOKING_SLA),
    measure: publicTimeframe(process.env.SCHEDULER_MEASURE_SLA),
    installation: publicTimeframe(process.env.SCHEDULER_INSTALLATION_SLA),
  },
  rateLimit: {
    max: int(process.env.RATE_LIMIT_MAX, 20, { min: 1 }),
    windowSeconds: int(process.env.RATE_LIMIT_WINDOW_SECONDS, 300, { min: 1 }),
  },
  shared: {
    enabled: bool(process.env.AROFLO_SHARED_ENABLED, false),
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '',
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
    scope: process.env.VERCEL_ENV || 'development',
    dailyBudget: int(process.env.AROFLO_DAILY_BUDGET, 1900, { min: 1 }),
    secondaryBudget: int(process.env.AROFLO_SECONDARY_DAILY_BUDGET, 19000, { min: 1 }),
  },
  aroflo: {
    baseUrl: process.env.AROFLO_BASE_URL || 'https://api.aroflo.com/',
    secretKey: process.env.AROFLO_SECRET_KEY || '',
    uEncoded: process.env.AROFLO_UENCODED || '',
    pEncoded: process.env.AROFLO_PENCODED || '',
    orgEncoded: process.env.AROFLO_ORG_ENCODED || '',
    hostIp: (process.env.AROFLO_HOST_IP || '').trim(),
    accept: 'text/json',
    metricsEnabled: bool(process.env.AROFLO_METRICS_ENABLED, true),
    // AroFlo applies a per-second API limit. This is an in-process request queue
    // interval, not a credential or browser-visible value.
    minRequestIntervalMs: int(process.env.AROFLO_MIN_REQUEST_INTERVAL_MS, 600, { min: 0 }),
  },
};

/**
 * Validate configuration. Returns an array of human-readable problems (empty = OK).
 * Surfaces both missing live credentials and risky combinations.
 */
export function validateConfig(cfg = config) {
  const problems = [];

  // Unsafe in ANY mode: blanket-trusting X-Forwarded-For defeats the rate limiter.
  if (cfg.trustProxyUnsafe) {
    problems.push(
      'TRUST_PROXY=true blindly trusts every X-Forwarded-For header, letting any client spoof ' +
        'its IP and bypass rate limiting. Use TRUST_PROXY=false, an integer hop count, or a CIDR. ' +
        '(The value has been forced to false.)'
    );
  }

  // Risky: verbose (enumerable) errors on a live deployment.
  if (cfg.verboseClientErrors && !cfg.mockMode) {
    problems.push(
      'VERBOSE_CLIENT_ERRORS=true while MOCK_MODE=false — this lets the portal reveal which ' +
        'job numbers exist (enumeration). Set VERBOSE_CLIENT_ERRORS=false in production.'
    );
  }

  if (cfg.shared?.enabled && !cfg.mockMode) {
    if (!cfg.shared.url || !cfg.shared.token) problems.push('Shared coordination requires Redis REST URL and token');
    else {
      try { if (new URL(cfg.shared.url).protocol !== 'https:') problems.push('Redis REST URL must use HTTPS'); }
      catch { problems.push('Redis REST URL is invalid'); }
    }
  }
  if (cfg.mockMode) return problems; // mock mode needs no credentials

  const required = [
    ['AROFLO_SECRET_KEY', cfg.aroflo.secretKey],
    ['AROFLO_UENCODED', cfg.aroflo.uEncoded],
    ['AROFLO_PENCODED', cfg.aroflo.pEncoded],
    ['AROFLO_ORG_ENCODED', cfg.aroflo.orgEncoded],
  ];
  for (const [name, value] of required) {
    if (!value) problems.push(`Missing required env var: ${name}`);
  }
  return problems;
}

export default config;
