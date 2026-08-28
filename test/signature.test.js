import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArofloClient } from '../src/aroflo/client.js';

/**
 * These tests lock in the AroFlo HMAC signing contract so it cannot silently
 * drift. The expected signature is a known-answer value computed from fixed
 * inputs; if the payload assembly changes, this test fails loudly.
 */

function fixedClient(extra = {}) {
  return new ArofloClient({
    baseUrl: 'https://api.aroflo.com/',
    secretKey: 'test-secret-key',
    uEncoded: 'U+ENC==',
    pEncoded: 'P/ENC==',
    orgEncoded: 'ORG==',
    ...extra,
  });
}

test('buildAuthorization URI-encodes each credential', () => {
  const c = fixedClient();
  assert.equal(
    c.buildAuthorization(),
    'uencoded=U%2BENC%3D%3D&pencoded=P%2FENC%3D%3D&orgEncoded=ORG%3D%3D'
  );
});

test('buildVarString produces a Quotes-by-jobnumber query', () => {
  const v = ArofloClient.buildVarString({ zone: 'Quotes', where: ['and|jobnumber|=|1048'] });
  assert.equal(v, 'zone=Quotes&where=and%7Cjobnumber%7C%3D%7C1048');
});

test('payload fields are joined in the exact AroFlo order (no HostIP)', () => {
  const c = fixedClient();
  const payload = c.buildPayload({
    method: 'GET',
    authorization: 'AUTH',
    afDateTimeUtc: '2024-01-02T03:04:05.678Z',
    varString: 'zone=Quotes',
  });
  // method + urlPath('') + accept + authorization + timestamp + varString
  assert.equal(payload, 'GET++text/json+AUTH+2024-01-02T03:04:05.678Z+zone=Quotes');
});

test('payload includes HostIP immediately after the method when configured', () => {
  const c = fixedClient({ hostIp: '203.0.113.7' });
  const payload = c.buildPayload({
    method: 'GET',
    authorization: 'AUTH',
    afDateTimeUtc: 'TS',
    varString: 'zone=Quotes',
  });
  assert.equal(payload, 'GET+203.0.113.7++text/json+AUTH+TS+zone=Quotes');
});

test('sign() is HMAC-SHA512 hex (128 chars) and deterministic / known-answer', () => {
  const c = fixedClient();
  const payload = c.buildPayload({
    method: 'GET',
    authorization: c.buildAuthorization(),
    afDateTimeUtc: '2024-01-02T03:04:05.678Z',
    varString: ArofloClient.buildVarString({ zone: 'Quotes', where: ['and|jobnumber|=|1048'] }),
  });
  const sig = c.sign(payload);
  assert.match(sig, /^[0-9a-f]{128}$/);
  // Known-answer (regenerate with scripts/print-test-vector.js if signing changes intentionally):
  assert.equal(sig, 'e8f0c6835b1e0f27238155e8db857ffd7d0a84c43720d683e65012a04c50cee367a2cf12cf7a5ff4f837889761cad09141afae09796da7f6b9148cf11d2f6f1f');
});
