// Redis TIME is the common clock. Lua keeps cache ownership and admission atomic.
export const acquire = `
local value = redis.call('GET', KEYS[1])
if value then redis.call('HINCRBY',KEYS[3],'cacheHits',1); redis.call('EXPIRE',KEYS[3],172800); return {'hit', value, redis.call('PTTL', KEYS[1])} end
local tm = redis.call('TIME'); local now = tm[1]*1000 + math.floor(tm[2]/1000)
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
if redis.call('ZCARD', KEYS[4]) >= 32 then return {'busy'} end
if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2]) then
 redis.call('ZADD', KEYS[4], now+tonumber(ARGV[2]), KEYS[2]); redis.call('PEXPIRE', KEYS[4], ARGV[2]); return {'owner'}
end
return {'wait', redis.call('PTTL', KEYS[2])}
`;
export const release = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('ZREM', KEYS[2], KEYS[1]); return redis.call('DEL', KEYS[1]) end
return 0
`;
export const publish = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local tm = redis.call('TIME'); local now = tm[1]*1000 + math.floor(tm[2]/1000)
local function remove(key)
 redis.call('DEL', key); redis.call('ZREM', KEYS[3], key); redis.call('HDEL', KEYS[4], key)
end
for _, key in ipairs(redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)) do remove(key) end
local size = string.len(ARGV[2]); local ttl = tonumber(ARGV[3])
if ttl > 0 and size <= tonumber(ARGV[5]) then
 local total = 0
 for _, bytes in ipairs(redis.call('HVALS', KEYS[4])) do total = total + tonumber(bytes) end
 total = total - tonumber(redis.call('HGET', KEYS[4], KEYS[1]) or 0)
 while redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[4]) or total + size > tonumber(ARGV[5]) do
  local oldest = redis.call('ZRANGE', KEYS[3], 0, 0)[1]
  if not oldest then break end
  total = total - tonumber(redis.call('HGET', KEYS[4], oldest) or 0); remove(oldest)
 end
 redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
 redis.call('ZADD', KEYS[3], now + ttl, KEYS[1]); redis.call('HSET', KEYS[4], KEYS[1], size)
 redis.call('PEXPIRE', KEYS[3], ARGV[6]); redis.call('PEXPIRE', KEYS[4], ARGV[6])
end
redis.call('DEL', KEYS[2]); redis.call('ZREM', KEYS[5], KEYS[2]); return 1
`;
export const admit = `
local tm = redis.call('TIME'); local now = tm[1]*1000 + math.floor(tm[2]/1000)
local cool = redis.call('PTTL', KEYS[1])
if cool > 0 then return {'limited', cool} end
local nextAt = tonumber(redis.call('GET', KEYS[2]) or 0)
if nextAt > now then return {'wait', nextAt-now} end
if ARGV[2] ~= 'exempt' then
 local count = tonumber(redis.call('GET', KEYS[3]) or 0)
 if count >= tonumber(ARGV[3]) then return {'limited', redis.call('PTTL', KEYS[3])} end
 local remaining = tonumber(redis.call('GET', KEYS[4]) or -1)
 if remaining == 0 then return {'limited', redis.call('PTTL', KEYS[4])} end
 redis.call('INCR', KEYS[3]); if count == 0 then redis.call('PEXPIRE', KEYS[3], ARGV[4]) end
 if remaining > 0 then redis.call('DECR', KEYS[4]) end
end
redis.call('SET', KEYS[2], now+tonumber(ARGV[1]), 'PX', ARGV[1])
redis.call('HINCRBY', KEYS[5], 'admissions', 1); redis.call('HINCRBY', KEYS[5], ARGV[2], 1); redis.call('EXPIRE', KEYS[5], 172800)
return {'ok'}
`;
export const cooldown = `
local ttl = tonumber(ARGV[1])
if redis.call('PTTL', KEYS[1]) < ttl then redis.call('SET', KEYS[1], '1', 'PX', ttl) end
return 1
`;
export const remaining = `
local existing = tonumber(redis.call('GET', KEYS[1]) or -1)
local observed = tonumber(ARGV[1])
if existing < 0 or observed < existing then redis.call('SET', KEYS[1], observed, 'PX', ARGV[2]) end
return 1
`;
export const ipLimit = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;
