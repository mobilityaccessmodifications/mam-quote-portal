/** Read only documented numeric quota headers; absence means unknown, not zero. */
export function readRateLimits(headers) {
  const limits = {};
  for (const [key, header] of Object.entries({
    minuteLimit: 'x-ratelimit-limit',
    minuteRemaining: 'x-ratelimit-remaining',
    dailyLimit: 'x-ratelimit-daily-limit',
    dailyRemaining: 'x-ratelimit-daily-remaining',
    secondaryDailyLimit: 'x-ratelimit-secondary-daily-limit',
    secondaryDailyRemaining: 'x-ratelimit-secondary-daily-remaining',
  })) {
    const value = headers.get(header);
    if (value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) limits[key] = Number(value);
  }
  return limits;
}

/** Seconds until the next Melbourne midnight, including daylight-saving transitions. */
export function dailyResetSeconds(now = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = (time) => Object.fromEntries(formatter.formatToParts(time).map(({ type, value }) => [type, Number(value)]));
  const local = parts(now);
  const target = Date.UTC(local.year, local.month - 1, local.day + 1);
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const at = parts(candidate);
    candidate += target - Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second);
  }
  return Math.max(1, Math.ceil((candidate - now) / 1000));
}

export function retryAfterSeconds(value, fallback = 60, now = Date.now()) {
  if (value === null || value === undefined || value === '') return fallback;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.max(1, Math.min(seconds, 86400)) : fallback;
}
