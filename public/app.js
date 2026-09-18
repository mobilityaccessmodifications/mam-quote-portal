// ============================================================================
//  Job Status portal — frontend logic
// ============================================================================
const form = document.getElementById('quote-form');
const jobInput = document.getElementById('jobNumber');
const nameInput = document.getElementById('clientName');
const postcodeInput = document.getElementById('postcode');
const submitBtn = document.getElementById('submit-btn');
const formError = document.getElementById('form-error');
const results = document.getElementById('results');
const statusRegion = document.getElementById('status-region');

document.getElementById('year').textContent = new Date().getFullYear();

// Server mode. In jobNumberOnly (internal-testing) mode we hide the optional identity
// fields. In normal mode, a job number is enough; any supplied identity field is verified.
let jobOnly = false;
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (h && h.jobNumberOnly) {
      jobOnly = true;
      document.body.classList.add('job-only');
      const sub = document.getElementById('tracker-sub');
      if (sub) sub.textContent = 'Enter your job number to see the latest status of your job.';
      // The hidden fields must not block submission.
      nameInput.removeAttribute('required');
      postcodeInput.removeAttribute('required');
    }
  })
  .catch(() => {});

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function setLoading(on) {
  submitBtn.disabled = on;
  submitBtn.classList.toggle('loading', on);
  submitBtn.querySelector('.btn-label').textContent = on ? 'Checking…' : 'Check status';
  results.setAttribute('aria-busy', on ? 'true' : 'false');
}

function announce(msg) {
  statusRegion.textContent = msg;
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = !msg;
}

function setInvalid(input, invalid) {
  input.classList.toggle('invalid', invalid);
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(d) {
  if (!d) return null;
  const raw = String(d).trim();
  // AroFlo / MySQL zero-date placeholders should display as nothing.
  if (/^0000[-/]?0?0?[-/]?0?0?/.test(raw) || raw === '0') return null;
  // Accept "YYYY-MM-DD", "YYYY/MM/DD" and "YYYY-MM-DD HH:MM:SS".
  const iso = raw.replace(/\//g, '-').replace(' ', 'T');
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return escapeHtml(raw);
  return parsed.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return value ? escapeHtml(value) : null;
  const hours = Number(match[1]);
  const minutes = match[2];
  if (hours > 23) return escapeHtml(value);
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes} ${suffix}`;
}

function stepperHtml(step, steps, declined) {
  const items = (steps || []).map((label, i) => {
    const n = i + 1;
    let cls = 'step';
    let state = '';
    if (!declined) {
      if (n < step) { cls += ' done'; state = ' (completed)'; }
      else if (n === step) { cls += ' current done'; state = ' (current step)'; }
    }
    const current = !declined && n === step ? ' aria-current="step"' : '';
    return `<div class="${cls}"${current}>${escapeHtml(label)}<span class="sr-only">${state}</span></div>`;
  }).join('');
  return `<div class="stepper${declined ? ' declined' : ''}" role="list" aria-label="Job progress">${items}</div>`;
}

function quoteCardHtml(q, jobNumber, idx, total) {
  const declined = q.terminal === 'declined';
  const steps = q.steps || [];
  const isFinal = !declined && q.step >= steps.length;
  const pillClass = declined ? 's0' : isFinal ? 's4' : 's1';

  const details = [];

  const bookingDetails = [];
  if (q.booking) {
    const bookingDate = fmtDate(q.booking.date);
    if (bookingDate) bookingDetails.push(['Booking date', bookingDate]);
    const start = fmtTime(q.booking.startTime);
    const end = fmtTime(q.booking.endTime);
    if (start && end) bookingDetails.push(['Calendar time', `${start}–${end}`]);
    if (q.booking.confirmedWindow) {
      bookingDetails.push(['Confirmed window', escapeHtml(q.booking.confirmedWindow.replace(/^Confirmed\s+/i, ''))]);
    }
    if (q.booking.tradeName) bookingDetails.push(['Trade', escapeHtml(q.booking.tradeName)]);
  }

  const detailHtml = details.length
    ? `<dl class="detail-grid">${details
        .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`)
        .join('')}</dl>`
    : '';

  const bookingHtml = bookingDetails.length
    ? `<section class="booking-panel" aria-label="Booking details">
        <h4>Booking details</h4>
        <dl class="booking-grid">${bookingDetails
          .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`)
          .join('')}</dl>
      </section>`
    : '';

  const heading = total > 1 ? `${escapeHtml(q.quoteName)} <span class="result-job">Quote ${idx + 1} of ${total}</span>`
                            : escapeHtml(q.quoteName);

  return `
    <article class="result-card">
      <div class="result-head">
        <h3>${heading}</h3>
        <span class="result-job">Job #${escapeHtml(jobNumber)}</span>
      </div>
      ${q.unitLabel ? `<p class="unit-badge">${escapeHtml(q.unitLabel)}</p>` : ''}
      <span class="status-pill ${pillClass}">${escapeHtml(q.statusLabel)}</span>
      ${stepperHtml(q.step, q.steps, declined)}
      ${q.statusMessage ? `<p class="status-message${declined ? ' declined' : ''}">${escapeHtml(q.statusMessage)}</p>` : ''}
      ${q.schedulerTimeframe ? `<p class="scheduler-timeframe"><strong>Expected scheduler contact:</strong> ${escapeHtml(q.schedulerTimeframe)}</p>` : ''}
      ${bookingHtml}
      ${detailHtml}
    </article>`;
}

function focusResults() {
  results.focus({ preventScroll: true });
  results.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

function renderVerified(data) {
  results.innerHTML = data.quotes
    .map((q, i) => quoteCardHtml(q, data.jobNumber, i, data.quotes.length))
    .join('');
  // Concise, ordered summary for screen readers.
  const first = data.quotes[0];
  announce(`Status for job ${data.jobNumber}: ${[first.statusLabel, first.statusMessage].filter(Boolean).join('. ')}`);
  focusResults();
}

function renderNotice(message, isError) {
  results.innerHTML = `
    <div class="notice-card${isError ? ' error' : ''}">
      <h3>${isError ? 'Something went wrong' : "We couldn't find that job"}</h3>
      <p>${escapeHtml(message)}</p>
    </div>`;
  announce(message);
  focusResults();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showFormError('');
  results.innerHTML = '';

  const jobNumber = jobInput.value.trim();
  const clientName = nameInput.value.trim();
  const postcode = postcodeInput.value.trim();

  const jobOk = /^[0-9]{1,12}$/.test(jobNumber);
  const nameOk = jobOnly || !clientName || clientName.length >= 2;
  const postcodeOk = jobOnly || !postcode || /^[0-9]{3,4}$/.test(postcode);
  setInvalid(jobInput, !jobOk);
  if (!jobOnly) {
    setInvalid(nameInput, !nameOk);
    setInvalid(postcodeInput, !postcodeOk);
  }

  if (!jobOk || !nameOk || !postcodeOk) {
    const missing = [];
    if (!jobOk) missing.push('a job number (digits only)');
    if (!nameOk) missing.push('a valid name');
    if (!postcodeOk) missing.push('a valid post code');
    showFormError('Please enter ' + missing.join(', ') + '.');
    (!jobOk ? jobInput : !nameOk ? nameInput : postcodeInput).focus(); // first invalid field
    return;
  }

  setLoading(true);
  announce('Checking your job status…');
  try {
    const res = await fetch('/api/quote-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobNumber, clientName, postcode }),
    });
    const data = await res.json();

    if (res.status === 429) { renderNotice(data.message, true); return; }
    if (!res.ok) { renderNotice(data.message || 'Please try again shortly.', true); return; }

    if (data.verified) renderVerified(data);
    else renderNotice(data.message, false);
  } catch (err) {
    renderNotice('We could not reach the job tracker. Please check your connection and try again.', true);
  } finally {
    setLoading(false);
  }
});
