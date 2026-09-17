/**
 * READ-ONLY AroFlo workflow recon.
 *
 *   node scripts/analyze-aroflo.js
 *
 * Makes a bounded set of signed GET requests to understand how MAM actually uses
 * AroFlo (major vs minor mods, tasks, subcontractors/tradies). It NEVER writes —
 * the client only supports GET. Output is a compact summary, no secrets, no PII
 * beyond what is needed to understand the data shape (names are redacted).
 */
import { createReconClient, sleep } from './recon-helpers.js';
import { ArofloError } from '../src/aroflo/client.js';

const client = createReconClient();

/** Get a zone's first record-array out of the zoneResponse, whatever it's keyed as. */
function firstArray(zoneResponse) {
  for (const [k, v] of Object.entries(zoneResponse || {})) {
    if (Array.isArray(v)) return { key: k, rows: v };
  }
  return { key: null, rows: [] };
}

/** Recursively collect dotted field paths from a sample record (depth-limited). */
function fieldPaths(obj, prefix = '', depth = 0, out = new Set()) {
  if (depth > 2 || obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.add(path + ' {}');
      fieldPaths(v, path, depth + 1, out);
    } else if (Array.isArray(v)) {
      out.add(path + ' []');
    } else {
      out.add(path);
    }
  }
  return out;
}

async function probe(zone, opts = {}) {
  try {
    const resp = await client.get({ zone, pageSize: opts.pageSize ?? 1, page: 1, ...opts.extra });
    const { key, rows } = firstArray(resp.zoneResponse);
    return { zone, ok: true, key, count: rows.length, rows, raw: resp };
  } catch (err) {
    const msg = err instanceof ArofloError ? `${err.code}: ${err.message}` : err.message;
    return { zone, ok: false, error: msg };
  }
}

function tally(rows, getter) {
  const m = new Map();
  for (const r of rows) {
    const v = getter(r) || '(blank)';
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  console.log('\n=== AroFlo READ-ONLY recon ===');
  console.log('Mode:', config.mockMode ? 'MOCK' : 'LIVE');

  // 1) Which zones are accessible? (one tiny call each)
  const candidates = [
    'Quotes', 'Tasks', 'Schedule', 'Clients', 'Suppliers', 'Contacts',
    'PurchaseOrders', 'Timesheets', 'Invoices', 'Projects', 'Inventory',
    'Locations', 'Assets', 'BusinessUnits', 'Users', 'Substatuses',
    'Compliance', 'Notes', 'Documents', 'StockTransfers',
  ];
  console.log('\n--- Zone availability ---');
  const available = [];
  for (const z of candidates) {
    const p = await probe(z, { pageSize: 1 });
    if (p.ok) {
      available.push(p);
      console.log(`  ✓ ${z.padEnd(16)} key=${p.key} sampleRows=${p.count}`);
    } else {
      console.log(`  ✗ ${z.padEnd(16)} ${p.error}`);
    }
    await sleep(350); // stay well under ~3/sec
  }

  // 2) Field shape of the key zones.
  for (const zone of ['Quotes', 'Tasks', 'Schedule', 'PurchaseOrders', 'Suppliers']) {
    const hit = available.find((a) => a.zone === zone);
    if (!hit || !hit.rows.length) continue;
    const paths = [...fieldPaths(hit.rows[0])].sort();
    console.log(`\n--- ${zone}: ${paths.length} fields on sample record ---`);
    console.log('  ' + paths.join('\n  '));
  }

  // 3) Quotes aggregate: status x business unit x substatus, over a sample.
  console.log('\n--- Quotes sample aggregate (pageSize 200, up to 3 pages) ---');
  const quotes = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const resp = await client.get({ zone: 'Quotes', pageSize: 200, page });
      const { rows } = firstArray(resp.zoneResponse);
      quotes.push(...rows);
      if (rows.length < 200) break;
    } catch (err) {
      console.log('  (stopped:', err.message, ')');
      break;
    }
    await sleep(350);
  }
  console.log('  sampled quotes:', quotes.length);
  const orgOf = (q) => q?.org?.orgname || '(no org)';
  const subOf = (q) => (typeof q?.substatus === 'string' ? q.substatus : q?.substatus?.substatus) || '(none)';
  console.log('\n  by business unit (org.orgname):');
  for (const [k, n] of tally(quotes, orgOf)) console.log(`    ${String(n).padStart(4)}  ${k}`);
  console.log('\n  by status:');
  for (const [k, n] of tally(quotes, (q) => q.status)) console.log(`    ${String(n).padStart(4)}  ${k}`);
  console.log('\n  by substatus:');
  for (const [k, n] of tally(quotes, subOf)) console.log(`    ${String(n).padStart(4)}  ${k}`);
  console.log('\n  funder (client.orgname) top 12:');
  for (const [k, n] of tally(quotes, (q) => q?.client?.orgname).slice(0, 12)) console.log(`    ${String(n).padStart(4)}  ${k}`);

  // 4) Quote lifecycle timing: created -> approved (days), where both present.
  const days = [];
  for (const q of quotes) {
    const c = Date.parse(String(q.createddate || '').replace(/\//g, '-'));
    const a = Date.parse(String(q.approveddate || '').replace(/\//g, '-'));
    if (Number.isFinite(c) && Number.isFinite(a) && a >= c) days.push((a - c) / 86400000);
  }
  if (days.length) {
    days.sort((x, y) => x - y);
    const med = days[Math.floor(days.length / 2)];
    const avg = days.reduce((s, d) => s + d, 0) / days.length;
    console.log(`\n  approval turnaround (n=${days.length}): median ${med.toFixed(0)}d, avg ${avg.toFixed(0)}d, max ${Math.max(...days).toFixed(0)}d`);
  }

  // 5) Tasks aggregate, if available.
  const tHit = available.find((a) => a.zone === 'Tasks');
  if (tHit) {
    console.log('\n--- Tasks sample aggregate (pageSize 200, 1 page) ---');
    try {
      const resp = await client.get({ zone: 'Tasks', pageSize: 200, page: 1 });
      const { rows } = firstArray(resp.zoneResponse);
      console.log('  sampled tasks:', rows.length);
      console.log('  by status:');
      for (const [k, n] of tally(rows, (t) => t.status || t.taskstatus)) console.log(`    ${String(n).padStart(4)}  ${k}`);
    } catch (err) {
      console.log('  (tasks aggregate failed:', err.message, ')');
    }
  }

  console.log('\n=== done ===\n');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
