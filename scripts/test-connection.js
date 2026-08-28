/**
 * Live AroFlo connectivity check.
 *
 *   npm run check-aroflo
 *
 * Uses your real .env credentials to make ONE signed request to AroFlo and
 * reports whether authentication succeeded. Run this before flipping
 * MOCK_MODE to false. It does NOT print your secret key.
 */
import config, { validateConfig } from '../src/config.js';
import { ArofloClient, ArofloError } from '../src/aroflo/client.js';

function mask(v) {
  if (!v) return '(empty)';
  if (v.length <= 6) return v[0] + '***';
  return v.slice(0, 4) + '…' + v.slice(-2);
}

async function main() {
  console.log('\nAroFlo connection check');
  console.log('-----------------------');
  console.log('Base URL :', config.aroflo.baseUrl);
  console.log('uEncoded :', mask(config.aroflo.uEncoded));
  console.log('pEncoded :', mask(config.aroflo.pEncoded));
  console.log('orgEnc.  :', mask(config.aroflo.orgEncoded));
  console.log('secretKey:', config.aroflo.secretKey ? '(set, hidden)' : '(EMPTY!)');
  console.log('hostIp   :', config.aroflo.hostIp || '(none)');
  console.log('');

  const problems = validateConfig({ ...config, mockMode: false });
  if (problems.length) {
    console.error('✗ Missing configuration:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  const client = new ArofloClient({
    baseUrl: config.aroflo.baseUrl,
    secretKey: config.aroflo.secretKey,
    uEncoded: config.aroflo.uEncoded,
    pEncoded: config.aroflo.pEncoded,
    orgEncoded: config.aroflo.orgEncoded,
    hostIp: config.aroflo.hostIp,
  });

  try {
    // Smallest possible authenticated call: page 1 of Quotes.
    const resp = await client.get({ zone: 'Quotes', page: 1 });
    console.log('✓ SUCCESS — authentication worked.');
    console.log('  status        :', resp.status);
    console.log('  statusmessage :', resp.statusMessage);
    const quotes = resp.zoneResponse.quotes ?? [];
    console.log('  quotes on page:', quotes.length);
    process.exit(0);
  } catch (err) {
    if (err instanceof ArofloError) {
      console.error('✗ FAILED —', err.code.toUpperCase(), ':', err.message);
      if (err.code === 'auth') {
        console.error('  Check uEncoded / pEncoded / orgEncoded / secret key are correct and');
        console.error('  current (AroFlo > Site Admin > Settings > General > AroFlo API), and that');
        console.error('  AROFLO_HOST_IP matches your outbound IP if IP-locking is enabled.');
      }
      if (err.body) console.error('  body:', err.body);
    } else {
      console.error('✗ FAILED —', err.message);
    }
    process.exit(1);
  }
}

main();
