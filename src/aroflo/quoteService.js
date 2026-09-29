import { createCoordinator } from '../shared/coordinator.js';
import { ArofloClient } from './client.js';
import { MOCK_JOBS } from '../mock/sampleData.js';
import config from '../config.js';

/**
 * Job status business logic.
 *
 * Flow for a lookup (job number, with optional client name and post code):
 *   1. Quotes zone, WHERE jobnumber = N  -> quote(s) with status, contact name and address.
 *   2. When a client name and/or post code is supplied, verify every supplied field
 *      matches the quote on file. A job number on its own is sufficient.
 *   3. For approved quotes, read the current Task status/substatus and, when booked,
 *      the exact task Schedule. These drive the post-approval customer update.
 *
 * Name and postcode are matched in-code (never sent to AroFlo), so there is no
 * injection surface from them. Internal cost/margin fields are never exposed — only
 * customer-appropriate fields (quote name, status, dates and reference).
 */

/** Normalise a name/text value for tolerant comparison (lowercase, strip punctuation). */
function normaliseName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’`]/g, '') // drop apostrophes so O'Brien == OBrien
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Normalise a postcode to digits only. */
export function normalisePostcode(value) {
  return String(value || '').replace(/\D+/g, '');
}

export function isValidJobNumber(job) {
  return /^[0-9]{1,12}$/.test(String(job || '').trim());
}

/** Australian postcodes are 4 digits; accept 3-4 to be lenient. */
export function isValidPostcode(pc) {
  return /^[0-9]{3,4}$/.test(normalisePostcode(pc));
}

export function isValidName(name) {
  const n = String(name || '').trim();
  return n.length >= 2 && n.length <= 100;
}

/**
 * Tolerant name match: true if the normalised strings are equal, or every word the
 * customer typed appears in the target name. So "steven makris", "Makris Steven" and
 * "Steven" all match a stored "Steven Makris".
 */
export function nameMatches(input, target) {
  const a = normaliseName(input);
  const b = normaliseName(target);
  if (!a || !b) return false;
  if (a === b) return true;
  const targetTokens = new Set(b.split(' '));
  return a.split(' ').every((tok) => targetTokens.has(tok));
}

/** True if `postcode` matches the quote's address postcode. */
export function postcodeMatches(input, quote) {
  const want = normalisePostcode(input);
  return !!want && normalisePostcode(quote?.address?.postcode) === want;
}

/** True if `clientName` matches a name on the quote (contact name or client org name). */
export function clientNameMatches(input, quote) {
  return [quote?.contactname, quote?.client?.orgname].some((n) => nameMatches(input, n));
}

/**
 * AroFlo stores the resident/customer at the physical job address as
 * `SiteContact`. It is used only to verify a lookup and is never included in
 * the public response.
 */
export function locationSiteContactName(location) {
  return location?.SiteContact ?? location?.siteContact ?? location?.sitecontact ?? '';
}

/** True if the supplied name matches the customer/resident at a job location. */
export function locationContactMatches(input, location) {
  return nameMatches(input, locationSiteContactName(location));
}

/** True if the supplied postcode matches the physical job location. */
export function locationPostcodeMatches(input, location) {
  const want = normalisePostcode(input);
  const actual = location?.postcode ?? location?.address?.postcode ?? location?.postCode ?? '';
  return !!want && normalisePostcode(actual) === want;
}

/** Read the physical AroFlo location identifier from a task. */
export function taskLocationId(task) {
  return task?.tasklocation?.locationid || task?.location?.locationid || '';
}

/** Every supplied identity field must match the same AroFlo record. */
function suppliedIdentityMatches(clientName, postcode, nameMatcher, postcodeMatcher) {
  const hasName = String(clientName ?? '').trim() !== '';
  const hasPostcode = String(postcode ?? '').trim() !== '';
  return (!hasName || nameMatcher(clientName)) && (!hasPostcode || postcodeMatcher(postcode));
}

/** Read an AroFlo task substatus, handling both the nested and string shapes. */
export function taskSubstatus(task) {
  const value = task?.substatus;
  if (!value) return '';
  return typeof value === 'string' ? value : value.substatus || '';
}

/** Keep booking recognition consistent between status display and schedule retrieval. */
function isBookedSubstatus(substatus) {
  return substatus === 'booked' || substatus.startsWith('booked in');
}

/** Prefer AroFlo's location label; fall back to the task/quote name. */
export function locationNameFor(task, quote) {
  return task?.tasklocation?.locationname || task?.location?.locationname ||
    task?.taskname || quote?.quotename || quote?.quoteName || '';
}

/** Strip internal location/team suffixes from an assigned resource's display name. */
export function publicTradeName(value) {
  return String(value || '')
    .split('|')[0]
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

/**
 * Calendar notes are internal by default. Only extract the short, explicitly
 * customer-relevant "Confirmed <time>-<time>" phrase requested by the team.
 */
export function confirmedWindowFromNote(value) {
  const note = String(value || '').replace(/\s+/g, ' ').trim();
  const match = note.match(
    /\bconfirmed\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|—|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i
  );
  if (!match) return '';
  return `Confirmed ${match[1].replace(/\s*(?:-|–|—|to)\s*/i, '–').trim()}`;
}

/** Map an AroFlo schedule record to the small, customer-safe booking shape. */
export function sanitiseBooking(schedule) {
  if (!schedule || String(schedule.ishidden).toLowerCase() === 'true') return null;
  const start = String(schedule.startdatetime || '').trim();
  const end = String(schedule.enddatetime || '').trim();
  const booking = {
    date: start.slice(0, 10),
    startTime: start.slice(11, 16),
    endTime: end.slice(11, 16),
    confirmedWindow: confirmedWindowFromNote(schedule.note),
    tradeName: publicTradeName(schedule?.scheduledto?.scheduledtoname),
  };
  return booking.date ? booking : null;
}

/**
 * Customer-facing workflow definitions, ONE PER AROFLO BUSINESS UNIT.
 *
 * Major and Minor modifications have very different real-world processes:
 *  - Major mods go through a detailed In-Progress phase (drafting, sub-contractor
 *    pricing, OT approval) — these come from AroFlo's quote `substatus`.
 *  - Minor mods are a short, simple path with no workflow substatuses.
 *
 * AroFlo's "Approved"/"Rejected" substatuses are INTERNAL (approver names, and
 * sensitive reasons such as bereavement / cancellation fees) and are deliberately
 * NOT surfaced to customers — we only show a generic "not proceeding".
 *
 * Edit the labels/messages below to change customer wording. Substatus keys are
 * matched case-insensitively against AroFlo's exact substatus text.
 */
const REJECTED = {
  label: 'Not proceeding',
  message: 'This quote is no longer proceeding. If this is unexpected, please contact our office.',
};

// Minor Modifications uses the client's requested, more direct declined wording.
// Keep the Major Mods copy above unchanged: this workbook and workflow only applies
// to Minor Modifications.
const MINOR_REJECTED = {
  label: 'Quote sent and not approved',
  message: 'If this is unexpected, please contact our office.',
};

const FLOWS = {
  major: {
    unitLabel: 'Major home modification',
    steps: ['In progress', 'Pending approval', 'Approved'],
    inProgress: { label: 'In progress', message: 'We are preparing your detailed quote and will be in touch.' },
    substatus: {
      'drafted for review': {
        label: 'Drafted — under review',
        message: 'Your quote has been drafted and is being reviewed by our team.',
      },
      'awaiting sub-contractor quote': {
        label: 'Awaiting sub-contractor pricing',
        message: 'We are gathering pricing from a sub-contractor to complete your quote.',
      },
      'awaiting ot approval - non-standard plan': {
        label: 'Awaiting OT approval',
        message: 'We are awaiting approval from your Occupational Therapist on a non-standard plan.',
      },
      'waiting for more info': {
        label: 'Awaiting more information',
        message: 'We are waiting on some additional information to finalise your quote.',
      },
    },
    pending: { label: 'Pending approval', message: 'Your quote has been submitted for approval and will be finalised shortly.' },
    approved: { label: 'Approved', message: 'Your quote has been approved — our team will be in touch to schedule the works.' },
  },
  minor: {
    unitLabel: 'Minor modification',
    steps: ['In progress', 'Quote ready', 'Approved'],
    inProgress: { label: 'In progress', message: 'We are preparing your quote and will be in touch shortly.' },
    substatus: {},
    pending: { label: 'Quote ready', message: 'Your quote is ready and is being processed.' },
    approved: { label: 'Approved', message: 'Your quote has been approved — our team will be in touch to schedule the works.' },
  },
};

/** Determine the business unit ('major' | 'minor') from the quote's AroFlo org/BU. */
function quoteBusinessUnit(q) {
  const org = String(q?.org?.orgname ?? q?.businessUnit ?? '').toLowerCase();
  return org.includes('minor') ? 'minor' : 'major'; // MAJOR MODS is the default/dominant unit
}

/** Read the quote substatus text, handling AroFlo's nested object and the mock string. */
function quoteSubstatus(q) {
  const s = q?.substatus;
  if (!s) return '';
  return typeof s === 'string' ? s : s.substatus || '';
}

/**
 * Derive a customer-friendly status for the progress tracker, using the per-unit flow.
 * Returns the unit's step labels, the current step (1-based; 0 when terminal), a label,
 * a message, and a terminal flag. Major mods additionally reflect the In-Progress substatus.
 */
export function deriveStatus(quoteStatus, substatus = '', unit = 'major') {
  const flow = FLOWS[unit] || FLOWS.major;
  const s = String(quoteStatus || '').trim().toLowerCase();
  const sub = String(substatus || '').trim().toLowerCase();
  const base = { unit, unitLabel: flow.unitLabel, steps: flow.steps };

  if (s === 'rejected') {
    return {
      ...base,
      step: 0,
      terminal: 'declined',
      ...(unit === 'minor' ? MINOR_REJECTED : REJECTED),
    };
  }
  if (s === 'approved') return { ...base, step: flow.steps.length, terminal: null, ...flow.approved };
  if (s === 'pending approval') return { ...base, step: 2, terminal: null, ...flow.pending };

  // Default: In Progress — surface the substatus sub-stage when we have a friendly mapping.
  return { ...base, step: 1, terminal: null, ...(flow.substatus[sub] || flow.inProgress) };
}

/** Read the task type across the two AroFlo response shapes seen in production. */
function taskType(task) {
  return task?.tasktype || task?.tasktasktype?.tasktype || '';
}

/** Whether the task is a custom install, for customer-safe booking wording. */
function isCustomInstall(task) {
  return /\bcustom\b/i.test(taskType(task));
}

/** Whether AroFlo assigns this job to an external contractor workflow. */
function isExternalContractor(task) {
  return /\bexternal contractor\b/i.test(taskType(task));
}

const STANDARD_JOB_STEPS = ['Quoted', 'Approved', 'Booked', 'Complete'];
const CUSTOM_MINOR_JOB_STEPS = ['Quoted', 'Approved', '1st Visit Booked', '2nd Visit Booked', 'Completed'];
const MAJOR_JOB_STEPS = [
  'Quote', 'Approval', 'Draftsperson', 'Project Documentation',
  'Scheduling', 'Construction', 'Completion', 'Warranty',
];

function majorTaskStageStep(task) {
  const status = normaliseName(task?.status || task?.taskstatus || '');
  const substatus = normaliseName(taskSubstatus(task));

  if (status === 'archived') return 8;
  if (status === 'completed' || status === 'complete' ||
      substatus.startsWith('4 1 completed job') || substatus.startsWith('4 2 completed bath')) return 7;
  if (/^1 1 /.test(substatus)) return 3;
  if (/^1 [234] /.test(substatus) || substatus === 'measure complete') return 4;
  if (/^1 [56] /.test(substatus) || substatus === 'booked') return 5;
  if (/^1 7 /.test(substatus) || /^2 4 /.test(substatus) ||
      substatus === 'external contractor' || substatus === 'external supplier') return 6;
  return 2;
}

/**
 * Custom Minor Mods uses two separate bookings in AroFlo:
 *  - Not Started + Booked means the first (measure) visit is booked.
 *  - In Progress + Booked means the second (installation) visit is booked.
 * Quoted and Approved are the first two customer-facing stages. Pending/In
 * Progress custom tasks have already passed the first booking stage, while
 * Completed/Archived is the final stage.
 */
function customMinorProgressStep(task, hasSiteVisit = false) {
  const status = String(task?.status || task?.taskstatus || '').trim().toLowerCase();
  const substatus = taskSubstatus(task).trim().toLowerCase();

  if (status === 'completed' || status === 'archived' ||
      substatus === 'completed' || substatus === 'complete') return 5;
  if (isBookedSubstatus(substatus) && status === 'in progress') return 4;
  if (isBookedSubstatus(substatus)) return 3;
  if (hasSiteVisit || status === 'pending' || status === 'in progress') return 3;
  return 2;
}

function jobProgress(unit, task, hasSiteVisit = false) {
  const customMinor = unit === 'minor' && isCustomInstall(task);
  return {
    customMinor,
    steps: customMinor ? CUSTOM_MINOR_JOB_STEPS : unit === 'major' ? MAJOR_JOB_STEPS : STANDARD_JOB_STEPS,
    customStep: customMinor ? customMinorProgressStep(task, hasSiteVisit) : null,
  };
}

/** Which scheduler timeframe applies to an unbooked approved job. */
export function schedulerSlaType(task, hasSiteVisit = false) {
  if (hasSiteVisit || /\bstock\b/i.test(taskType(task))) return 'installation';
  if (isCustomInstall(task)) return 'measure';
  return 'booking';
}

/**
 * AroFlo does not expose an attendance flag through the Tasks endpoint. A visible
 * appointment that ended before today is the most conservative live signal we have
 * that a site visit took place. A same-day appointment intentionally does not count:
 * that avoids saying we have attended before the appointment has concluded.
 */
function dateKeyInMelbourne(date) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function hasCompletedSiteVisit(schedules, now = new Date()) {
  const todayInMelbourne = dateKeyInMelbourne(now);
  const timeParts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const currentTime = Object.fromEntries(timeParts.map(({ type, value }) => [type, value]));
  const nowInMelbourne = `${todayInMelbourne} ${currentTime.hour}:${currentTime.minute}:${currentTime.second}`;
  return (schedules || []).some((schedule) => {
    if (String(schedule?.ishidden).trim().toLowerCase() === 'true') return false;
    const endDateTime = String(schedule?.enddatetime || '').replace(/\//g, '-');
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(endDateTime)) {
      return endDateTime < nowInMelbourne;
    }
    const endDate = String(schedule?.enddate || schedule?.startdate || '')
      .slice(0, 10)
      .replace(/\//g, '-');
    return /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate < todayInMelbourne;
  });
}

/** The reviewed booking message for a job that has not yet been booked. */
function bookingToBeArrangedMessage(task, hasSiteVisit = false) {
  if (hasSiteVisit) {
    return 'Your quote has been approved. We’ve been to site and taken the custom measures. Our scheduler will be in touch to book the installation.';
  }
  if (isCustomInstall(task)) {
    return 'Your quote has been approved. Our scheduler will be in touch to book a measure.';
  }
  if (/\bstock\b/i.test(taskType(task))) {
    return 'Your quote has been approved. Our scheduler will be in touch to book the installation.';
  }
  return 'Your quote has been approved. Our scheduler will be in touch to arrange a booking.';
}

/**
 * Team-approved Major Mods portal copy, keyed by AroFlo Task status/substatus.
 * Hidden archived substatuses are intentionally excluded. Obvious spelling and
 * grammar errors in the reviewed customer copy are corrected here.
 */
const MAJOR_TASK_PORTAL_WORDING = new Map([
  ['not started\u0000', 'Please contact our admin team at mam@mobilityaccess.com.au'],
  ['not started\u00001 1 1 drafty order to be booked rs 3d', 'Quote for the job has been approved for build. Our scheduling team will be in touch with the client soon to organise an Order Visit (Pre-Construction Site Meeting) to firm up the measures, plan, order and scope of work.'],
  ['not started\u00001 1 2 drafty quote to be booked rs 3d', 'Quote for MAM Drafty service has been approved. Our scheduling team will be in touch with the client soon to organise a Quote Visit to consult, measure, design, draft and finalise a scope of work for your proposed home modification.'],
  ['not started\u00001 1 3 drafty order booked in rs', 'Quote for the job has been approved for build. Our scheduling team has locked in a date with the client and/or the quote requestor for the Order Visit (Pre-Construction Site Meeting) to firm up the measures, plan, order and scope of work.'],
  ['not started\u00001 1 4 drafty quote booked in rs', 'Quote for MAM Drafty service has been approved. Our scheduling team has locked in a date with the client and/or the quote requestor for a Quote Visit to consult, measure, design, draft and finalise a scope of work for your proposed home modification.'],
  ['not started\u00001 1 5 drafty order offered date rs 3d', 'Quote for the job has been approved for build. Our scheduling team has contacted the client and/or the quote requestor and offered available date(s) to organise an Order Visit (Pre-Construction Site Meeting) to firm up the measures, plan, order and scope of work. We are awaiting confirmation from the client and/or the quote requestor.'],
  ['not started\u00001 1 6 drafty quote offered date rs 3d', 'Quote for MAM Drafty service has been approved. Our scheduling team has contacted the client and/or the quote requestor and offered available date(s) to organise a Quote Visit to consult, measure, design, draft and finalise a scope of work for your proposed home modification. We are awaiting confirmation from the client and/or the quote requestor.'],
  ['not started\u00001 1 7 drafty measure complete drft 1d', 'Drafty site visit has been completed and your job is currently with our estimator. Please contact our estimating team at majorquotes@mobilityaccess.com.au for more information.'],
  ['not started\u00001 2 measure complete project doc req ca 5d', 'Pre-construction site meeting completed. Our Contract Administrator will be in touch with the client soon to finalise the project documents.'],
  ['not started\u00001 3 project doc in progress ca 5days', 'Pre-construction site meeting completed. We\'re now preparing your project documents.'],
  ['not started\u00001 5 1 to be booked no custom materials bs 5d', 'Quote for the job has been approved for build. Project documentation is complete. Our scheduling team will be in touch with the client soon to lock in a suitable date to commence works onsite.'],
  ['not started\u00001 5 2 to be booked with custom materials bs 5d', 'Quote for the job has been approved for build. Project documentation is complete. We are finalising the custom materials for your job. Our scheduling team will be in touch with the client soon to lock in a suitable date to commence works onsite.'],
  ['not started\u00001 5 3 to be booked callbacks bs 5d', 'We have acknowledged your complaint. Our scheduler is in the process of organising a suitable date to inspect, assess and/or repair.'],
  ['not started\u00001 6 1 booked in apply ndis payment mgr asap', 'We are in the process of lodging a claim with NDIS. Please contact our admin team at mam@mobilityaccess.com.au.'],
  ['not started\u00001 6 2 booked in ndis payment applied mgr asap', 'We have lodged a claim through the NDIS portal and are awaiting payment. Please contact our admin team at mam@mobilityaccess.com.au.'],
  ['not started\u00001 6 3 booked in start date confirmed bs', 'The start date for onsite works has been booked with the client.'],
  ['not started\u0000external contractor', 'We are currently arranging an external contractor for this job.'],
  ['not started\u0000external supplier', 'We are currently arranging an external supplier for this job.'],
  ['in progress\u0000', 'Please contact our admin team at majorquotes@mobilityaccess.com.au'],
  ['in progress\u00001 2 measure complete project doc req ca 5d', 'Pre-construction site meeting completed. Our Contract Administrator will be in touch with the client soon to finalise the project documents.'],
  ['in progress\u00001 3 project doc in progress ca 5days', 'Pre-construction site meeting completed. We\'re now preparing your project documents.'],
  ['in progress\u00001 5 1 to be booked no custom materials bs 5d', 'Quote for the job has been approved for build. Project documentation is complete. Our scheduling team will be in touch with the client soon to lock in a suitable date to commence works onsite.'],
  ['in progress\u00001 5 2 to be booked with custom materials bs 5d', 'Quote for the job has been approved for build. Project documentation is complete. We are finalising the custom materials for your job. Our scheduling team will be in touch with the client soon to lock in a suitable date to commence works onsite.'],
  ['in progress\u00001 5 3 to be booked callbacks bs 5d', 'We have received and acknowledged your complaint. Our scheduler is in the process of organising a suitable date to inspect, assess and/or repair.'],
  ['in progress\u00001 6 1 booked in apply ndis payment mgr asap', 'We are in the process of lodging a claim with NDIS. Please contact our admin team at mam@mobilityaccess.com.au.'],
  ['in progress\u00001 6 2 booked in ndis payment applied mgr asap', 'We have lodged a claim through the NDIS portal and are awaiting payment. Please contact our admin team at mam@mobilityaccess.com.au.'],
  ['in progress\u00001 6 3 booked in start date confirmed bs', 'The start date for onsite works has been booked with the client.'],
  ['in progress\u00001 7 1 under construction w1 w3 bs', 'Construction work is in progress.'],
  ['in progress\u00001 7 2 under construction w4 completion bs', 'Construction work is in progress.'],
  ['in progress\u00001 7 3 under construction pending minor works', 'Construction work is mostly complete, with minor works remaining.'],
  ['in progress\u0000external contractor', 'We are currently arranging an external contractor for this job.'],
  ['in progress\u0000external supplier', 'We are currently arranging an external supplier for this job.'],
  ['pending\u0000', 'Please contact our admin team at majorquotes@mobilityaccess.com.au'],
  ['pending\u00001 1 8 drafty plan pending drft 2d', 'Drafty site visit is complete. Drafty is finalising the plan for your job.'],
  ['pending\u00001 2 measure complete project doc req ca 5d', 'Pre-construction site meeting completed. Our Contract Administrator will be in touch with the client soon to finalise the project documents.'],
  ['pending\u00001 3 project doc in progress ca 5days', 'Pre-construction site meeting completed. We\'re now preparing your project documents.'],
  ['pending\u00001 4 1 on hold variations approval tbc ca 14d', 'On hold — we are awaiting approval for a variation to the scope of work.'],
  ['pending\u00001 4 2 on hold increase approval req ca 14 day', 'On hold — we are awaiting approval for a cost increase to the job.'],
  ['pending\u00001 4 3 on hold pending contract deposits ca 5d', 'On hold — we are awaiting your signed building contract and/or deposit payment.'],
  ['pending\u00001 4 4 on hold by client ot fb ca 15d', 'On hold — we are awaiting confirmation from you, your OT or your funding body.'],
  ['pending\u00001 4 5 on hold awaiting rollover confirmation', 'On hold — we are awaiting confirmation of funding from your funding body.'],
  ['pending\u00001 5 3 to be booked callbacks bs 5d', 'We have received and acknowledged your complaint. Our scheduler is in the process of organising a suitable date to inspect, assess and/or repair.'],
  ['pending\u00002 4 make custom item mam manufacturing majors', 'We have your custom item(s) currently being manufactured. We\'ll be in touch as soon as the job is ready for installation.'],
  ['pending\u00004 1 completed job drafty to assess rs', 'Job completed. No pending items on our end.'],
  ['pending\u00004 2 completed bath project coordinator to visit', 'Job completed. No pending items on our end.'],
  ['pending\u0000external contractor', 'We are currently arranging an external contractor for this job.'],
  ['pending\u0000external supplier', 'We are currently arranging an external supplier for this job.'],
  ['pending\u0000measure complete', 'We have taken measurements for custom manufactured items. We will be in touch with the client as soon as the job is ready for installation.'],
  ['pending\u0000waiting for deposit payment', 'On hold — we are awaiting deposit and/or payment.'],
  ['archived\u0000', 'Job complete'],
]);

function majorTaskPortalKey(task) {
  const status = normaliseName(task?.status || task?.taskstatus || '');
  const substatus = normaliseName(taskSubstatus(task));
  return status + '\u0000' + substatus;
}

export function majorTaskPortalWording(task) {
  const taskState = normaliseName(task?.status || task?.taskstatus || '');
  if (taskState === 'completed' || taskState === 'complete') return 'Job complete';
  return MAJOR_TASK_PORTAL_WORDING.get(majorTaskPortalKey(task)) || '';
}

/**
 * Team-approved Minor Mods portal copy, keyed by AroFlo Task status/substatus.
 * The strings intentionally match the reviewed workbook verbatim.
 */
const MINOR_TASK_PORTAL_WORDING = new Map([
  ['not started\u0000', 'Please contact our admin team at mam@mobilityaccess.com.au'],
  ['not started\u0000to be booked', 'Quote has been approved. Our scheduling team will be in touch with the client to confirm an appointment as soon as we have a tradesman available in the area.'],
  ['not started\u0000pre payment required to proceed', 'Quote is awaiting a payment/deposit.'],
  ['not started\u0000booked', 'Works have been booked in with the client.'],
  ['in progress\u0000', 'Please contact our admin team at mam@mobilityaccess.com.au'],
  ['in progress\u0000to be booked', 'Works are underway. We have all the items ready and our scheduling team will be in touch with the client to confirm an appointment as soon as we have a tradesman available in the area.'],
  ['in progress\u0000extension requested', 'Please contact our admin team at mam@mobilityaccess.com.au'],
  ['in progress\u0000booked', 'Works have been booked in with the client for completion.'],
  ['pending\u0000measure approved', 'We have taken measurements for custom manufactured items. We will be in touch with the client as soon as the job is ready for installation.'],
  ['pending\u0000invoice submitted', 'Quote is awaiting a payment/deposit.'],
  ['pending\u0000requested new approval', 'Awaiting new approval. Please contact our admin team at mam@mobilityaccess.com.au'],
  ['pending\u0000measures complete', 'We have taken measurements for custom manufactured items. We will be in touch with the client as soon as the job is ready for installation.'],
  ['pending\u0000measures printed', 'We have taken measurements for custom manufactured items. We will be in touch with the client as soon as the job is ready for installation.'],
  ['pending\u0000ot approval requested', 'Site visit completed — we are currently awaiting OT approval before proceeding further.'],
  ['pending\u0000trade review needed', 'We have taken measurements for custom manufactured items. We will be in touch with the client as soon as the job is ready for installation.'],
  ['pending\u0000to be manufactured', 'We have taken measurements for custom manufactured items. They are currently being manufactured. We will be in touch with the client as soon as the job is ready for installation.'],
  ['pending\u0000client confirmation requested', 'we are currently awaiting confirmation from the client before proceeding further.'],
  ['pending\u0000external contractor supplier', 'Quote has been approved. Our team will be in touch with the client to confirm an appointment as soon as we have availability in the area.'],
  ['pending\u0000merged task', 'Quote has been approved and works are underway. Our scheduling team will be in touch with the client to confirm an appointment as soon as we have a tradesman available in the area.'],
  ['pending\u0000dva approval required', 'Quote has been approved. Our scheduling team will be in touch with the client to confirm an appointment as soon as we have a tradesman available in the area.'],
  ['pending\u0000on hold', 'Works are currently on hold. Please contact our admin team at mam@mobilityaccess.com.au'],
  ['pending\u0000awaiting deposit payment', 'Quote is awaiting a payment/deposit.'],
  ['pending\u0000awaiting dva items', 'We are awaiting delivery of items to organize installation.'],
  ['pending\u0000further action needed', 'Please contact our admin team at mam@mobilityaccess.com.au'],
  ['pending\u0000complaint active', 'Please contact our admin team at mam@mobilityaccess.com.au'],
  ['pending\u0000increase approval requested', 'Site visit completed — awaiting approval'],
  ['completed\u0000', 'Job complete'],
  ['completed\u0000invoice to be approved', 'Job complete'],
  ['completed\u0000invoiced awaiting contractor invoice', 'Job complete'],
  ['completed\u0000completion email sent ready to invoice', 'Job complete'],
  ['completed\u0000awaiting scheduler clarification', 'Job complete'],
  ['completed\u0000coc requested', 'Job is complete'],
  ['completed\u0000coc received ready to invoice', 'Job complete'],
  ['completed\u0000refund needed amount tbc', 'Please contact our admin team at mam@mobilityaccess.com.au'],
  ['completed\u0000refund approved process', 'Please contact our admin team at mam@mobilityaccess.com.au'],
  ['completed\u0000dva ready to invoice', 'Job complete'],
  ['completed\u0000outstanding invoice', 'Job complete'],
  ['archived\u0000', 'Job complete'],
]);

function minorTaskPortalKey(task) {
  const status = normaliseName(task?.status || task?.taskstatus || '');
  const substatus = normaliseName(taskSubstatus(task));
  return `${status}\u0000${substatus}`;
}

export function minorTaskPortalWording(task) {
  return MINOR_TASK_PORTAL_WORDING.get(minorTaskPortalKey(task)) || '';
}

function minorTaskPortalLabel(task) {
  const status = normaliseName(task?.status || task?.taskstatus || '');
  const substatus = normaliseName(taskSubstatus(task));
  if (status === 'completed' || status === 'archived') return 'Job complete';
  if (substatus === 'booked') return 'Booked';
  if (substatus.includes('on hold')) return 'Approved — on hold';
  if (/measure|approval requested|trade review/.test(substatus)) return 'Site visit completed';
  if (substatus === 'to be manufactured') return 'In progress — manufacturing';
  if (status === 'in progress') return 'In progress';
  return 'Approved';
}

/**
 * Apply the team's agreed post-approval customer states using the live Task.
 * Unrecognised task substatuses deliberately fall back to the scheduler message.
 */
export function deriveJobStatus(
  quoteStatus,
  quoteSubstatusText = '',
  unit = 'major',
  task = null,
  { hasSiteVisit = false } = {},
) {
  const quote = deriveStatus(quoteStatus, quoteSubstatusText, unit);
  const quoteState = String(quoteStatus || '').trim().toLowerCase();
  if (quoteState === 'rejected') return { ...quote, tone: 'declined' };

  const progress = jobProgress(unit, task, hasSiteVisit);
  const jobSteps = progress.steps;

  if (quoteState !== 'approved') {
    if (hasSiteVisit) {
      return {
        ...quote,
        steps: jobSteps,
        step: progress.customMinor ? progress.customStep : 2,
        label: 'Site visit completed',
        message: '',
        tone: 'approved',
      };
    }
    return {
      ...quote,
      steps: jobSteps,
      step: 1,
      label: 'Quoted — awaiting approval',
      message: 'Your quote has been prepared and is awaiting approval.',
      tone: 'quoted',
    };
  }

  return approvedTaskStatus(quote, unit, task, hasSiteVisit, progress);
}

function applyMajorTaskPresentation(status, task, message) {
  const { schedulerSlaType: _schedulerSlaType, ...presented } = status;
  const taskState = normaliseName(task?.status || task?.taskstatus || '');
  const substatus = normaliseName(taskSubstatus(task));
  const stageStep = majorTaskStageStep(task);
  const complete = taskState === 'completed' || taskState === 'complete' || taskState === 'archived' ||
    substatus.startsWith('4 1 completed job') || substatus.startsWith('4 2 completed bath');

  if (complete) {
    return {
      ...presented,
      step: stageStep,
      label: 'Job complete',
      message,
      tone: 'complete',
    };
  }

  if (substatus.includes('on hold') || substatus === 'waiting for deposit payment') {
    return {
      ...presented,
      step: stageStep,
      label: 'Approved — on hold',
      message,
      tone: 'hold',
    };
  }

  if (substatus.includes('booked in')) {
    return {
      ...presented,
      step: stageStep,
      label: 'Booked',
      message,
      tone: 'booked',
    };
  }

  if (substatus.includes('under construction')) {
    return {
      ...presented,
      step: stageStep,
      label: 'In progress',
      message,
      tone: 'approved',
    };
  }

  if (substatus.includes('manufacturing')) {
    return {
      ...presented,
      step: stageStep,
      label: 'In progress — manufacturing',
      message,
      tone: 'approved',
    };
  }

  return { ...presented, step: stageStep, message };
}

function approvedTaskStatus(quote, unit, task, hasSiteVisit, progress) {
  const result = approvedTaskStatusDefault(quote, unit, task, hasSiteVisit, progress);
  const reviewedMessage = unit === 'major' ? majorTaskPortalWording(task) : '';
  if (unit !== 'major') return result;
  if (reviewedMessage) return applyMajorTaskPresentation(result, task, reviewedMessage);
  return { ...result, steps: MAJOR_JOB_STEPS, step: majorTaskStageStep(task) };
}

function approvedTaskStatusDefault(quote, unit, task, hasSiteVisit, progress) {
  const { steps: jobSteps, customMinor, customStep } = progress;
  const taskState = String(task?.status || task?.taskstatus || '').trim().toLowerCase();
  const taskSub = taskSubstatus(task).trim().toLowerCase();
  const base = { ...quote, taskStatus: task?.status || task?.taskstatus || '', taskSubstatus: taskSubstatus(task) };

  if (unit === 'minor') {
    const reviewedMessage = minorTaskPortalWording(task);
    if (reviewedMessage) {
      const complete = taskState === 'completed' || taskState === 'archived';
      const booked = taskSub === 'booked';
      return {
        ...base,
        steps: jobSteps,
        step: customMinor ? customStep : complete ? 4 : booked ? 3 : 2,
        label: minorTaskPortalLabel(task),
        message: reviewedMessage,
        tone: complete ? 'complete' : booked ? 'booked' : taskSub.includes('hold') ? 'hold' : 'approved',
      };
    }
  }

  if (taskState === 'completed' || taskSub === 'completed' || taskSub === 'complete') {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 4,
      label: 'Job complete',
      message: 'The approved work for this job is complete.',
      tone: 'complete',
    };
  }

  if (unit === 'minor' && taskState === 'archived') {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 4,
      label: 'Job complete',
      message: 'The approved work for this job is complete.',
      tone: 'complete',
    };
  }

  if (taskSub.includes('hold')) {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 2,
      label: 'Approved — on hold',
      message: 'Your quote has been approved, but the job is currently on hold.',
      tone: 'hold',
    };
  }

  // An approved quote can still be an update to an existing custom-install job.
  // When AroFlo confirms a completed site visit and requests an approval increase,
  // show that work is underway instead of implying the scheduler is yet to start.
  if (
    hasSiteVisit &&
    isCustomInstall(task) &&
    taskSub.includes('increase approval requested')
  ) {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 2,
      label: 'Site visit completed',
      message: '',
      tone: 'approved',
    };
  }

  return approvedBookingStatus(base, {
    unit,
    task,
    hasSiteVisit,
    jobSteps,
    customMinor,
    customStep,
    taskState,
    taskSub,
  });
}

function approvedBookingStatus(
  base,
  { unit, task, hasSiteVisit, jobSteps, customMinor, customStep, taskState, taskSub },
) {
  // External-contractor jobs have a separate booking process. Do not show the
  // internal scheduler wording or a generic SLA for these jobs; the reviewed
  // customer-facing lead time below is the only commitment we make.
  if (
    isExternalContractor(task) &&
    !isBookedSubstatus(taskSub)
  ) {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 2,
      label: 'Approved',
      message: 'Your quote has been accepted. The estimated lead time for booking is up to 15 business days from the date of approval during standard business periods.',
      tone: 'approved',
    };
  }

  // A custom-install task that is already in progress and marked for booking
  // indicates that the job is nearing installation. Keep this ahead of the
  // generic "to be booked" branch, which is also used for tasks that have not
  // started. Do not claim a manufacturing milestone that AroFlo does not
  // explicitly expose in this task record.
  if (
    isCustomInstall(task) &&
    taskState === 'in progress' &&
    (taskSub.includes('to be booked') || taskSub.includes('ready to book'))
  ) {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 2,
      label: 'In progress — installation to be booked',
      message: 'Your custom-install job is in progress and nearing completion. Our scheduler will be in touch to book the installation.',
      tone: 'approved',
      schedulerSlaType: 'installation',
    };
  }

  if (taskSub.includes('to be booked') || taskSub.includes('ready to book')) {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 2,
      label: 'Approved — to be booked',
      message: 'Your quote has been approved. Our scheduler will be in touch to arrange a booking.',
      tone: 'approved',
      schedulerSlaType: 'booking',
    };
  }

  if (unit === 'minor' && /measures? (complete|printed)|to be manufactured/i.test(taskSub)) {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 2,
      label: 'Approved',
      message: bookingToBeArrangedMessage(task, hasSiteVisit),
      tone: 'approved',
      schedulerSlaType: schedulerSlaType(task, hasSiteVisit),
    };
  }

  if (isBookedSubstatus(taskSub)) {
    return {
      ...base,
      steps: jobSteps,
      step: customMinor ? customStep : 3,
      label: 'Booked',
      message: 'Your quote has been approved and the works have been booked.',
      tone: 'booked',
    };
  }

  return {
    ...base,
    steps: jobSteps,
    step: customMinor ? customStep : 2,
    label: 'Approved',
    message: 'Your quote has been approved. Our scheduler will be in touch to arrange the works.',
    tone: 'approved',
    schedulerSlaType: 'booking',
  };
}

/** A best-effort created timestamp used to sort multiple quotes newest-first. */
export function quoteCreatedTs(q) {
  const raw = q.createddatetime ?? q.createddate ?? q.dateCreated ?? '';
  const t = Date.parse(String(raw).replace(/\//g, '-').replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

/** The contact name shown to the customer (handles both AroFlo and mock key casing). */
export function quoteContactName(q) {
  return q.contactname ?? q.contactName ?? '';
}

/** Map a raw AroFlo quote record to the customer-safe shape. */
/** Resolve a customer-approved scheduler timeframe for the job's next action. */
export function schedulerSlaFor(type, schedulerSla = {}) {
  if (!type) return '';
  // A single general booking SLA can cover every scheduler contact. Specific
  // measure/install values override it when the team uses different timeframes.
  const value = schedulerSla?.[type] || schedulerSla?.booking;
  return typeof value === 'string' ? value.trim() : '';
}

export function sanitiseQuote(
  q,
  { task = null, booking = null, hasSiteVisit = false, schedulerSla = {} } = {},
) {
  const unit = quoteBusinessUnit(q);
  const derived = deriveJobStatus(q.status, quoteSubstatus(q), unit, task, { hasSiteVisit });
  const out = {
    quoteName: q.quoteName ?? q.quotename ?? 'Quote',
    unit: derived.unit,
    unitLabel: derived.unitLabel,
    steps: derived.steps,
    statusLabel: derived.label,
    statusMessage: derived.message,
    step: derived.step,
    terminal: derived.terminal,
    statusTone: derived.tone,
    rawStatus: q.status ?? '',
    dateCreated: q.dateCreated ?? q.createddate ?? '',
    dueDate: q.dueDate ?? q.duedate ?? '',
    dateApproved: q.dateApproved ?? q.approveddate ?? '',
    reference: q.reference ?? q.refno ?? '',
  };
  if (derived.tone === 'booked' && booking) out.booking = booking;
  const schedulerTimeframe = schedulerSlaFor(derived.schedulerSlaType, schedulerSla);
  if (schedulerTimeframe) out.schedulerTimeframe = schedulerTimeframe;
  return out;
}

/**
 * The public-facing service.
 */
export class QuoteService {
  constructor(cfg = config, coordinator = createCoordinator(cfg)) {
    this.cfg = cfg;
    this.client = cfg.mockMode
      ? null
      : new ArofloClient({
          coordinator,
          baseUrl: cfg.aroflo.baseUrl,
          secretKey: cfg.aroflo.secretKey,
          uEncoded: cfg.aroflo.uEncoded,
          pEncoded: cfg.aroflo.pEncoded,
          orgEncoded: cfg.aroflo.orgEncoded,
          hostIp: cfg.aroflo.hostIp,
          accept: cfg.aroflo.accept,
          minRequestIntervalMs: cfg.aroflo.minRequestIntervalMs,
          cacheTtlSeconds: cfg.cacheTtlSeconds ?? 120,
          emptyCacheTtlSeconds: cfg.emptyCacheTtlSeconds ?? 15,
        });
  }

  /**
   * Look up job status for a job number with optional client name and post code.
   * Returns a result object that the route turns into a safe HTTP response.
   * @returns {Promise<{outcome:'verified'|'mismatch'|'notfound', quotes?:object[], locationName?:string}>}
   */
  async lookup(jobNumber, clientName, postcode) {
    const job = String(jobNumber).trim();

    // Defense in depth: enforce the digit-only invariant here too, so the value can
    // never reach an AroFlo WHERE clause unsanitised regardless of the caller.
    if (!isValidJobNumber(job)) return { outcome: 'notfound' };

    // Name and post code are optional. If either is supplied, it must be well-formed
    // and match before the status can be shown.
    const hasName = String(clientName ?? '').trim() !== '';
    const hasPostcode = String(postcode ?? '').trim() !== '';
    if (!this.cfg.jobNumberOnly &&
        ((hasName && !isValidName(clientName)) || (hasPostcode && !isValidPostcode(postcode)))) {
      return { outcome: 'notfound' };
    }

    if (this.cfg.mockMode) return this.#lookupMock(job, clientName, postcode);
    const startedAt = Date.now();
    try { return await this.#lookupLive(job, clientName, postcode); }
    finally {
      if (this.cfg.aroflo.metricsEnabled && this.client.metrics) {
        // Cumulative counters are process-local. Concurrent lookups can overlap;
        // do not present their deltas as precise per-user API consumption.
        let shared;
        try { shared = await this.client.shared?.usage(); }
        catch { shared = { unavailable: true }; } // telemetry must not fail a verified lookup
        console.info('[AroFlo usage]', JSON.stringify({
          lookupDurationMs: Date.now() - startedAt, ...this.client.metrics, ...(shared ? { shared } : {}),
        }));
      }
    }
  }

  #lookupMock(job, clientName, postcode) {
    const record = MOCK_JOBS[job];
    if (!record) return { outcome: 'notfound' };
    // A supplied name or post code must match; omitted fields are deliberately ignored.
    if (!this.cfg.jobNumberOnly) {
      const nameOk = !String(clientName ?? '').trim() || nameMatches(clientName, record.clientName);
      const pcOk = !String(postcode ?? '').trim() ||
        normalisePostcode(postcode) === normalisePostcode(record.postcode);
      if (!nameOk || !pcOk) return { outcome: 'mismatch' };
    }
    return {
      outcome: 'verified',
      locationName: record.locationName || record.quotes[0]?.quoteName || '',
      quotes: record.quotes.map((quote) => sanitiseQuote(quote, {
        task: record.task || null,
        booking: record.booking || null,
        schedulerSla: this.cfg.schedulerSla,
      })),
    };
  }

  async #identityMatches(quotes, clientName, postcode, loadRelevantTask) {
    const hasName = String(clientName ?? '').trim() !== '';
    const hasPostcode = String(postcode ?? '').trim() !== '';
    if (this.cfg.jobNumberOnly || (!hasName && !hasPostcode)) return true;
    let location = null;
    const relevantTask = await loadRelevantTask();
    const locationId = taskLocationId(relevantTask);
    const joined = relevantTask?.location;
    // Only a complete join for the exact linked location can replace its lookup.
    if (locationId && joined?.locationid === locationId &&
        Object.hasOwn(joined, 'SiteContact') && Object.hasOwn(joined, 'postcode')) {
      location = joined;
    } else if (locationId) {
      const locationsResp = await this.client.get({
        zone: 'Locations',
        where: [`and|locationid|=|${locationId}`],
      });
      location = (locationsResp.zoneResponse.locations ?? [])[0] ?? null;
    }

    // Each optional identity field must match the same record. When a physical
    // location has a SiteContact, that is the authoritative customer name; quote
    // contacts are funder/case-manager details on some jobs and remain a fallback
    // only for records without a SiteContact.
    const quoteMatched = quotes.some((q) =>
      suppliedIdentityMatches(
        clientName,
        postcode,
        (value) => clientNameMatches(value, q),
        (value) => postcodeMatches(value, q),
      )
    );
    const hasSiteContact = !!locationSiteContactName(location).trim();
    // Postcode-only checks use the physical address even without a SiteContact.
    // Fall back to the quote if that address has no postcode. Name checks retain
    // the same-record rule and existing SiteContact precedence.
    const useLocation = hasName
      ? hasSiteContact
      : !!normalisePostcode(location?.postcode ?? location?.address?.postcode ?? location?.postCode);
    const locationMatched = useLocation && suppliedIdentityMatches(
      clientName,
      postcode,
      (value) => locationContactMatches(value, location),
      (value) => locationPostcodeMatches(value, location),
    );
    return useLocation ? locationMatched : quoteMatched;
  }

  async #lookupLive(job, clientName, postcode) {
    // Quotes carry the status and legacy contact/address fields. For a supplied
    // resident name, the linked task location is the authoritative AroFlo source.
    const updatesHealthy = this.client.refreshUpdates ? await this.client.refreshUpdates() : false;
    const quotesResp = this.client.getByJob
      ? await this.client.getByJob('Quotes', job, { updatesHealthy })
      : await this.client.get({ zone: 'Quotes', where: [`and|jobnumber|=|${job}`] });
    const quotes = (quotesResp.zoneResponse.quotes ?? [])
      .slice()
      .sort((a, b) => quoteCreatedTs(b) - quoteCreatedTs(a)); // newest first, deterministic
    if (quotes.length === 0) return { outcome: 'notfound' };

    const hasApprovedQuote = quotes.some((q) => String(q.status || '').trim().toLowerCase() === 'approved');
    let tasks = null;
    let task = null;
    let booking = null;
    let hasSiteVisit = false;

    // Load the task once when it is needed either for post-approval status or to
    // resolve the physical job location for supplied identity details.
    const loadRelevantTask = async () => {
      if (tasks !== null) return task;
      const tasksResp = this.client.getByJob
        ? await this.client.getByJob('Tasks', job, { join: ['location'], updatesHealthy })
        : await this.client.get({ zone: 'Tasks', where: [`and|jobnumber|=|${job}`], join: ['location'] });
      tasks = tasksResp.zoneResponse.tasks ?? [];
      task = selectRelevantTask(tasks);
      return task;
    };

    if (!await this.#identityMatches(quotes, clientName, postcode, loadRelevantTask)) {
      return { outcome: 'mismatch' };
    }

    const hasNonFinalQuote = quotes.some((q) => {
      const status = String(q.status || '').trim().toLowerCase();
      return status !== 'approved' && status !== 'rejected';
    });

    if (hasApprovedQuote || hasNonFinalQuote) {
      await loadRelevantTask();

      const taskSub = taskSubstatus(task).trim().toLowerCase();
      // Reviewed customer messages already encode these milestones. Avoid a
      // schedule query when every quote's output is independent of visit history.
      // Mixed/unapproved quotes and actual bookings still need their schedules.
      const allUseReviewedWording = quotes.every((quote) => {
        if (String(quote.status || '').trim().toLowerCase() !== 'approved') return false;
        const unit = quoteBusinessUnit(quote);
        return unit === 'minor' ? !!minorTaskPortalWording(task) : !!majorTaskPortalWording(task);
      });
      const needsScheduleHistory = task && (
        isBookedSubstatus(taskSub) ||
        (!allUseReviewedWording && (
          hasNonFinalQuote ||
          taskSub.includes('increase approval requested') ||
          /measures? (complete|printed)|to be manufactured/i.test(taskSub)
        ))
      );

      if (needsScheduleHistory) {
        const schedulesResp = await (this.client.getCollection || this.client.get).call(this.client, {
          zone: 'Schedules',
          where: [`and|taskid|=|${task.taskid}`],
          page: 1,
          pageSize: 50,
        });
        const schedules = (schedulesResp.zoneResponse.schedules ?? [])
          .filter((schedule) => schedule?.scheduletype?.typeid === task.taskid)
          .filter((schedule) => String(schedule.ishidden).toLowerCase() !== 'true')
          .sort((a, b) => String(a.startdatetime).localeCompare(String(b.startdatetime)));
        if (isBookedSubstatus(taskSub)) booking = sanitiseBooking(selectRelevantSchedule(schedules));
        hasSiteVisit = hasCompletedSiteVisit(schedules);
      }
    }

    return {
      outcome: 'verified',
      locationName: locationNameFor(task, quotes[0]),
      quotes: quotes.map((quote) => sanitiseQuote(quote, {
        task,
        booking,
        hasSiteVisit,
        schedulerSla: this.cfg.schedulerSla,
      })),
    };
  }
}

function taskUpdatedTs(task) {
  const raw = task?.lastupdateddatetimeutc || task?.createddatetimeutc || task?.requestdate || '';
  const parsed = Date.parse(String(raw).replace(/\//g, '-').replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Prefer the most recently updated active, non-quote task. */
export function selectRelevantTask(tasks) {
  const sorted = (tasks || []).slice().sort((a, b) => taskUpdatedTs(b) - taskUpdatedTs(a));
  const nonQuote = sorted.filter((task) => !/quote/i.test(String(task.tasktype || task?.tasktasktype?.tasktype || '')));
  const candidates = nonQuote.length ? nonQuote : sorted;
  return candidates.find((task) => String(task.status || task.taskstatus || '').trim().toLowerCase() !== 'completed') ||
    candidates[0] || null;
}

/** Prefer the next/current booking; fall back to the most recent past booking. */
export function selectRelevantSchedule(schedules, now = new Date()) {
  if (!schedules?.length) return null;
  const today = dateKeyInMelbourne(now);
  const scheduleDate = (schedule) =>
    String(schedule.startdate || schedule.startdatetime || '').slice(0, 10).replace(/\//g, '-');
  return schedules.find((schedule) => scheduleDate(schedule) >= today) ||
    schedules[schedules.length - 1];
}
