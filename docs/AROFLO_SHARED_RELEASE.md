# Shared AroFlo optimization release

## Target and activation

- GitHub: `mobilityaccessmodifications/mam-quote-portal`, reviewed PR into `main`.
- Vercel: `mam-quote-portal`, team `ai-7033s-projects`.
- Proposed store: dedicated `mam-quote-shared-cache`, Upstash Redis free plan,
  Sydney (`syd1`), no read replicas, no automatic paid upgrade, no provider eviction.
- Function region: Sydney, matching Redis to reduce coordination latency.
- Only this project's production environment receives the store credentials.
- Cache includes encrypted quote/task/location/schedule resources (normally at
  most 120 seconds), encrypted record-ID mappings (at most ten minutes), hashed
  IP buckets, leases, quota counters and a synchronization cursor. It is not a
  customer-data archive. Provider persistence/retention policies still apply.

Creating and connecting this new third-party destination requires explicit
provider-specific approval. Until storage is approved, provisioned and verified,
leave `AROFLO_SHARED_ENABLED` disabled and do not describe shared mode as live.
The feature is deliberately opt-in so a missing store cannot silently change an
existing release's availability.

## Configuration

The Vercel integration can inject `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are accepted aliases.
Credentials belong only in Vercel's secret environment configuration. Never print
or commit environment files. Set `AROFLO_SHARED_ENABLED=true` for production only
after a scoped connection test succeeds. Keep default budgets 1900 / 19000 and
resource TTL 120 seconds unless observed traffic justifies a reviewed change.

On Vercel, the limiter defaults to the platform-provided `x-real-ip`. Outside
Vercel, it defaults to the socket IP. An explicit `CLIENT_IP_HEADER` overrides
that choice and must name a trusted, overwritten proxy header.

The free Redis plan can reject requests at its own limits; because coordination
fails closed, this produces retryable portal 503s. Automatic billing upgrades
must remain disabled. Provisioning, changing a plan and sharing credentials with
another project are separate operations, not application fallbacks.

## Verification and release

1. Run `npm test`. It includes unit and regression tests; real Redis cases are
   skipped unless `REDIS_TEST_PORT` is set.
2. Run a disposable local Redis on loopback, with persistence disabled, and run
   `REDIS_TEST_PORT=16379 npm test`. Tests use synthetic data and unique namespaces;
   they never issue FLUSHDB or access AroFlo. No production store is allowed for
   these tests. The test adapter is hard-coded to 127.0.0.1.
3. For the approved production Redis, perform a scoped synthetic key read/write
   with a short TTL and evaluate the admission script under an isolated test
   namespace. Never flush the database or query customer cache values.
4. Verify environment names/target, enable shared mode and merge the passing PR.
   Deploy only through the GitHub production branch; no local Vercel deployment.
5. Match the production deployment SHA to the merge commit. Check homepage,
   assets, health and invalid-input handling without customer identifiers.
6. Check sanitized usage logs during approved real traffic. Account-wide provider
   quotas include other integrations; synthetic test savings are not a measured
   production savings percentage.

Disabling shared mode restores local-only behavior and removes global protection;
use a reviewed change or an explicitly approved environment rollback if required.
Do not treat an unavailable Redis as permission to bypass coordination in code.
