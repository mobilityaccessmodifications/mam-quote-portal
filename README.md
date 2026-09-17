# Mobility Access Modifications — Job Status Tracker

A working MVP that lets a customer enter their **job number** and, if they wish,
the **name at the job address** and **post code** to verify it, then
get the **latest status of their job**, pulled live from the **AroFlo** API.

It is a small Node/Express app:

- **Backend proxy** holds the AroFlo credentials server-side and signs every
  request (AroFlo HMAC-SHA512). The browser never sees any secret.
- **Branded frontend** (styled after mobilityaccess.com.au) with a "Track Your
  Job" form, a live status stepper, and accessible (WCAG-AA) markup.
- **Mock mode** so it runs and demos with zero credentials.

---

## 1. Quick start (demo, no credentials needed)

```bash
npm install
npm start
```

Open <http://localhost:3000>. It boots in **MOCK mode** (sample data). Try:

| Job number | Name at job address | Post code | Result |
|---|---|---|
| `1070` | `Jane Doe` | `3000` | Awaiting approval |
| `2001` | `John Smith` | `3056` | Approved |
| `1048` | `Bradley Sandbox` | `3134` | In progress |
| `3300` | `Pat Taylor` | `3220` | Not proceeding |
| any | wrong name | any | "couldn't verify" message |

---

## 2. Going live with the real AroFlo API

1. Open `.env` and fill in the four AroFlo values (from **AroFlo → Site Admin →
   Settings → General → AroFlo API**):
   - `AROFLO_SECRET_KEY` — the API Secret Key (shown once)
   - `AROFLO_UENCODED`
   - `AROFLO_PENCODED` — the API token (the "(Re-)Generate Key" value)
   - `AROFLO_ORG_ENCODED`
   - (optional) `AROFLO_HOST_IP` if your key is IP-locked.
2. Verify the credentials work:
   ```bash
   npm run check-aroflo
   ```
   You want `✓ SUCCESS`. If you get an auth error, re-copy the keys.
3. Set `MOCK_MODE=false` in `.env` and restart (`npm start`).

> ⚠️ **The `pEncoded` value originally supplied was corrupted** (it contained an
> invalid `·` character). Re-copy it from AroFlo before going live.

---

## 3. How it works

### Authentication (`src/aroflo/client.js`)
Every request is signed exactly as AroFlo documents. The signed payload is these
fields joined with `+`:

```
method + [HostIP] + urlPath("") + accept + Authorization + afdatetimeutc + varString
signature = HMAC_SHA512(payload, secretKey)   // lowercase hex
```

Headers sent: `Authentication: HMAC <sig>`, `Authorization: uencoded=…&pencoded=…&orgEncoded=…`,
`Accept: text/json`, `afdatetimeutc: <iso>`, and `HostIP` if configured.

The signing contract is locked by `test/signature.test.js` (`npm test`).

### Job lookup + optional identity verification (`src/aroflo/quoteService.js`)
1. `Quotes` zone, `WHERE jobnumber = N` → status, dates and reference.
2. If a name is supplied, `Tasks` → `Locations` resolves the physical job
   location's `SiteContact` and postcode. This is the resident/customer name,
   rather than a funder or case-manager contact held on the quote.
3. Every supplied verification detail must match the same AroFlo record. A job
   number on its own is still sufficient for a lookup.

Internal figures (quote total, cost, margin, markup, labour/material cost) are
**never** sent to the browser — only customer-facing fields (quote name, status,
dates and reference).

### Security choices
- Secrets live only in `.env` (git-ignored) and never reach the client.
- Job-not-found and name/postcode mismatch return the **same** generic message in
  production (`VERBOSE_CLIENT_ERRORS=false`) so the portal can't be used to
  guess valid job numbers.
- Per-IP rate limiting on `/api/*` and a short response cache to respect
  AroFlo's **2000 calls/day** limit.
- Baseline security headers; request body capped at 8 KB.

---

## 4. Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `MOCK_MODE` | `true` = sample data, `false` = live AroFlo |
| `VERBOSE_CLIENT_ERRORS` | `true` only for testing (leaks job existence) |
| `CACHE_TTL_SECONDS` | cache window for lookups |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | abuse protection |
| `PORT` | server port |
| `TRUST_PROXY` | `false` for direct exposure; `1`/CIDR only when behind a known proxy/CDN. **`true` is rejected** |
| `NEG_RESPONSE_FLOOR_MS` / `NEG_RESPONSE_JITTER_MS` | anti-enumeration timing floor for negative responses |
| `AROFLO_MIN_REQUEST_INTERVAL_MS` | minimum spacing between AroFlo requests (default `600` ms) |
| `SCHEDULER_BOOKING_SLA` | current customer-facing contact timeframe for a booking; also the fallback for all scheduler contacts |
| `SCHEDULER_MEASURE_SLA` | optional override for a measure |
| `SCHEDULER_INSTALLATION_SLA` | optional override for an installation |

> **Why `TRUST_PROXY` matters:** the rate limiter keys on the client IP. `trust proxy`
> while the app is directly exposed lets an attacker spoof `X-Forwarded-For` to get a
> fresh bucket per request and defeat rate limiting. So `TRUST_PROXY=true` (blanket trust)
> is **refused at startup** — use `false`, an integer hop count, or a CIDR.

> **Fail-fast:** in live mode (`MOCK_MODE=false`) the server **refuses to start** if the
> config is invalid (missing credentials, `VERBOSE_CLIENT_ERRORS=true`, or unsafe
> `TRUST_PROXY`) rather than booting "healthy" while lookups fail.

> **Anti-enumeration timing:** "not found" and "wrong name/post code" are padded to a common floor
> (`NEG_RESPONSE_FLOOR_MS`, default 1500 ms) + jitter so they can't be told apart by
> latency. Set the floor above your hosting environment's measured worst-case lookup time
> (a single AroFlo call alone varies ~200–500 ms). The rate limiter is the hard control;
> this padding is defence in depth.

> **Scheduler timeframes:** set only values confirmed by the scheduling team, such
> as `within 5 business days`. The tracker displays the relevant value beside an
> approved job that is awaiting a scheduler contact. It does not infer a customer
> promise from internal task volume or historical timing; blank values are not shown.

---

## 5. Handover notes for the web developer

- **Rebranding:** all colours/fonts are CSS variables at the top of
  `public/styles.css`. Swap the brand logo by replacing the `.brand-mark`/SVG
  favicon. The markup in `public/index.html` is plain, semantic HTML.
- **Embedding in the main site:** the portal is just one `POST /api/quote-status`
  endpoint (`{ jobNumber, clientName, postcode }` → JSON). You can keep this Express service as
  a small backend and call the endpoint from the existing website, or lift
  `public/index.html` markup into a page on the main CMS and point its fetch at
  this service's URL (enable CORS in `server.js` if cross-origin).
- **Hosting:** any Node host works (Render, Railway, Fly.io, a VPS, or Vercel
  with a small serverless adapter). Set the env vars in the host's dashboard —
  do **not** commit `.env`.
- **Multi-instance:** the in-memory rate limiter/cache are per-process. For more
  than one instance, back them with Redis (`src/middleware/rateLimit.js`,
  `src/util/cache.js` are the only files to change).
- **Name matching** uses the job location's AroFlo `SiteContact` when available,
  with the quote contact/client organisation as a fallback for legacy records.
- **Secrets in the hand-off:** do **not** include `.env` in any zip/share you send.
  Set the AroFlo values in the host's environment-variable dashboard instead. This
  folder is not a git repo, so `.gitignore` won't protect a copied `.env`.

### Known limitations (intentional for the MVP)
- **Paging:** the Quotes/Tasks lookups read the first page only. A single job almost
  never exceeds one page, but if you expect jobs with very many quote revisions, add
  paging in `#lookupLive` (the client already supports `page`/`pageSize`).
- **Cache & rate limiter are per-process** (in-memory). Fine for one instance; use a
  shared store (Redis) for multiple instances.
- **Enumeration timing:** negative responses are padded to a fixed floor + jitter so
  "job not found" and "wrong details" are indistinguishable by latency.

---

## 6. Project layout

```
server.js                     Express entry (static site + /api)
src/config.js                 env loading & validation
src/aroflo/client.js          AroFlo HMAC-SHA512 signing + fetch
src/aroflo/quoteService.js    lookup by job#, verify name/post code, sanitise
src/routes/quoteStatus.js     POST /api/quote-status, GET /api/health
src/middleware/rateLimit.js   per-IP rate limiter
src/util/cache.js             TTL cache
src/mock/sampleData.js        demo data (MOCK_MODE)
public/                       branded frontend (index.html, styles.css, app.js)
scripts/test-connection.js    live credential check
test/signature.test.js        signing regression tests
```

## 7. Security reminder
The credentials shared during development should be treated as exposed and
**rotated in AroFlo** before launch (re-generate the API key + secret).

### Static analysis

Run `npx --yes fallow@3.26.0` after installing dependencies. `.fallowrc.json`
records the Vercel handler, browser assets, and manually invoked diagnostic
scripts as entry points. The single ignored unresolved path,
`./aroflo-metrics.json`, is the output of `writeFileSync(new URL(...))`, not
an input dependency. Do not commit that generated data.

Fallow's complexity findings identify refactoring candidates; coverage-based
risk scores are estimates unless a real coverage report is supplied.
