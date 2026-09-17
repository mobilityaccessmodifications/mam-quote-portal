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
export function normaliseName(value) {
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

export const FLOWS = {
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
export function quoteBusinessUnit(q) {
  const org = String(q?.org?.orgname ?? q?.businessUnit ?? '').toLowerCase();
  return org.includes('minor') ? 'minor' : 'major'; // MAJOR MODS is the default/dominant unit
}

/** Read the quote substatus text, handling AroFlo's nested object and the mock string. */
export function quoteSubstatus(q) {
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
export function taskType(task) {
  return task?.tasktype || task?.tasktasktype?.tasktype || '';
}

/** Whether the task is a custom install, for customer-safe booking wording. */
export function isCustomInstall(task) {
  return /\bcustom\b/i.test(taskType(task));
}

/** Whether AroFlo assigns this job to an external contractor workflow. */
export function isExternalContractor(task) {
  return /\bexternal contractor\b/i.test(taskType(task));
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
export function bookingToBeArrangedMessage(task, hasSiteVisit = false) {
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

  const jobSteps = ['Quoted', 'Approved', 'Booked', 'Complete'];

  if (quoteState !== 'approved') {
    if (hasSiteVisit) {
      return {
        ...quote,
        steps: jobSteps,
        step: 2,
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

  const taskState = String(task?.status || task?.taskstatus || '').trim().toLowerCase();
  const taskSub = taskSubstatus(task).trim().toLowerCase();
  const base = { ...quote, taskStatus: task?.status || task?.taskstatus || '', taskSubstatus: taskSubstatus(task) };

  if (taskState === 'completed' || taskSub === 'completed' || taskSub === 'complete') {
    return {
      ...base,
      steps: jobSteps,
      step: 4,
      label: 'Job complete',
      message: 'The approved work for this job is complete.',
      tone: 'complete',
    };
  }

  if (unit === 'minor' && taskState === 'archived') {
    return {
      ...base,
      steps: jobSteps,
      step: 4,
      label: 'Job complete',
      message: 'The approved work for this job is complete.',
      tone: 'complete',
    };
  }

  if (taskSub.includes('hold')) {
    return {
      ...base,
      steps: jobSteps,
      step: 2,
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
      step: 2,
      label: 'Site visit completed',
      message: '',
      tone: 'approved',
    };
  }

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
      step: 2,
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
      step: 2,
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
      step: 2,
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
      step: 2,
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
      step: 3,
      label: 'Booked',
      message: 'Your quote has been approved and the works have been booked.',
      tone: 'booked',
    };
  }

  return {
    ...base,
    steps: jobSteps,
    step: 2,
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
  constructor(cfg = config) {
    this.cfg = cfg;
    this.client = cfg.mockMode
      ? null
      : new ArofloClient({
          baseUrl: cfg.aroflo.baseUrl,
          secretKey: cfg.aroflo.secretKey,
          uEncoded: cfg.aroflo.uEncoded,
          pEncoded: cfg.aroflo.pEncoded,
          orgEncoded: cfg.aroflo.orgEncoded,
          hostIp: cfg.aroflo.hostIp,
          accept: cfg.aroflo.accept,
          minRequestIntervalMs: cfg.aroflo.minRequestIntervalMs,
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
    return this.#lookupLive(job, clientName, postcode);
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

  async #lookupLive(job, clientName, postcode) {
    // Quotes carry the status and legacy contact/address fields. For a supplied
    // resident name, the linked task location is the authoritative AroFlo source.
    const quotesResp = await this.client.get({
      zone: 'Quotes',
      where: [`and|jobnumber|=|${job}`],
    });
    const quotes = (quotesResp.zoneResponse.quotes ?? [])
      .slice()
      .sort((a, b) => quoteCreatedTs(b) - quoteCreatedTs(a)); // newest first, deterministic
    if (quotes.length === 0) return { outcome: 'notfound' };

    const hasName = String(clientName ?? '').trim() !== '';
    const hasPostcode = String(postcode ?? '').trim() !== '';
    const hasApprovedQuote = quotes.some((q) => String(q.status || '').trim().toLowerCase() === 'approved');
    let tasks = null;
    let task = null;
    let booking = null;
    let hasSiteVisit = false;

    // Load the task once when it is needed either for post-approval status or to
    // resolve the physical job location for supplied identity details.
    const loadRelevantTask = async () => {
      if (tasks !== null) return task;
      const tasksResp = await this.client.get({
        zone: 'Tasks',
        where: [`and|jobnumber|=|${job}`],
      });
      tasks = tasksResp.zoneResponse.tasks ?? [];
      task = selectRelevantTask(tasks);
      return task;
    };

    let location = null;
    if (!this.cfg.jobNumberOnly && (hasName || hasPostcode)) {
      const relevantTask = await loadRelevantTask();
      const locationId = taskLocationId(relevantTask);
      if (locationId) {
        const locationsResp = await this.client.get({
          zone: 'Locations',
          where: [`and|locationid|=|${locationId}`],
        });
        location = (locationsResp.zoneResponse.locations ?? [])[0] ?? null;
      }
    }

    // Each optional identity field must match the same record. When a physical
    // location has a SiteContact, that is the authoritative customer name; quote
    // contacts are funder/case-manager details on some jobs and remain a fallback
    // only for records without a SiteContact.
    if (!this.cfg.jobNumberOnly && (hasName || hasPostcode)) {
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
      if (!(useLocation ? locationMatched : quoteMatched)) return { outcome: 'mismatch' };
    }

    const hasNonFinalQuote = quotes.some((q) => {
      const status = String(q.status || '').trim().toLowerCase();
      return status !== 'approved' && status !== 'rejected';
    });

    if (hasApprovedQuote || hasNonFinalQuote) {
      await loadRelevantTask();

      const taskSub = taskSubstatus(task).trim().toLowerCase();
      const needsScheduleHistory = task && (
        hasNonFinalQuote ||
        isBookedSubstatus(taskSub) ||
        taskSub.includes('increase approval requested') ||
        /measures? (complete|printed)|to be manufactured/i.test(taskSub)
      );

      if (needsScheduleHistory) {
        const schedulesResp = await this.client.get({
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
