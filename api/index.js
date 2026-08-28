/**
 * Vercel serverless entrypoint.
 *
 * Exports the Express app as the request handler. All requests are routed here by
 * vercel.json (rewrites), and Express then serves both the static frontend and the
 * /api/* endpoints. Unlike server.js this file never calls listen() or process.exit():
 * a serverless function must not exit the process, so a missing-credential situation
 * surfaces as a normal 502 at request time instead of a crash.
 */
import { createApp } from '../src/app.js';
import config, { validateConfig } from '../src/config.js';

// Log config problems to the Vercel function logs (visible in the dashboard) but keep
// serving — the static site still works and lookups return a safe error if creds are absent.
const problems = validateConfig(config);
for (const p of problems) console.warn('[config]', p);

export default createApp(config);
