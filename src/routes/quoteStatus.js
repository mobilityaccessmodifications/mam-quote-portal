import { Router } from 'express';
import {
  QuoteService,
  isValidJobNumber,
  isValidName,
  isValidPostcode,
} from '../aroflo/quoteService.js';
import { ArofloError } from '../aroflo/client.js';
import config from '../config.js';

export function createQuoteRouter(cfg = config, coordinator) {
  const router = Router();
  const service = new QuoteService(cfg, coordinator);

  // Generic failure message (does not confirm whether a job exists when optional
  // identity fields are provided).
  const GENERIC_FAIL = cfg.jobNumberOnly
    ? "We couldn't find a quote for that job number. " +
      'Please double-check it and try again, or call our office on (03) 9350 4400.'
    : "We couldn't find a quote matching those details. " +
      'Please double-check your job number, name or post code, or call our office on (03) 9350 4400.';

  // Lookups can make different numbers of API calls. We pad
  // every negative response up to a floor (+ random jitter) so absolute response latency
  // can't be used to probe for valid job numbers. The rate limiter is the hard control;
  // this padding is defence in depth.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function padNegative(startedAt) {
    const target = cfg.negResponseFloorMs + Math.floor(Math.random() * (cfg.negResponseJitterMs + 1));
    const remaining = target - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  }

  router.get('/health', (req, res) => {
    // Deliberately minimal — does not expose the server clock. mockMode and jobNumberOnly
    // drive the frontend (demo hint / which fields to show), so are intentionally included.
    res.json({ ok: true, mockMode: cfg.mockMode, jobNumberOnly: cfg.jobNumberOnly, service: 'quote-status' });
  });

  router.post('/quote-status', async (req, res) => {
    const jobNumber = String(req.body?.jobNumber ?? '').trim();
    const clientName = String(req.body?.clientName ?? '').trim();
    const postcode = String(req.body?.postcode ?? '').trim();

    const inputInvalid = invalidLookupInput({ jobNumber, clientName, postcode }, cfg.jobNumberOnly);
    if (inputInvalid) {
      return res.status(400).json({
        ok: false,
        message: cfg.jobNumberOnly
          ? 'Please enter a valid job number.'
          : 'Please enter a valid job number. If supplied, name and post code must also be valid.',
      });
    }

    const startedAt = Date.now();

    try {
      const result = await service.lookup(jobNumber, clientName, postcode);

      const payload = lookupPayload(result, jobNumber, cfg.verboseClientErrors, GENERIC_FAIL);

      if (!payload.verified && !cfg.jobNumberOnly) await padNegative(startedAt);
      return res.json(payload);
    } catch (err) {
      if (err instanceof ArofloError || ['rate_limit', 'shared_unavailable'].includes(err.code)) {
        // Never log provider messages/bodies: they can contain customer data.
        console.error('[AroFlo error]', err.code);
        if (['rate_limit', 'unavailable', 'shared_unavailable'].includes(err.code)) {
          res.setHeader('Retry-After', String(err.retryAfter || 60));
          return res.status(503).json({ ok: false,
            message: 'The quote system is busy. Please wait a little and try again.' });
        }
        const message =
          err.code === 'auth'
            ? 'The quote system is temporarily unavailable. Please try again later or call our office.'
            : 'Something went wrong while checking your quote. Please try again shortly.';
        return res.status(502).json({ ok: false, message });
      }
      console.error('[Unexpected quote lookup error]');
      return res.status(500).json({ ok: false, message: 'Unexpected error. Please try again later.' });
    }
  });

  return router;
}

function invalidLookupInput({ jobNumber, clientName, postcode }, jobNumberOnly) {
  if (!isValidJobNumber(jobNumber)) return true;
  if (jobNumberOnly) return false;
  return (clientName !== '' && !isValidName(clientName)) ||
    (postcode !== '' && !isValidPostcode(postcode));
}

function lookupPayload(result, jobNumber, verboseClientErrors, genericFail) {
  if (result.outcome === 'verified') {
    return {
      ok: true,
      found: true,
      verified: true,
      jobNumber,
      locationName: result.locationName || null,
      quotes: result.quotes,
    };
  } else {
    // Both "notfound" and "mismatch" return the SAME generic response in
    // production so the portal can't be used to enumerate job numbers.
    return {
      ok: true,
      found: false,
      verified: false,
      message: verboseClientErrors
        ? (result.outcome === 'notfound'
            ? 'No quote was found for that job number.'
            : 'The name / post code do not match the contact we have on file for this job.')
        : genericFail,
    };
  }
}
