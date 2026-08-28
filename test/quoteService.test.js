import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuoteService,
  sanitiseQuote,
  deriveStatus,
  deriveJobStatus,
  quoteCreatedTs,
  quoteContactName,
  taskSubstatus,
  locationNameFor,
  publicTradeName,
  confirmedWindowFromNote,
  sanitiseBooking,
  selectRelevantTask,
  selectRelevantSchedule,
  hasCompletedSiteVisit,
  isValidJobNumber,
  isValidName,
  isValidPostcode,
  normalisePostcode,
  nameMatches,
  clientNameMatches,
  postcodeMatches,
  locationSiteContactName,
  locationContactMatches,
  locationPostcodeMatches,
  taskLocationId,
  schedulerSlaType,
  schedulerSlaFor,
} from '../src/aroflo/quoteService.js';

/**
 * Locks in the mapping from the REAL AroFlo Quotes response shape (lowercase keys,
 * as documented in the AroFlo API) to our customer-safe object. If AroFlo's field
 * names are wrong in the code, these assertions fail instead of silently blanking.
 */
const RAW_AROFLO_QUOTE = {
  quotename: 'Front entry modular access ramp',
  status: 'In Progress',
  org: { orgname: 'MAJOR MODS' },
  substatus: { substatus: 'Drafted for Review' },
  totalinc: '4114.0800',
  createddate: '2026/05/18',
  createddatetime: '2026/05/18 10:17:32',
  duedate: '2026/06/18',
  approveddate: '',
  refno: 'TeCl_2 2',
  jobnumber: '1070',
  contactname: 'Jane Doe',
};

test('sanitiseQuote maps real AroFlo fields and the per-unit status to customer-safe output', () => {
  const out = sanitiseQuote(RAW_AROFLO_QUOTE);
  assert.equal(out.quoteName, 'Front entry modular access ramp');
  assert.equal(out.amountIncTax, undefined);
  assert.equal(out.totalinc, undefined);
  assert.equal(out.dateCreated, '2026/05/18');
  assert.equal(out.reference, 'TeCl_2 2');
  // Until the quote is approved, the public state is simply quoted/awaiting approval.
  assert.equal(out.unit, 'major');
  assert.equal(out.unitLabel, 'Major home modification');
  assert.equal(out.statusLabel, 'Quoted — awaiting approval');
  assert.equal(out.step, 1);
  assert.deepEqual(out.steps, ['Quoted', 'Approved', 'Booked', 'Complete']);
  // Internal cost/margin fields must NOT leak through.
  assert.equal(out.totalprofit, undefined);
  assert.equal(out.materialcostex, undefined);
});

test('deriveStatus produces distinct per-unit flows from status + substatus', () => {
  // Major mods: 3-step flow; substatus surfaces during In Progress.
  const major = deriveStatus('In Progress', '', 'major');
  assert.deepEqual(major.steps, ['In progress', 'Pending approval', 'Approved']);
  assert.equal(major.step, 1);
  assert.equal(deriveStatus('Pending Approval', '', 'major').step, 2);
  assert.equal(deriveStatus('Approved', '', 'major').step, 3); // last step
  assert.equal(deriveStatus('In Progress', 'Awaiting OT Approval - Non-Standard Plan', 'major').label, 'Awaiting OT approval');

  // Rejected is terminal and must NOT leak the (sensitive) substatus reason.
  const rej = deriveStatus('Rejected', 'Selected Another Builder - With Cancellation Fee', 'major');
  assert.equal(rej.terminal, 'declined');
  assert.equal(rej.step, 0);
  assert.equal(rej.label, 'Not proceeding');
  assert.ok(!/cancellation|builder/i.test(rej.message), 'rejection reason must stay private');

  // Minor mods: simpler flow with different labels and no substatus handling.
  const minor = deriveStatus('In Progress', '', 'minor');
  assert.deepEqual(minor.steps, ['In progress', 'Quote ready', 'Approved']);
  assert.equal(minor.unitLabel, 'Minor modification');
});

test('deriveJobStatus maps the team-approved public workflow', () => {
  assert.equal(deriveJobStatus('In Progress', '', 'minor').label, 'Quoted — awaiting approval');
  assert.equal(deriveJobStatus('Approved', '', 'minor', {
    status: 'Not Started', substatus: { substatus: 'To Be Booked In' },
  }).label, 'Approved — to be booked');
  const customReadyToInstall = deriveJobStatus('Approved', '', 'minor', {
    status: 'In Progress',
    tasktype: 'Custom Install',
    substatus: { substatus: 'To Be Booked In' },
  });
  assert.equal(customReadyToInstall.label, 'In progress — installation to be booked');
  assert.equal(
    customReadyToInstall.message,
    'Your custom-install job is in progress and nearing completion. Our scheduler will be in touch to book the installation.',
  );
  assert.equal(customReadyToInstall.schedulerSlaType, 'installation');
  const externalContractor = deriveJobStatus('Approved', '', 'minor', {
    status: 'Not Started',
    tasktype: 'External Contractor Only',
    substatus: { substatus: 'To Be Booked In' },
  });
  assert.equal(externalContractor.label, 'Approved');
  assert.equal(
    externalContractor.message,
    'Your quote has been accepted. The estimated lead time for booking is up to 15 business days from the date of approval during standard business periods.',
  );
  assert.equal(externalContractor.schedulerSlaType, undefined);
  assert.equal(deriveJobStatus('Approved', '', 'minor', {
    status: 'Not Started',
    tasktype: 'External Contractor Only',
    substatus: { substatus: 'Booked In' },
  }).label, 'Booked');
  assert.equal(deriveJobStatus('Approved', '', 'minor', {
    status: 'Not Started', substatus: { substatus: 'Booked' },
  }).label, 'Booked');
  assert.equal(deriveJobStatus('Approved', '', 'minor', {
    status: 'Not Started', substatus: { substatus: 'On Hold' },
  }).label, 'Approved — on hold');
  assert.equal(deriveJobStatus('Approved', '', 'minor', {
    status: 'Completed', substatus: { substatus: '' },
  }).label, 'Job complete');
  assert.equal(deriveJobStatus('Approved', '', 'minor', {
    status: 'In Progress', substatus: { substatus: 'Measure Complete' },
  }).message, 'Your quote has been approved. Our scheduler will be in touch to arrange a booking.');
});

test('minor-mod visit logic uses a completed visible appointment and task type', () => {
  const customTask = { status: 'Pending', tasktype: 'Custom Install', substatus: { substatus: 'To Be Manufactured' } };
  const stockTask = { status: 'Pending', tasktype: 'Stock Install', substatus: { substatus: 'Measures Printed' } };
  const completedVisit = [{ enddatetime: '2026/08/10 13:30:00', ishidden: 'false' }];
  const futureOrHidden = [
    { enddatetime: '2026/08/20 13:30:00', ishidden: 'false' },
    { enddatetime: '2026/08/10 13:30:00', ishidden: 'true' },
  ];

  assert.equal(hasCompletedSiteVisit(completedVisit, new Date('2026-08-14T00:00:00Z')), true);
  assert.equal(hasCompletedSiteVisit(futureOrHidden, new Date('2026-08-14T00:00:00Z')), false);
  assert.equal(hasCompletedSiteVisit([
    { enddatetime: '2026/08/14 10:00:00', ishidden: 'false' },
  ], new Date('2026-08-14T01:00:00Z')), true, 'an ended same-day appointment is a completed visit');
  assert.equal(hasCompletedSiteVisit([
    { enddatetime: '2026/08/14 15:00:00', ishidden: 'false' },
  ], new Date('2026-08-14T01:00:00Z')), false, 'a same-day future appointment is not complete');
  assert.equal(
    deriveJobStatus('Approved', '', 'minor', customTask, { hasSiteVisit: true }).message,
    'Your quote has been approved. We’ve been to site and taken the custom measures. Our scheduler will be in touch to book the installation.',
  );
  assert.equal(
    deriveJobStatus('Approved', '', 'minor', stockTask, { hasSiteVisit: false }).message,
    'Your quote has been approved. Our scheduler will be in touch to book the installation.',
  );
  const visitedQuoteUpdate = deriveJobStatus('In Progress', '', 'minor', customTask, { hasSiteVisit: true });
  assert.equal(visitedQuoteUpdate.label, 'Site visit completed');
  assert.equal(visitedQuoteUpdate.message, '');
  const approvedQuoteUpdate = deriveJobStatus('Approved', '', 'minor', {
    status: 'Pending',
    tasktype: 'Custom Install',
    substatus: { substatus: 'Increase Approval Requested' },
  }, { hasSiteVisit: true });
  assert.equal(approvedQuoteUpdate.label, 'Site visit completed');
  assert.equal(approvedQuoteUpdate.message, '');
});

test('scheduler timeframe is only added for the required booking action', () => {
  const sla = {
    booking: 'within 5 business days',
    measure: 'within 3 business days',
    installation: 'within 7 business days',
  };
  const toBeBooked = {
    status: 'Not Started',
    substatus: { substatus: 'To Be Booked In' },
  };
  const customTask = {
    status: 'Pending', tasktype: 'Custom Install', substatus: { substatus: 'Measures Printed' },
  };
  const stockTask = {
    status: 'Pending', tasktype: 'Stock Install', substatus: { substatus: 'Measures Printed' },
  };
  const approved = { ...RAW_AROFLO_QUOTE, status: 'Approved' };
  const minorApproved = { ...approved, org: { orgname: 'MINOR MODIFICATIONS' } };

  assert.equal(schedulerSlaType(customTask, false), 'measure');
  assert.equal(schedulerSlaType(customTask, true), 'installation');
  assert.equal(schedulerSlaType(stockTask, false), 'installation');
  assert.equal(schedulerSlaFor('booking', sla), 'within 5 business days');
  assert.equal(schedulerSlaFor('measure', { booking: 'within 5 business days' }), 'within 5 business days');
  assert.equal(schedulerSlaFor('booking', {}), '');
  assert.equal(
    sanitiseQuote(approved, { task: toBeBooked, schedulerSla: sla }).schedulerTimeframe,
    'within 5 business days',
  );
  assert.equal(
    sanitiseQuote(minorApproved, { task: customTask, schedulerSla: sla }).schedulerTimeframe,
    'within 3 business days',
  );
  assert.equal(
    sanitiseQuote(minorApproved, { task: stockTask, schedulerSla: sla }).schedulerTimeframe,
    'within 7 business days',
  );
  assert.equal(
    sanitiseQuote(approved, {
      task: { status: 'Not Started', substatus: { substatus: 'Booked' } },
      schedulerSla: sla,
    }).schedulerTimeframe,
    undefined,
  );
});

test('job 119613 field shapes produce a safe location and booking', () => {
  const task = {
    taskid: 'task-119613',
    taskname: '4, 138 Derby Street Pascoe Vale',
    status: 'Not Started',
    substatus: { substatusid: 'booked-id', substatus: 'Booked' },
    tasklocation: { locationname: '4, 138 Derby Street, Pascoe Vale' },
  };
  const quote = { ...RAW_AROFLO_QUOTE, quotename: 'fallback quote name', status: 'Approved' };
  const schedule = {
    scheduletype: { type: 'task', typeid: 'task-119613' },
    startdate: '2026/08/17',
    startdatetime: '2026/08/17 09:45:00',
    enddatetime: '2026/08/17 10:45:00',
    note: 'Confirmed 9-1 — internal wording that must not be exposed',
    ishidden: 'false',
    scheduledto: { scheduledtoname: 'Lee Taylor (Eltham) | R.D' },
  };

  assert.equal(taskSubstatus(task), 'Booked');
  assert.equal(locationNameFor(task, quote), '4, 138 Derby Street, Pascoe Vale');
  assert.equal(publicTradeName(schedule.scheduledto.scheduledtoname), 'Lee Taylor');
  assert.equal(confirmedWindowFromNote(schedule.note), 'Confirmed 9–1');
  assert.deepEqual(sanitiseBooking(schedule), {
    date: '2026/08/17',
    startTime: '09:45',
    endTime: '10:45',
    confirmedWindow: 'Confirmed 9–1',
    tradeName: 'Lee Taylor',
  });

  const out = sanitiseQuote(quote, { task, booking: sanitiseBooking(schedule) });
  assert.equal(out.statusLabel, 'Booked');
  assert.equal(out.step, 3);
  assert.equal(out.booking.tradeName, 'Lee Taylor');
  assert.equal(JSON.stringify(out).includes('internal wording'), false);
});

test('hidden schedules and arbitrary calendar notes are never exposed', () => {
  assert.equal(sanitiseBooking({
    startdatetime: '2026/08/17 09:45:00', ishidden: 'true',
  }), null);
  assert.equal(confirmedWindowFromNote('Call office before attending; gate code 1234'), '');
});

test('task and schedule selectors prefer the active task and next booking', () => {
  const completed = { taskid: 'old', status: 'Completed', tasktype: 'Stock Install', lastupdateddatetimeutc: '2026/08/12 00:00:00' };
  const active = { taskid: 'new', status: 'Not Started', tasktype: 'Stock Install', lastupdateddatetimeutc: '2026/08/13 00:00:00' };
  assert.equal(selectRelevantTask([completed, active]), active);

  const past = { startdate: '2026/08/10', startdatetime: '2026/08/10 09:00:00' };
  const next = { startdate: '2026/08/17', startdatetime: '2026/08/17 09:45:00' };
  assert.equal(selectRelevantSchedule([past, next], new Date('2026-08-13T00:00:00Z')), next);
});

test('quoteCreatedTs orders multiple quotes newest-first', () => {
  const older = { createddatetime: '2026/01/01 09:00:00' };
  const newer = { createddatetime: '2026/05/18 10:17:32' };
  const sorted = [older, newer].sort((a, b) => quoteCreatedTs(b) - quoteCreatedTs(a));
  assert.equal(sorted[0], newer);
});

test('quoteContactName handles both AroFlo and mock key casing', () => {
  assert.equal(quoteContactName({ contactname: 'Jane Doe' }), 'Jane Doe');
  assert.equal(quoteContactName({ contactName: 'John Smith' }), 'John Smith');
});

test('name matching is tolerant of case, order and partial names', () => {
  assert.equal(nameMatches('Steven Makris', 'Steven Makris'), true);
  assert.equal(nameMatches('steven makris', 'Steven Makris'), true);
  assert.equal(nameMatches('  Makris   Steven ', 'Steven Makris'), true); // reordered + spaces
  assert.equal(nameMatches('Steven', 'Steven Makris'), true); // partial
  assert.equal(nameMatches("O'Brien", 'Jane OBrien'), true); // punctuation stripped
  assert.equal(nameMatches('Wrong Person', 'Steven Makris'), false);
  assert.equal(nameMatches('', 'Steven Makris'), false);
});

test('clientNameMatches checks both contact name and client org name', () => {
  const quote = { contactname: 'Steven Makris', client: { orgname: 'NDIS' } };
  assert.equal(clientNameMatches('steven makris', quote), true);
  assert.equal(clientNameMatches('NDIS', quote), true);
  assert.equal(clientNameMatches('nobody', quote), false);
});

test('postcode matching normalises and compares the quote address postcode', () => {
  const quote = { address: { postcode: '3802' } };
  assert.equal(postcodeMatches('3802', quote), true);
  assert.equal(postcodeMatches(' 3802 ', quote), true);
  assert.equal(postcodeMatches('3000', quote), false);
  assert.equal(postcodeMatches('', quote), false);
  assert.equal(normalisePostcode('VIC 3058'), '3058');
});

test('location verification uses the AroFlo SiteContact and physical postcode', () => {
  const location = { SiteContact: 'Luciana Castagna', postcode: '3011' };
  assert.equal(locationSiteContactName(location), 'Luciana Castagna');
  assert.equal(locationContactMatches('Luciana Castagna', location), true);
  assert.equal(locationContactMatches('Castagna Luciana', location), true);
  assert.equal(locationContactMatches('Harith Jayasinghe', location), false);
  assert.equal(locationPostcodeMatches('3011', location), true);
  assert.equal(locationPostcodeMatches('3023', location), false);
  assert.equal(taskLocationId({ tasklocation: { locationid: 'location-id' } }), 'location-id');
});

test('input validation rejects bad job numbers, names and postcodes', () => {
  assert.equal(isValidJobNumber('1048'), true);
  assert.equal(isValidJobNumber('1048|or|jobnumber|>|0'), false); // WHERE-injection attempt
  assert.equal(isValidJobNumber("1048' OR '1'='1"), false);
  assert.equal(isValidJobNumber(''), false);
  assert.equal(isValidName('Jane Smith'), true);
  assert.equal(isValidName('J'), false);
  assert.equal(isValidPostcode('3058'), true);
  assert.equal(isValidPostcode('30'), false);
  assert.equal(isValidPostcode('notapostcode'), false);
});

test('jobNumberOnly mode verifies from the job number alone, ignoring name + postcode', async () => {
  const svc = new QuoteService({ mockMode: true, jobNumberOnly: true });
  const ok = await svc.lookup('1048', '', '');
  assert.equal(ok.outcome, 'verified');
  assert.ok(ok.quotes.length >= 1);
  // A wrong name / postcode is ignored in this mode.
  const ok2 = await svc.lookup('1048', 'Totally Wrong', '9999');
  assert.equal(ok2.outcome, 'verified');
  // A non-existent job is still not found.
  assert.equal((await svc.lookup('999999', '', '')).outcome, 'notfound');
  // A malformed job number is still rejected (WHERE-injection safety preserved).
  assert.equal((await svc.lookup('1048|or|1|=|1', '', '')).outcome, 'notfound');
});

test('full mode accepts a job number alone, but enforces every supplied identity field', async () => {
  const svc = new QuoteService({ mockMode: true, jobNumberOnly: false });
  assert.equal((await svc.lookup('1048', '', '')).outcome, 'verified');
  assert.equal((await svc.lookup('1048', 'Bradley Sandbox', '3134')).outcome, 'verified');
  assert.equal((await svc.lookup('1048', 'Wrong Name', '9999')).outcome, 'mismatch');
  assert.equal((await svc.lookup('1048', 'Wrong Name', '')).outcome, 'mismatch');
  assert.equal((await svc.lookup('1048', '', '9999')).outcome, 'mismatch');
});

test('live lookup joins the quote to its exact task schedule', async () => {
  const svc = new QuoteService({
    mockMode: false,
    jobNumberOnly: true,
    aroflo: {},
  });
  const calls = [];
  svc.client = {
    async get(query) {
      calls.push(query);
      if (query.zone === 'Quotes') return { zoneResponse: { quotes: [{
        ...RAW_AROFLO_QUOTE,
        quotename: '4, 138 Derby Street Pascoe Vale',
        status: 'Approved',
        contactname: 'Sristi Gurung',
        address: { postcode: '3044' },
      }] } };
      if (query.zone === 'Tasks') return { zoneResponse: { tasks: [{
        taskid: 'task-119613',
        taskname: '4, 138 Derby Street Pascoe Vale',
        tasklocation: { locationname: '4, 138 Derby Street, Pascoe Vale' },
        status: 'Not Started',
        substatus: { substatus: 'Booked' },
      }] } };
      return { zoneResponse: { schedules: [{
        scheduletype: { type: 'task', typeid: 'task-119613' },
        startdate: '2026/08/17',
        startdatetime: '2026/08/17 09:45:00',
        enddatetime: '2026/08/17 10:45:00',
        note: 'Confirmed 9-1',
        ishidden: 'false',
        scheduledto: { scheduledtoname: 'Lee Taylor (Eltham) | R.D' },
      }] } };
    },
  };

  const result = await svc.lookup('119613', '', '');
  assert.equal(result.outcome, 'verified');
  assert.equal(result.locationName, '4, 138 Derby Street, Pascoe Vale');
  assert.equal(result.quotes[0].statusLabel, 'Booked');
  assert.equal(result.quotes[0].booking.confirmedWindow, 'Confirmed 9–1');
  assert.deepEqual(calls.map((call) => call.zone), ['Quotes', 'Tasks', 'Schedules']);
  assert.deepEqual(calls[2].where, ['and|taskid|=|task-119613']);
});

test('live lookup detects an ended visit for an approved quote update', async () => {
  const svc = new QuoteService({ mockMode: false, jobNumberOnly: true, aroflo: {} });
  const calls = [];
  svc.client = {
    async get(query) {
      calls.push(query);
      if (query.zone === 'Quotes') return { zoneResponse: { quotes: [{
        ...RAW_AROFLO_QUOTE,
        status: 'Approved',
      }] } };
      if (query.zone === 'Tasks') return { zoneResponse: { tasks: [{
        taskid: 'task-visit-complete',
        status: 'Pending',
        tasktype: 'Custom Install',
        substatus: { substatus: 'Increase Approval Requested' },
      }] } };
      return { zoneResponse: { schedules: [{
        scheduletype: { type: 'task', typeid: 'task-visit-complete' },
        enddatetime: '2026/01/01 11:00:00',
        ishidden: 'false',
      }] } };
    },
  };

  const result = await svc.lookup('1070', '', '');
  assert.equal(result.outcome, 'verified');
  assert.equal(result.quotes[0].statusLabel, 'Site visit completed');
  assert.deepEqual(calls.map((call) => call.zone), ['Quotes', 'Tasks', 'Schedules']);
});

test('live lookup verifies the resident SiteContact without exposing it', async () => {
  const svc = new QuoteService({
    mockMode: false,
    jobNumberOnly: false,
    aroflo: {},
  });
  const calls = [];
  svc.client = {
    async get(query) {
      calls.push(query);
      if (query.zone === 'Quotes') return { zoneResponse: { quotes: [{
        ...RAW_AROFLO_QUOTE,
        quotename: '19 Fitzroy Street Footscray',
        status: 'Approved',
        contactname: 'Harith Jayasinghe',
        client: { orgname: 'Uniting AgeWell' },
        address: { postcode: '3011' },
      }] } };
      if (query.zone === 'Tasks') return { zoneResponse: { tasks: [{
        taskid: 'task-116479',
        taskname: '19 Fitzroy Street Footscray',
        tasklocation: { locationid: 'location-116479', locationname: '19 Fitzroy Street, Footscray' },
        status: 'Pending',
        substatus: { substatus: 'OT Approval Requested' },
      }] } };
      if (query.zone === 'Locations') return { zoneResponse: { locations: [{
        SiteContact: 'Luciana Castagna',
        postcode: '3011',
      }] } };
      throw new Error(`Unexpected zone ${query.zone}`);
    },
  };

  const verified = await svc.lookup('116479', 'Luciana Castagna', '3011');
  assert.equal(verified.outcome, 'verified');
  assert.equal(JSON.stringify(verified).includes('Luciana Castagna'), false);
  assert.deepEqual(calls.map((call) => call.zone), ['Quotes', 'Tasks', 'Locations']);
  assert.deepEqual(calls[2].where, ['and|locationid|=|location-116479']);

  calls.length = 0;
  const wrongName = await svc.lookup('116479', 'Harith Jayasinghe', '3011');
  assert.equal(wrongName.outcome, 'mismatch');
  assert.deepEqual(calls.map((call) => call.zone), ['Quotes', 'Tasks', 'Locations']);

  calls.length = 0;
  const wrongPostcode = await svc.lookup('116479', 'Luciana Castagna', '3023');
  assert.equal(wrongPostcode.outcome, 'mismatch');
  assert.deepEqual(calls.map((call) => call.zone), ['Quotes', 'Tasks', 'Locations']);
});
