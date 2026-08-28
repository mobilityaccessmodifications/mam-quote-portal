import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import config from './config.js';
import { createQuoteRouter } from './routes/quoteStatus.js';
import { createRateLimiter } from './middleware/rateLimit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Builds the Express app. Shared by the local server (server.js) and the Vercel
 * serverless entrypoint (api/index.js). This module deliberately does NOT call
 * app.listen() or process.exit(), so it is safe to import inside a serverless
 * function — a lambda must never kill its own process on a config problem.
 */
export function createApp(cfg = config) {
  const app = express();
  app.disable('x-powered-by');
  // Only trust X-Forwarded-For when explicitly configured (TRUST_PROXY). Default false,
  // so a directly-exposed deployment uses the real socket IP and the rate limiter cannot
  // be defeated by a spoofed X-Forwarded-For header. Behind a platform proxy (Vercel),
  // per-client rate limiting is handled by CLIENT_IP_HEADER instead — see rateLimit.js.
  app.set('trust proxy', cfg.trustProxy);

  // Parse JSON bodies (small limit — this API only takes a job number, name + post code).
  app.use(express.json({ limit: '8kb' }));

  // A few baseline security headers (no external dependency).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Rate-limit the public API.
  const limiter = createRateLimiter(cfg.rateLimit, { clientIpHeader: cfg.clientIpHeader });
  app.use('/api', limiter, createQuoteRouter(cfg));

  // Serve the branded static frontend. On Vercel these files are bundled into the
  // function (see vercel.json "includeFiles") and this same handler serves them.
  app.use(express.static(join(__dirname, '..', 'public'), { extensions: ['html'] }));

  return app;
}
// NOTE: no `export default` here on purpose. This module is a FACTORY, not a request
// handler — exporting the factory as a default made some build tools treat it as a
// serverless handler and invoke createApp(req, res), crashing on `req.rateLimit`.
// Consumers import the named `createApp`.
