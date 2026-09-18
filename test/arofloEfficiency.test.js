import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArofloClient } from '../src/aroflo/client.js';
import { QuoteService } from '../src/aroflo/quoteService.js';
import { createTtlCache } from '../src/util/cache.js';
import { dailyResetSeconds } from '../src/aroflo/limits.js';

const opts = { secretKey: 'synthetic-secret', uEncoded: 'synthetic-user',
  pEncoded: 'synthetic-password', orgEncoded: 'synthetic-org',
  baseUrl: 'https://aroflo.invalid/', minRequestIntervalMs: 0, cacheTtlSeconds: 120 };
const query = { zone: 'Quotes', where: ['and|jobnumber|=|999999999999'] };
const ok = (zoneResponse, headers = {}) => new Response(JSON.stringify({ status: '0', zoneresponse: zoneResponse }), { headers });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('concurrent identical reads share one request, even with completed caching disabled', async (t) => {
  const release = deferred();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; await release.promise; return ok({ quotes: [{ status: 'Approved' }] }); });
  const client = new ArofloClient({ ...opts, cacheTtlSeconds: 0 });
  const requests = Array.from({ length: 10 }, () => client.get(query));
  release.resolve();
  const results = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.equal(client.metrics.coalesced, 9);
  assert.ok(results.every((result) => result.status === '0'));
  await client.get(query);
  assert.equal(calls, 2, 'TTL zero disables completed caching');
});

test('resource cache reuses data, expires without sliding, and caches empty results briefly', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let rows = [{ status: 'Approved' }];
  t.mock.method(globalThis, 'fetch', async () => { calls++; return ok({ quotes: rows }); });
  const client = new ArofloClient(opts);
  await client.get(query);
  now += 119000;
  await client.get(query);
  assert.equal(calls, 1);
  now += 1000;
  rows = [];
  await client.get(query);
  assert.equal(calls, 2);
  now += 14999;
  await client.get(query);
  assert.equal(calls, 2);
  now++;
  await client.get(query);
  assert.equal(calls, 3);
});

test('failed requests are shared but never cached, and credentials have separate caches', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) throw new Error('synthetic network failure');
    return ok({ quotes: [{ status: 'Approved' }] });
  });
  const client = new ArofloClient(opts);
  const results = await Promise.allSettled([client.get(query), client.get(query)]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(calls, 1);
  await client.get(query);
  await new ArofloClient({ ...opts, orgEncoded: 'another-synthetic-org' }).get(query);
  assert.equal(calls, 3);
});

test('cache evicts least-recently used entries and enforces its memory budget', () => {
  const cache = createTtlCache(120, { maxEntries: 2, maxBytes: 50 });
  cache.set('a', 'one'); cache.set('b', 'two');
  assert.equal(cache.get('a'), 'one');
  cache.set('c', 'three');
  assert.equal(cache.get('b'), undefined);
  cache.set('large', 'x'.repeat(100));
  assert.equal(cache.get('large'), undefined);
  assert.equal(cache.get('a'), 'one');
  cache.set('d', 'x'.repeat(35));
  assert.equal(cache.get('c'), undefined, 'byte limit evicts independently of entry limit');
});

test('HTTP 429 HTML responses set cooldown, honour Retry-After, and preserve cached reads', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 2) return new Response('<html>busy</html>', { status: 429, headers: { 'Retry-After': '30' } });
    return ok({ quotes: [{ status: 'Approved' }] });
  });
  const client = new ArofloClient(opts);
  await client.get(query);
  const another = { zone: 'Tasks' };
  await assert.rejects(client.get(another), (e) => e.code === 'rate_limit' && e.retryAfter === 30);
  await client.get(query);
  await assert.rejects(client.get(another), (e) => e.code === 'rate_limit');
  assert.equal(calls, 2, 'cooldown cannot consume more requests');
  now += 30000;
  await client.get(another);
  assert.equal(calls, 3);
});

test('JSON minute, daily and per-second throttles are recognized even on HTTP 200', async (t) => {
  let status = 6;
  let now = Date.parse('2026-09-17T13:00:00Z'); // 23:00 Melbourne
  t.mock.method(Date, 'now', () => now);
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status })));
  for (status of [6, 7, 429]) {
    const client = new ArofloClient(opts);
    await assert.rejects(client.get(query), (e) => e.code === 'rate_limit' && e.retryAfter === (status === 7 ? 3600 : 60));
    await assert.rejects(client.get(query), (e) => e.code === 'rate_limit');
  }
  assert.equal(mock.mock.callCount(), 3);
});

test('daily cooldown respects both Melbourne daylight-saving transitions', () => {
  assert.equal(dailyResetSeconds(Date.parse('2026-10-03T14:00:00Z')), 23 * 3600);
  assert.equal(dailyResetSeconds(Date.parse('2026-04-04T13:00:00Z')), 25 * 3600);
});

test('queued requests recheck cooldown before dispatching', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 429 }));
  const client = new ArofloClient({ ...opts, minRequestIntervalMs: 20 });
  const results = await Promise.allSettled([client.get(query), client.get({ zone: 'Tasks' })]);
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason.code === 'rate_limit'));
  assert.equal(mock.mock.callCount(), 1);
});

function liveService(metricsEnabled = false) {
  return new QuoteService({ mockMode: false, jobNumberOnly: false, cacheTtlSeconds: 120,
    aroflo: { ...opts, metricsEnabled } });
}
function stubZones(t, { status = 'Approved', substatus = 'Booked', orgname = 'MAJOR MODS' } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const zone = new URL(url).searchParams.get('zone');
    calls.push(zone);
    const responses = {
      Quotes: { quotes: [{ status, org: { orgname }, contactname: 'Synthetic Funder', address: { postcode: '3000' } }] },
      Tasks: { tasks: [{ taskid: 'synthetic-task', status: 'Pending', substatus,
        tasklocation: { locationid: 'synthetic-location' } }] },
      Locations: { locations: [{ SiteContact: 'Synthetic Resident', postcode: '3999' }] },
      Schedules: { schedules: [{ scheduletype: { typeid: 'synthetic-task' },
        startdatetime: '2099-01-01 09:00:00', enddatetime: '2099-01-01 10:00:00' }] },
    };
    assert.ok(responses[zone]);
    return ok(responses[zone], { 'X-RateLimit-Daily-Limit': '2000', 'X-RateLimit-Daily-Remaining': '1234',
      'X-RateLimit-Secondary-Daily-Remaining': '19000', 'X-RateLimit-Remaining': 'invalid' });
  });
  return calls;
}

test('ten concurrent verified lookups cost four calls; wrong identity still fails on cached data', async (t) => {
  const calls = stubZones(t);
  const service = liveService();
  const results = await Promise.all(Array.from({ length: 10 }, () => service.lookup('999999999999', 'Synthetic Resident', '3999')));
  assert.ok(results.every((r) => r.outcome === 'verified' && r.quotes[0].booking.date === '2099-01-01'));
  assert.deepEqual(calls, ['Quotes', 'Tasks', 'Locations', 'Schedules']);
  assert.equal((await service.lookup('999999999999', 'Wrong Resident', '3999')).outcome, 'mismatch');
  assert.equal((await service.lookup('999999999999', 'Synthetic Resident', '3000')).outcome, 'mismatch');
  assert.equal((await service.lookup('999999999999', '', '')).outcome, 'verified');
  assert.equal(calls.length, 4);
});

test('a wrong first identity does not poison shared cached data for a later valid user', async (t) => {
  const calls = stubZones(t);
  const service = liveService();
  assert.equal((await service.lookup('999999999999', 'Wrong Resident', '3999')).outcome, 'mismatch');
  assert.equal(calls.length, 3);
  assert.equal((await service.lookup('999999999999', 'Synthetic Resident', '3999')).outcome, 'verified');
  assert.equal(calls.length, 4);
});

test('reviewed Minor Mods milestones avoid unused schedules; nonfinal quotes retain visits', async (t) => {
  const calls = stubZones(t, { substatus: 'Measures Complete', orgname: 'MINOR MODS' });
  const result = await liveService().lookup('999999999999', '', '');
  assert.equal(result.outcome, 'verified');
  assert.match(result.quotes[0].statusMessage, /taken measurements/);
  assert.deepEqual(calls, ['Quotes', 'Tasks']);
  t.mock.restoreAll();
  const nonfinalCalls = stubZones(t, { status: 'Pending Approval', substatus: 'Measures Complete', orgname: 'MINOR MODS' });
  await liveService().lookup('999999999999', '', '');
  assert.deepEqual(nonfinalCalls, ['Quotes', 'Tasks', 'Schedules']);
});

test('usage telemetry includes quota counters and timing but no identifiers or customer data', async (t) => {
  stubZones(t);
  const log = t.mock.method(console, 'info', () => {});
  const service = liveService(true);
  await service.lookup('999999999999', 'Synthetic Resident', '3999');
  await service.lookup('999999999999', 'Synthetic Resident', '3999');
  const [label, text] = log.mock.calls[1].arguments;
  const metric = JSON.parse(text);
  assert.equal(label, '[AroFlo usage]');
  assert.equal(metric.requests, 4);
  assert.equal(metric.cacheHits, 4);
  assert.equal(metric.rateLimits.dailyRemaining, 1234);
  assert.equal(metric.rateLimits.minuteRemaining, undefined);
  assert.ok(metric.lookupDurationMs >= 0);
  for (const secret of ['999999999999', 'Synthetic', 'synthetic', '3999', 'Authorization', 'quotes']) {
    assert.equal(text.includes(secret), false);
  }
});

test('a saturated request queue rejects excess distinct reads without an upstream call', async (t) => {
  const release = deferred();
  const mock = t.mock.method(globalThis, 'fetch', async () => { await release.promise; return ok({ quotes: [] }); });
  const client = new ArofloClient(opts);
  const pending = Array.from({ length: 32 }, (_, i) => client.get({ zone: 'Quotes', page: i + 1 }));
  await assert.rejects(client.get({ zone: 'Quotes', page: 33 }), (e) => e.code === 'rate_limit');
  release.resolve();
  await Promise.all(pending);
  assert.equal(mock.mock.callCount(), 32);
});

test('HTTP-date Retry-After is respected and missing quota headers stay unknown', async (t) => {
  const now = Date.parse('2026-09-18T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 429,
    headers: { 'Retry-After': new Date(now + 45000).toUTCString() } }));
  const client = new ArofloClient(opts);
  await assert.rejects(client.get(query), (e) => e.retryAfter === 45);
  assert.deepEqual(client.metrics.rateLimits, {});
});
