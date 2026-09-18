import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Run a tiny script in a child process with a controlled env; return parsed JSON. */
function loadConfig(env) {
  const script =
    "import config, { validateConfig } from './src/config.js';" +
    "console.log(JSON.stringify({ trustProxy: config.trustProxy, unsafe: config.trustProxyUnsafe, problems: validateConfig() }));";
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    // MOCK_MODE=true so validateConfig doesn't require credentials; our env wins over .env.
    env: { ...process.env, MOCK_MODE: 'true', ...env },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('TRUST_PROXY=true is refused — forced to false and flagged as a problem', () => {
  const c = loadConfig({ TRUST_PROXY: 'true' });
  assert.equal(c.trustProxy, false);
  assert.equal(c.unsafe, true);
  assert.ok(c.problems.some((p) => /TRUST_PROXY/.test(p)), 'should report a TRUST_PROXY problem');
});

test('TRUST_PROXY accepts an explicit hop count and a CIDR without flagging', () => {
  const hops = loadConfig({ TRUST_PROXY: '2' });
  assert.equal(hops.trustProxy, 2);
  assert.equal(hops.unsafe, false);

  const cidr = loadConfig({ TRUST_PROXY: '10.0.0.0/8' });
  assert.equal(cidr.trustProxy, '10.0.0.0/8');
  assert.equal(cidr.unsafe, false);
});

test('server refuses to start when TRUST_PROXY=true (non-zero exit)', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ['server.js'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, MOCK_MODE: 'true', TRUST_PROXY: 'true' },
      }),
    (err) => err.status === 1
  );
});

test('validateConfig flags verbose errors on a live deployment', () => {
  const problems = validateConfig({
    mockMode: false,
    verboseClientErrors: true,
    trustProxyUnsafe: false,
    aroflo: { secretKey: 'x', uEncoded: 'x', pEncoded: 'x', orgEncoded: 'x' },
  });
  assert.ok(problems.some((p) => /VERBOSE_CLIENT_ERRORS/.test(p)));
});

test('validateConfig passes for a clean live configuration', () => {
  const problems = validateConfig({
    mockMode: false,
    verboseClientErrors: false,
    trustProxyUnsafe: false,
    aroflo: { secretKey: 'x', uEncoded: 'x', pEncoded: 'x', orgEncoded: 'x' },
  });
  assert.deepEqual(problems, []);
});

test('shared mode requires a complete HTTPS Redis configuration', () => {
  const cfg = { mockMode:false, aroflo:{secretKey:'x',uEncoded:'x',pEncoded:'x',orgEncoded:'x'}, shared:{enabled:true} };
  assert.ok(validateConfig(cfg).some(p=>p.includes('Redis')));
  cfg.shared={enabled:true,url:'http://redis.invalid',token:'synthetic'};
  assert.ok(validateConfig(cfg).some(p=>p.includes('HTTPS')));
  cfg.shared.url='https://redis.invalid';
  assert.deepEqual(validateConfig(cfg),[]);
});
