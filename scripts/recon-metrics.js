/**
 * READ-ONLY metrics gather for the "where does time go" analysis.
 *   node scripts/recon-metrics.js
 * GET-only. Paginates with dedup-by-id + retry, never assumes a page count.
 * Writes scripts/aroflo-metrics.json (aggregates only) for charting / verification.
 * Reference "today" is fixed to the session date so ageing is deterministic.
 */
import { writeFileSync } from 'node:fs';
import config from '../src/config.js';
import { ArofloClient } from '../src/aroflo/client.js';

const REF = Date.parse('2026-06-24'); // session date, per context — do not use wall clock
const client = new ArofloClient({
  baseUrl: config.aroflo.baseUrl, secretKey: config.aroflo.secretKey,
  uEncoded: config.aroflo.uEncoded, pEncoded: config.aroflo.pEncoded,
  orgEncoded: config.aroflo.orgEncoded, hostIp: config.aroflo.hostIp,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstArray = (zr) => { for (const v of Object.values(zr || {})) if (Array.isArray(v)) return v; return []; };
const day = (s) => Date.parse(String(s || '').replace(/\//g, '-').slice(0, 10));
const tally = (rows, get) => {
  const m = new Map();
  for (const r of rows) { const v = (get(r) ?? '(blank)') || '(blank)'; m.set(v, (m.get(v) || 0) + 1); }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
};
async function getRetry(q, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await client.get(q); }
    catch (e) { if (i === tries - 1) throw e; await sleep(1000); }
  }
}
/** Paginate a zone, dedup by idField, stop on short page / no-new-ids / cap. */
async function pull(zone, idField, cap = 25, pageSize = 200) {
  const seen = new Set(); const all = [];
  for (let page = 1; page <= cap; page++) {
    let rows;
    try { rows = firstArray((await getRetry({ zone, pageSize, page })).zoneResponse); }
    catch (e) { console.log(`  ${zone} page ${page} failed: ${e.message}`); break; }
    let fresh = 0;
    for (const r of rows) { const id = r[idField]; if (id && !seen.has(id)) { seen.add(id); all.push(r); fresh++; } }
    if (rows.length < pageSize || fresh === 0) break;
    await sleep(350);
  }
  return all;
}
const buckets = (vals, edges, labels) => {
  const out = labels.map((l) => ({ label: l, n: 0 }));
  for (const v of vals) { let i = edges.findIndex((e) => v <= e); if (i < 0) i = labels.length - 1; out[i].n++; }
  return out;
};

async function main() {
  const M = { generatedFor: '2026-06-24', notes: [] };

  // ---- QUOTES: full, deduped ----
  console.log('Pulling Quotes…');
  const quotes = await pull('Quotes', 'quoteid');
  const unitOf = (q) => (String(q?.org?.orgname || '').toLowerCase().includes('minor') ? 'Minor' : 'Major');
  M.quotes = {
    total: quotes.length,
    byUnit: tally(quotes, unitOf),
    byStatus: tally(quotes, (q) => q.status),
    byUnitStatus: tally(quotes, (q) => `${unitOf(q)} / ${q.status}`),
  };
  // Pending-approval ageing (createddate -> REF)
  const pendAges = quotes.filter((q) => /pending/i.test(q.status || ''))
    .map((q) => (REF - day(q.createddate)) / 86400000).filter((d) => Number.isFinite(d) && d >= 0);
  M.quotes.pendingApprovalAgeingDays = buckets(pendAges, [7, 14, 30, 60, 1e9],
    ['0-7d', '8-14d', '15-30d', '31-60d', '60d+']);
  M.quotes.pendingApprovalCount = pendAges.length;
  pendAges.sort((a, b) => a - b);
  M.quotes.pendingApprovalMedianAgeDays = pendAges.length ? pendAges[Math.floor(pendAges.length / 2)] : null;
  // Approved turnaround (created -> approved)
  const appDays = quotes.map((q) => [day(q.createddate), day(q.approveddate)])
    .filter(([c, a]) => Number.isFinite(c) && Number.isFinite(a) && a >= c).map(([c, a]) => (a - c) / 86400000);
  appDays.sort((a, b) => a - b);
  M.quotes.approvalTurnaround = appDays.length ? {
    n: appDays.length, median: appDays[Math.floor(appDays.length / 2)],
    p90: appDays[Math.floor(appDays.length * 0.9)], max: appDays[appDays.length - 1],
  } : null;

  // ---- TASKS: status + type backlog ----
  console.log('Pulling Tasks…');
  const tasks = await pull('Tasks', 'taskid', 10);
  const tUnit = (t) => (String(t?.org?.orgname || '').toLowerCase().includes('minor') ? 'Minor' : 'Major');
  M.tasks = {
    total: tasks.length,
    byStatus: tally(tasks, (t) => t.status),
    byType: tally(tasks, (t) => t.tasktype || t?.tasktasktype?.tasktype),
    byUnit: tally(tasks, tUnit),
  };
  // Task cycle time requestdate -> completeddate (where both present)
  const tCycle = tasks.map((t) => [day(t.requestdate), day(t.completeddate)])
    .filter(([r, c]) => Number.isFinite(r) && Number.isFinite(c) && c >= r).map(([r, c]) => (c - r) / 86400000);
  tCycle.sort((a, b) => a - b);
  M.tasks.cycleDays = tCycle.length ? { n: tCycle.length, median: tCycle[Math.floor(tCycle.length / 2)], max: tCycle[tCycle.length - 1] } : null;

  // ---- TIMESHEETS: real labour hours ----
  console.log('Pulling Timesheets…');
  const ts = await pull('Timesheets', 'timesheetid', 20);
  const hoursOf = (t) => parseFloat(t.hours) || 0;
  const sumBy = (get) => {
    const m = new Map();
    for (const t of ts) { const k = get(t) || '(blank)'; m.set(k, (m.get(k) || 0) + hoursOf(t)); }
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)]));
  };
  const dates = ts.map((t) => day(t.workdate)).filter(Number.isFinite);
  M.timesheets = {
    rows: ts.length,
    totalHours: Math.round(ts.reduce((s, t) => s + hoursOf(t), 0)),
    dateRange: dates.length ? { from: new Date(Math.min(...dates)).toISOString().slice(0, 10), to: new Date(Math.max(...dates)).toISOString().slice(0, 10) } : null,
    hoursByType: sumBy((t) => t.type),
    hoursByWorktype: sumBy((t) => t?.worktype?.worktypedescription),
    hoursByUserTop15: Object.fromEntries(Object.entries(sumBy((t) => `${t?.user?.givennames || ''} ${t?.user?.surname || ''}`.trim())).slice(0, 15)),
    distinctJobs: new Set(ts.map((t) => t?.task?.jobnumber).filter(Boolean)).size,
  };

  M.notes.push('Invoices zone returns 0 rows via API — payment timing NOT measurable.');
  M.notes.push('Task labours/materials/PO arrays come back empty even when fetched by taskid — per-task labour NOT in API; use Timesheets.');
  M.notes.push('PO datereceived/dateinvoiced usually blank — delivery/invoice lag NOT reliably measurable.');
  M.notes.push('Samples are API-paginated and deduped by id; not necessarily the entire historical DB.');

  writeFileSync(new URL('./aroflo-metrics.json', import.meta.url), JSON.stringify(M, null, 2));
  console.log('\n===== METRICS =====');
  console.log(JSON.stringify(M, null, 2));
  console.log('\nwrote scripts/aroflo-metrics.json');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
