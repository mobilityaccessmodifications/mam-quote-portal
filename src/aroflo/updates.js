/** LastUpdate is quota-exempt; check once per minute across the whole deployment.
 * Schedules retain their hard TTL because the provider does not document complete
 * schedule-event coverage. No customer records are fetched by this synchronizer.
 */
export async function refreshUpdates(client, shared) {
  return shared.cached('last-update-check', 60, async () => {
    try {
      return await poll(client, shared);
    } catch (error) {
      if (['shared_unavailable','unavailable','rate_limit'].includes(error.code)) throw error;
      await shared.invalidate();
      console.warn('[AroFlo updates] feed unavailable; using bounded discovery');
      return { healthy: false };
    }
  });
}

async function poll(client, shared) {
  const stateKey = shared.cachePrefix + 'update-cursor';
  const end = Date.now();
  const previous = Number(await shared.redis.eval("return redis.call('GET',KEYS[1])", [stateKey]));
  const since = new Date(Math.max(previous || end - 120000, end - 600000) - 2000).toISOString().slice(0, 19).replace('T', ' ');
  let changed = false;
  for (let page = 1; page <= 5; page++) {
    const result = await client.get({ zone: 'LastUpdate',
      where: [`and|lastupdateutc|>|${since}`], order: ['lastupdateutc|asc'], page, pageSize: 500 });
    if (Date.now() - end > 20000) throw new Error('LastUpdate time budget exceeded');
    const response = result.zoneResponse;
    if (!Array.isArray(response.lastupdate) || response.lastupdate.some(row => typeof row?.zonename !== 'string')) throw new Error('Invalid LastUpdate response');
    changed ||= response.lastupdate.some((row) => ['quotes','tasks','locations','schedules'].includes(String(row.zonename).toLowerCase()));
    const max = Number(response.maxpageresults) || 500;
    if (response.lastupdate.length < max) {
      if (changed) await shared.invalidate();
      // Never regress the cursor if a slow former lease owner finishes late.
      await shared.redis.eval(`local old=tonumber(redis.call('GET',KEYS[1]) or 0)
        if tonumber(ARGV[1]) > old then redis.call('SET',KEYS[1],ARGV[1],'EX',86400) end return 1`, [stateKey], [end]);
      return { healthy: true, checkedAt: end };
    }
  }
  // No cursor advance after truncation; force normal discovery on this lookup.
  throw new Error('LastUpdate pagination incomplete');
}
