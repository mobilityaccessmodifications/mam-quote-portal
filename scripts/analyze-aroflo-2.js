/**
 * READ-ONLY AroFlo recon, part 2: tradie/subcontractor model + true unit split.
 *   node scripts/analyze-aroflo-2.js
 */
import { createReconClient, sleep, firstArray } from './recon-helpers.js';

const client = createReconClient();

const tally = (rows, get) => {
  const m = new Map();
  for (const r of rows) { const v = get(r) || '(blank)'; m.set(v, (m.get(v) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

async function main() {
  // 1) Supplier types — are tradies/subcontractors modelled here?
  console.log('--- Suppliers: type breakdown (sample 200) ---');
  try {
    const r = await client.get({ zone: 'Suppliers', pageSize: 200, page: 1 });
    const rows = firstArray(r.zoneResponse);
    console.log('  sampled suppliers:', rows.length);
    for (const [k, n] of tally(rows, (s) => s.suppliertype)) console.log(`    ${String(n).padStart(4)}  ${k}`);
    // show a couple of redacted examples
    console.log('  examples:');
    for (const s of rows.slice(0, 6)) {
      console.log(`    - type=${s.suppliertype || '?'} terms=${s.terms || '?'} hasEmail=${!!s.email} contacts=${(s.contacts || []).length}`);
    }
  } catch (e) { console.log('  failed:', e.message); }
  await sleep(400);

  // 2) Find a populated Task (with labour/materials/PO) by scanning a page of non-Quote tasks.
  console.log('\n--- Tasks: looking for a populated job record ---');
  try {
    const r = await client.get({ zone: 'Tasks', pageSize: 200, page: 1 });
    const rows = firstArray(r.zoneResponse);
    const rich = rows
      .map((t) => ({
        job: t.jobnumber,
        status: t.status,
        type: t.tasktype || t?.tasktasktype?.tasktype,
        assigneds: (t.assigneds || []).length,
        labours: (t.labours || []).length,
        materials: (t.materials || []).length,
        pos: (t.purchaseorders || []).length,
        expenses: (t.expenses || []).length,
        hasQuote: !!(t.quote && Object.keys(t.quote).length),
      }))
      .filter((t) => t.assigneds + t.labours + t.materials + t.pos + t.expenses > 0);
    console.log('  tasks with any labour/material/PO/expense/assignee:', rich.length, 'of', rows.length);
    console.log('  task status x tasktype (sample):');
    for (const [k, n] of tally(rows, (t) => `${t.status} / ${t.tasktype || t?.tasktasktype?.tasktype || '?'}`).slice(0, 15)) {
      console.log(`    ${String(n).padStart(4)}  ${k}`);
    }
    console.log('  richest examples:');
    for (const t of rich.sort((a, b) => (b.labours + b.materials + b.pos) - (a.labours + a.materials + a.pos)).slice(0, 8)) {
      console.log(`    - job ${t.job} [${t.status}/${t.type}] assignees=${t.assigneds} labour=${t.labours} materials=${t.materials} POs=${t.pos} exp=${t.expenses} quote=${t.hasQuote}`);
    }
  } catch (e) { console.log('  failed:', e.message); }
  await sleep(400);

  // 3) PurchaseOrders: status + supplier spread (who do we order from / sub out to?)
  console.log('\n--- PurchaseOrders: status + top suppliers (sample 200) ---');
  try {
    const r = await client.get({ zone: 'PurchaseOrders', pageSize: 200, page: 1 });
    const rows = firstArray(r.zoneResponse);
    console.log('  sampled POs:', rows.length);
    for (const [k, n] of tally(rows, (p) => p.status)) console.log(`    status ${String(n).padStart(4)}  ${k}`);
    console.log('  top supplier orgs on POs:');
    for (const [k, n] of tally(rows, (p) => p?.supplier?.orgname).slice(0, 12)) console.log(`    ${String(n).padStart(4)}  ${k}`);
    const linked = rows.filter((p) => (p.tasks || []).length).length;
    console.log(`  POs linked to a task/job: ${linked}/${rows.length}`);
  } catch (e) { console.log('  failed:', e.message); }
  await sleep(400);

  // 4) True major/minor split — paginate Quotes fully (cap 12 pages = 2400).
  console.log('\n--- Quotes: full unit + status split (paginate, cap 12 pages) ---');
  const quotes = [];
  for (let page = 1; page <= 12; page++) {
    try {
      const r = await client.get({ zone: 'Quotes', pageSize: 200, page });
      const rows = firstArray(r.zoneResponse);
      quotes.push(...rows);
      if (rows.length < 200) break;
    } catch (e) { console.log('  (stopped page', page, ':', e.message, ')'); break; }
    await sleep(350);
  }
  console.log('  total quotes scanned:', quotes.length);
  const orgOf = (q) => q?.org?.orgname || '(no org)';
  for (const [k, n] of tally(quotes, orgOf)) console.log(`    unit ${String(n).padStart(5)}  ${k}`);
  console.log('  status overall:');
  for (const [k, n] of tally(quotes, (q) => q.status)) console.log(`    ${String(n).padStart(5)}  ${k}`);
  // acceptancestatus + expiry presence
  const withExpiry = quotes.filter((q) => q.acceptanceexpirydate && /\d/.test(q.acceptanceexpirydate)).length;
  console.log(`  quotes carrying an acceptance-expiry date: ${withExpiry}/${quotes.length}`);
  console.log('  acceptancestatus spread:');
  for (const [k, n] of tally(quotes, (q) => q.acceptancestatus).slice(0, 8)) console.log(`    ${String(n).padStart(5)}  ${k}`);

  console.log('\n=== done part 2 ===');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
