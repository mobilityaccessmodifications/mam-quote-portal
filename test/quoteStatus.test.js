import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteRouter } from '../src/routes/quoteStatus.js';
import { QuoteService } from '../src/aroflo/quoteService.js';
import { ArofloError } from '../src/aroflo/client.js';

function handler(overrides = {}) {
  const router = createQuoteRouter({ mockMode: true, jobNumberOnly: false,
    cacheTtlSeconds: 120, negResponseFloorMs: 0, negResponseJitterMs: 0,
    verboseClientErrors: false, ...overrides });
  return router.stack.find((layer) => layer.route?.path === '/quote-status').route.stack[0].handle;
}

async function request(handle, body) {
  const response = { statusCode: 200, payload: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; } };
  await handle({ body }, response);
  return response;
}

const syntheticQuote = { statusLabel: 'Approved', quoteName: 'Synthetic quote' };

test('route rejects invalid input before lookup and honours job-only mode', async (t) => {
  const lookup = t.mock.method(QuoteService.prototype, 'lookup', async () => ({ outcome: 'notfound' }));
  const handle = handler();
  for (const body of [undefined, { jobNumber: 'bad' },
    { jobNumber: '999999999999', clientName: 'X' },
    { jobNumber: '999999999999', postcode: '12' }]) {
    assert.equal((await request(handle, body)).statusCode, 400);
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal((await request(handler({ jobNumberOnly: true }), {
    jobNumber: '999999999999', clientName: 'X', postcode: '12',
  })).statusCode, 200);
  assert.equal(lookup.mock.callCount(), 1);
});

test('route revalidates every lookup instead of caching authorization results', async (t) => {
  const lookup = t.mock.method(QuoteService.prototype, 'lookup', async () => ({
    outcome: 'verified', quotes: [syntheticQuote], locationName: 'Synthetic location',
  }));
  const handle = handler();
  const body = { jobNumber: '999999999999', clientName: 'Synthetic Resident', postcode: '3999' };
  const first = await request(handle, body);
  assert.deepEqual(first.payload, { ok: true, found: true, verified: true,
    jobNumber: body.jobNumber, locationName: 'Synthetic location', quotes: [syntheticQuote] });
  assert.deepEqual((await request(handle, { ...body, clientName: 'synthetic resident' })).payload, first.payload);
  assert.equal(lookup.mock.callCount(), 2);
  await request(handle, { ...body, postcode: '3000' });
  assert.equal(lookup.mock.callCount(), 3);
});

test('route returns the same public failure for mismatch and notfound, including repeated requests', async (t) => {
  let outcome = 'mismatch';
  const lookup = t.mock.method(QuoteService.prototype, 'lookup', async () => ({ outcome }));
  const handle = handler();
  const mismatch = await request(handle, { jobNumber: '999999999999' });
  outcome = 'notfound';
  const missing = await request(handle, { jobNumber: '999999999998' });
  assert.deepEqual(mismatch.payload, missing.payload);
  assert.equal(missing.payload.verified, false);
  assert.deepEqual((await request(handle, { jobNumber: '999999999998' })).payload, missing.payload);
  assert.equal(lookup.mock.callCount(), 3);
});

test('route maps provider failures to safe 502 responses and does not cache errors', async (t) => {
  t.mock.method(console, 'error', () => {});
  const lookup = t.mock.method(QuoteService.prototype, 'lookup', async () => {
    throw new ArofloError('synthetic private provider detail', { code: 'auth' });
  });
  const handle = handler();
  for (let i = 0; i < 2; i++) {
    const response = await request(handle, { jobNumber: '999999999999' });
    assert.equal(response.statusCode, 502);
    assert.equal(response.payload.ok, false);
    assert.equal(JSON.stringify(response.payload).includes('private provider detail'), false);
  }
  assert.equal(lookup.mock.callCount(), 2);
});

test('route exposes a safe retry delay for provider throttling without private logs', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(QuoteService.prototype, 'lookup', async () => {
    throw new ArofloError('synthetic private data', { code: 'rate_limit', retryAfter: 42, body: 'private body' });
  });
  const response = await request(handler(), { jobNumber: '999999999999' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['Retry-After'], '42');
  assert.equal(JSON.stringify(response.payload).includes('private'), false);
  assert.deepEqual(log.mock.calls[0].arguments, ['[AroFlo error]', 'rate_limit']);
});
