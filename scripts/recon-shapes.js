/**
 * READ-ONLY discovery: field shapes for zones/records I haven't inspected yet.
 *   node scripts/recon-shapes.js
 * GET-only. No writes. Redacts nothing structural, but prints no obvious PII values.
 */
import { createReconClient, sleep, firstArray } from './recon-helpers.js';

const client = createReconClient();

function paths(obj, p = '', d = 0, out = new Set()) {
  if (d > 2 || obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) { out.add(path + ' {}'); paths(v, path, d + 1, out); }
    else if (Array.isArray(v)) { out.add(path + ` [${v.length}]`); if (v[0] && typeof v[0] === 'object') paths(v[0], path + '[]', d + 1, out); }
    else out.add(`${path} = ${String(v).slice(0, 40)}`);
  }
  return out;
}
async function getRetry(q, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await client.get(q); }
    catch (e) { if (i === tries - 1) throw e; await sleep(800); }
  }
}

async function main() {
  // Timesheets shape + first record's full content (this is REAL labour time).
  console.log('=== Timesheets (sample record, full) ===');
  try {
    const r = await getRetry({ zone: 'Timesheets', pageSize: 3, page: 1 });
    const rows = firstArray(r.zoneResponse);
    console.log('rows:', rows.length);
    if (rows[0]) console.log([...paths(rows[0])].sort().join('\n'));
  } catch (e) { console.log('Timesheets failed:', e.message); }
  await sleep(400);

  console.log('\n=== Invoices (try a few) ===');
  for (const extra of [{}, { pageSize: 5, page: 1 }]) {
    try {
      const r = await getRetry({ zone: 'Invoices', ...extra });
      const rows = firstArray(r.zoneResponse);
      console.log('variant', JSON.stringify(extra), '-> rows:', rows.length);
      if (rows[0]) { console.log([...paths(rows[0])].sort().join('\n')); break; }
    } catch (e) { console.log('Invoices failed:', e.message); }
    await sleep(400);
  }

  // Populated single Task: grab one taskid from the list, then fetch it directly.
  console.log('\n=== Single Task (populated arrays?) ===');
  try {
    const list = await getRetry({ zone: 'Tasks', pageSize: 20, page: 1 });
    const tasks = firstArray(list.zoneResponse);
    const withId = tasks.find((t) => t.taskid);
    console.log('picked taskid:', withId?.taskid, 'status:', withId?.status, 'type:', withId?.tasktype);
    await sleep(400);
    const one = await getRetry({ zone: 'Tasks', where: [`and|taskid|=|${withId.taskid}`] });
    const full = firstArray(one.zoneResponse)[0];
    if (full) {
      const arr = ['assigneds', 'labours', 'materials', 'purchaseorders', 'expenses', 'tasknotes', 'customfields', 'documentsandphotos'];
      console.log('array sizes on full record:');
      for (const a of arr) console.log(`  ${a}: ${(full[a] || []).length}`);
      console.log('timing fields:', JSON.stringify({
        requestdate: full.requestdate, completeddate: full.completeddate,
        duedate: full.duedate, createdutc: full.createdutc,
      }));
      if ((full.labours || [])[0]) console.log('labour[0] keys:', Object.keys(full.labours[0]).join(','));
    }
  } catch (e) { console.log('Single Task failed:', e.message); }
  await sleep(400);

  // Populated single PO.
  console.log('\n=== Single PurchaseOrder (populated) ===');
  try {
    const list = await getRetry({ zone: 'PurchaseOrders', pageSize: 5, page: 1 });
    const pos = firstArray(list.zoneResponse);
    const one = pos[0];
    console.log('PO timing sample:', JSON.stringify({
      purchasedate: one?.purchasedate, deliverybydate: one?.deliverybydate,
      datereceived: one?.datereceived, dateinvoiced: one?.dateinvoiced,
      status: one?.status, supplierinvoicenumber: one?.supplierinvoicenumber,
    }));
  } catch (e) { console.log('PO failed:', e.message); }

  console.log('\n=== done shapes ===');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
