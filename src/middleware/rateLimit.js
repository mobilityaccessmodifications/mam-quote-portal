/**
 * Minimal in-memory, per-IP fixed-window rate limiter (no external dependency).
 * Good enough for an MVP / single instance. NOTE: on a serverless platform (Vercel)
 * the map is per-instance and resets on cold starts, so this is best-effort there —
 * for strong production limiting use a shared store (e.g. Redis / Vercel KV) or the
 * platform's own rate limiting. See README.
 *
 * `clientIpHeader` (optional): when running behind a trusted platform proxy, the name
 * of the header the platform sets to the real client IP (e.g. "x-real-ip" on Vercel).
 * Without it, req.ip on a serverless proxy is an internal address shared by every user,
 * which would throttle all traffic together.
 */
export function createRateLimiter({ max, windowSeconds }, { clientIpHeader = '' } = {}) {
  const windowMs = windowSeconds * 1000;
  const hits = new Map(); // ip -> { count, resetAt }

  // Periodically clear expired buckets so the map doesn't grow unbounded.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of hits) if (rec.resetAt <= now) hits.delete(ip);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  // Only a header the operator explicitly names is trusted — we never blindly parse an
  // arbitrary X-Forwarded-For (which any client can spoof). The platform is responsible
  // for setting the named header to the true client IP and overwriting client attempts.
  function resolveIp(req) {
    if (clientIpHeader) {
      const raw = req.headers[clientIpHeader];
      if (raw) return String(Array.isArray(raw) ? raw[0] : raw).split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  return function rateLimit(req, res, next) {
    const ip = resolveIp(req);
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(ip, rec);
    }
    rec.count += 1;

    const remaining = Math.max(0, max - rec.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        ok: false,
        message: 'Too many requests. Please wait a few minutes and try again.',
      });
    }
    next();
  };
}
