import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/shared/coordinator.js';
import { RedisRest } from '../src/shared/redis.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { QuoteService } from '../src/aroflo/quoteService.js';
import { ArofloClient } from '../src/aroflo/client.js';

const secret = 'synthetic-cache-secret';
test('encrypted cache is authenticated and contains no plaintext identifiers', () => {
  const a = new Coordinator({ redis: {}, secret });
  const b = new Coordinator({ redis: {}, secret: 'another-secret' });
  const data = { name: 'Synthetic Resident', job: '999999999999' };
  const value = a.seal(data);
  assert.deepEqual(a.open(value), data);
  assert.ok(!value.includes(data.name));
  assert.notEqual(a.hash(data.job), b.hash(data.job));
  assert.throws(() => b.open(value), { code: 'shared_unavailable' });
});

test('REST transport never follows redirects or exposes provider error secrets', async (t) => {
  const redis = new RedisRest({ url: 'https://redis.invalid', token: 'synthetic-token' });
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
    return new Response(JSON.stringify({ error: 'private-provider-secret' }));
  });
  await assert.rejects(redis.command(['PING']), (e) => e.code === 'shared_unavailable' && !e.message.includes('private'));
  assert.throws(() => new RedisRest({ url: 'http://redis.invalid', token: '' }));
});

test('shared IP limiter uses trusted resolved IP and fails closed on outage', async () => {
  let seen;
  const coordinator = { limitIp: async (ip) => { seen=ip; return { count: 3, retryAfter: 8 }; } };
  const limit = createRateLimiter({ max: 2, windowSeconds: 10 }, { coordinator });
  const res = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(c) { this.code=c; return this; }, json(v) { this.value=v; return this; } };
  let called = false;
  await limit({ ip: 'synthetic-ip', headers: { 'x-forwarded-for': 'spoofed' } }, res, () => { called=true; });
  assert.equal(seen,'synthetic-ip'); assert.equal(called,false); assert.equal(res.code,429);
  coordinator.limitIp = async () => { throw new Error('private'); };
  await limit({ ip: 'synthetic-ip', headers: {} }, res, () => { called=true; });
  assert.equal(res.code,503); assert.equal(called,false); assert.equal(JSON.stringify(res.value).includes('private'),false);
});

function serviceWithJoin(location) {
  const cfg = { mockMode: true, jobNumberOnly: false, aroflo: {} };
  const service = new QuoteService(cfg); service.cfg.mockMode = false;
  const calls=[];
  service.client = { get: async (q) => {
    calls.push(q.zone);
    return { zoneResponse: {
      quotes: [{ status: 'Approved', org: { orgname: 'MINOR MODS' } }],
      tasks: [{ taskid: 'synthetic-task', status: 'Pending', substatus: 'Measures Complete', tasklocation: { locationid: 'synthetic-location' }, location }],
      locations: [{ SiteContact: 'Synthetic Resident', postcode: '3999' }],
    } };
  } };
  return { service, calls };
}
test('complete joined location eliminates lookup and remains authoritative for identity', async () => {
  const {service,calls}=serviceWithJoin({ locationid:'synthetic-location',SiteContact:'Synthetic Resident',postcode:'3999' });
  assert.equal((await service.lookup('999999999999','Synthetic Resident','3999')).outcome,'verified');
  assert.deepEqual(calls,['Quotes','Tasks']);
  assert.equal((await service.lookup('999999999999','Wrong Resident','3999')).outcome,'mismatch');
});
test('incomplete or wrong-location joins fall back to authoritative Locations lookup', async () => {
  for (const location of [{ locationid:'synthetic-location',postcode:'3999' }, { locationid:'wrong', SiteContact:'Wrong Resident',postcode:'3999' }]) {
    const {service,calls}=serviceWithJoin(location);
    assert.equal((await service.lookup('999999999999','Synthetic Resident','3999')).outcome,'verified');
    assert.deepEqual(calls,['Quotes','Tasks','Locations']);
  }
});
test('collection pagination includes later pages and refuses truncated results', async () => {
  const client = new ArofloClient({});
  client.get = async (q) => ({ zoneResponse: { quotes: q.page === 2 ? [{ quoteid:'second' }] : [{quoteid:'first'},{quoteid:'middle'}], maxpageresults:2 } });
  const result = await client.getCollection({ zone:'Quotes' });
  assert.equal(result.zoneResponse.quotes.length,3);
  client.get = async () => ({ zoneResponse: { quotes:[{},{}],maxpageresults:2 } });
  await assert.rejects(client.getCollection({ zone:'Quotes' }), /pagination incomplete/);
});
