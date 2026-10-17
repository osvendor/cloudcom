/** Atomic across API replicas; all keys share one Redis cluster hash slot.
 * No sleeps, DB reads, timers, or device payloads in the admission path.
 * Redis TIME prevents replica clock skew from multiplying permits.
 */
export const AGENT_ROLLOUT_LUA = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local prefix, device, site, mode = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local targets, healthy = cjson.decode(ARGV[5]), ARGV[6] == '1'
local concurrent, siteLimit, starts = tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9])
local window, lease, retry, settle = tonumber(ARGV[10]), tonumber(ARGV[11]), tonumber(ARGV[12]), tonumber(ARGV[13])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - window)
local raw = redis.call('GET', KEYS[3])
local old = raw and cjson.decode(raw) or nil

if mode == 'observe' then
  if not old or old.complete or old.expires <= now then return {0, 'no-active-update'} end
  old.observed = old.observed or {}
  for key, value in pairs(targets) do old.observed[key] = value end
  local complete = true
  for key, value in pairs(old.targets) do
    if old.observed[key] ~= value then complete = false end
  end
  if complete then
    old.complete = true
    old.expires = math.max(old.started + window, now + settle)
    old.retryAfter = old.expires
    redis.call('ZADD', KEYS[1], old.expires, device)
    if old.site ~= '' then redis.call('ZADD', prefix .. 'site:' .. old.site, old.expires, device) end
  end
  redis.call('SET', KEYS[3], cjson.encode(old), 'PX', retry)
  return {0, complete and 'settling' or 'awaiting-components'}
end

if old and not old.complete and old.expires > now and redis.call('ZSCORE', KEYS[1], device) then
  -- Continue an admitted bundle under load, but do not sneak a different
  -- release or another component into its reservation while paused.
  for key, value in pairs(targets) do
    if old.targets[key] and old.targets[key] ~= value then return {0, 'different-update-active'} end
    if not old.targets[key] and not healthy then return {0, 'server-pressure'} end
  end
  for key, value in pairs(targets) do old.targets[key] = value end
  redis.call('SET', KEYS[3], cjson.encode(old), 'PX', retry)
  return {1, 'already-admitted'}
end
if old and old.retryAfter > now then return {0, old.complete and 'settling' or 'retry-cooldown'} end
if not healthy then return {0, 'server-pressure'} end
if redis.call('ZCARD', KEYS[1]) >= concurrent then return {0, 'fleet-limit'} end
if redis.call('ZCARD', KEYS[2]) >= starts then return {0, 'start-rate-limit'} end
-- Some command-delivery contexts carry only an authorized device ID, not a
-- verified site. Give those updates an exclusive fleet slot; never infer site
-- identity from a command payload or let unknown sites bypass site limits.
local active = redis.call('ZRANGE', KEYS[1], 0, -1)
if site == '' and #active > 0 then return {0, 'site-unknown-exclusive'} end
for _, activeDevice in ipairs(active) do
  local activeRaw = redis.call('GET', prefix .. 'device:' .. activeDevice)
  if not activeRaw or cjson.decode(activeRaw).site == '' then return {0, 'site-unknown-exclusive'} end
end
if site ~= '' then
  local siteKey = prefix .. 'site:' .. site
  redis.call('ZREMRANGEBYSCORE', siteKey, '-inf', now)
  if redis.call('ZCARD', siteKey) >= siteLimit then return {0, 'site-limit'} end
  redis.call('ZADD', siteKey, now + lease, device)
  redis.call('PEXPIRE', siteKey, retry)
end
local grant = { targets = targets, observed = {}, site = site, started = now, expires = now + lease, retryAfter = now + retry }
redis.call('SET', KEYS[3], cjson.encode(grant), 'PX', retry)
redis.call('ZADD', KEYS[1], now + lease, device)
redis.call('ZADD', KEYS[2], now, device)
redis.call('PEXPIRE', KEYS[1], retry)
redis.call('PEXPIRE', KEYS[2], retry)
return {1, 'admitted'}
`;
