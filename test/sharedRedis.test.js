import { QuoteService } from '../src/aroflo/quoteService.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Coordinator } from '../src/shared/coordinator.js';
import * as scripts from '../src/shared/scripts.js';
import { ArofloClient } from '../src/aroflo/client.js';
import { refreshUpdates } from '../src/aroflo/updates.js';
import { TestRedis } from './helpers/redis.js';

const integration = (name, fn) => test(name, { skip: !process.env.REDIS_TEST_PORT }, fn);
const redis = new TestRedis();
const make = (scope = randomUUID(), extra = {}) => new Coordinator({ redis, secret:'synthetic-secret', scope, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r,ms));

integration('real Redis coalesces independent instance misses, expires results and isolates credentials', async () => {
  const scope=randomUUID(), a=make(scope), b=make(scope), other=make(scope,{credentials:'other'});
  let calls=0;
  const load=async () => { calls++; await sleep(50); return { private:'synthetic' }; };
  const results=await Promise.all(Array.from({length:10},(_,i)=>(i%2?a:b).cached('job',0.25,load)));
  assert.equal(calls,1); assert.ok(results.every((x)=>x.private==='synthetic'));
  await other.cached('job',0.25,load); assert.equal(calls,2);
  await sleep(260); await b.cached('job',0.25,load); assert.equal(calls,3);
});
integration('real Redis lease recovery never lets an old owner delete or overwrite a new result', async () => {
  const key='synthetic:'+randomUUID(), keys=[key,key+':lock',key+':metrics',key+':pending'];
  assert.deepEqual(await redis.eval(scripts.acquire,keys,['old',20]),['owner']);
  await sleep(30);
  assert.deepEqual(await redis.eval(scripts.acquire,keys,['new',1000]),['owner']);
  assert.equal(await redis.eval(scripts.release,[key+':lock',key+':pending'],['old']),0);
  assert.equal(await redis.eval(scripts.publish,[key,key+':lock',key+':entries',key+':sizes',key+':pending'],['old','bad',1000,2,1000,2000]),0);
  assert.equal(await redis.command(['GET',key+':lock']),'new');
});
integration('real Redis errors are not cached and generation changes invalidate every instance', async () => {
  const scope=randomUUID(),a=make(scope),b=make(scope);
  await assert.rejects(a.cached('fail',10,async()=>{throw new Error('synthetic');}));
  assert.equal(await b.cached('fail',10,async()=>1),1);
  const old=await a.generation();
  await a.cached('value',10,async()=>1,{generation:old});
  await b.invalidate();
  assert.equal(await a.cached('value',10,async()=>2,{generation:await a.generation()}),2);
});
integration('real Redis cache enforces entry and byte bounds, including expired cleanup', async () => {
  const prefix='synthetic:'+randomUUID();
  for (let i=0;i<4;i++) {
    const key=prefix+i;
    await redis.eval(scripts.acquire,[key,key+':lock',prefix+':metrics',prefix+':pending'],['owner',1000]);
    await redis.eval(scripts.publish,[key,key+':lock',prefix+':entries',prefix+':sizes',prefix+':pending'],['owner','x'.repeat(60),80,2,100,1000]);
  }
  assert.equal(await redis.command(['ZCARD',prefix+':entries']),1);
  assert.equal(await redis.command(['GET',prefix+'0']),null);
  await sleep(90); assert.equal(await redis.command(['GET',prefix+'3']),null);
});
integration('real Redis admits globally spaced requests and shares cooldown/daily budgets', async () => {
  const scope=randomUUID(),a=make(scope,{dailyBudget:2}),b=make(scope,{dailyBudget:2});
  const times=await Promise.all([a,b].map(async c=>{await c.admit('ordinary');return Date.now();}));
  assert.ok(Math.abs(times[1]-times[0])>=550);
  await assert.rejects(a.admit('ordinary'),{code:'rate_limit'});
  await a.cooldown(2); await assert.rejects(b.admit('secondary'),{code:'rate_limit'});
});
integration('real Redis tracks provider quota conservatively across out-of-order replies', async () => {
  const scope=randomUUID(),a=make(scope),b=make(scope);
  await a.observe({dailyRemaining:0});await b.observe({dailyRemaining:10});
  await assert.rejects(b.admit('ordinary'),{code:'rate_limit'});
  await b.admit('exempt'); // LastUpdate does not use the daily allowance
});
integration('real Redis IP limit is atomic across instances and resets on expiry', async () => {
  const scope=randomUUID(),a=make(scope),b=make(scope);
  const values=await Promise.all(Array.from({length:12},(_,i)=>(i%2?a:b).limitIp('synthetic-ip',0.1)));
  assert.deepEqual(values.map(x=>x.count).sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i+1));
  await sleep(110);assert.equal((await a.limitIp('synthetic-ip',0.1)).count,1);
});
integration('LastUpdate single-flight paginates, invalidates and only advances complete cursor', async () => {
  const shared=make();let calls=0;
  const client={get:async(q)=>{calls++;return {zoneResponse:{lastupdate:q.page===1?[{zonename:'quotes',zoneid:'synthetic'}]:[],maxpageresults:1}};}};
  await Promise.all([refreshUpdates(client,shared),refreshUpdates(client,shared)]);
  assert.equal(calls,2);assert.notEqual(await shared.generation(),'0');
  assert.ok(Number(await redis.command(['GET',shared.cachePrefix+'update-cursor']))>0);
  const incomplete=make();
  assert.equal((await refreshUpdates({get:async()=>({zoneResponse:{lastupdate:[{}],maxpageresults:1}})},incomplete)).healthy,false);
  assert.equal(await redis.command(['GET',incomplete.cachePrefix+'update-cursor']),null);
});
integration('ID discovery seeds fresh records; later refresh uses secondary quota and new events rediscover membership', async (t) => {
  const shared=make();let byId=0,byJob=0;
  t.mock.method(globalThis,'fetch',async(url)=>{
    const u=new URL(url),id=u.searchParams.get('where').includes('|quoteid|');id?byId++:byJob++;
    return new Response(JSON.stringify({status:'0',zoneresponse:{quotes:[{quoteid:'synthetic-id',jobnumber:'999999999999'}]}}));
  });
  const options={coordinator:shared,secretKey:'synthetic-secret',baseUrl:'https://aroflo.invalid',cacheTtlSeconds:0.1};
  const a=new ArofloClient(options),b=new ArofloClient(options);
  await a.getByJob('Quotes','999999999999',{updatesHealthy:true});
  await b.getByJob('Quotes','999999999999',{updatesHealthy:true});
  assert.equal(byJob,1);assert.equal(byId,0);
  await sleep(120);
  await b.getByJob('Quotes','999999999999',{updatesHealthy:true});assert.equal(byId,1);
  await shared.invalidate();
  await a.getByJob('Quotes','999999999999',{updatesHealthy:true});assert.equal(byJob,2);
});
integration('shared outage never falls back to an uncoordinated AroFlo request', async (t) => {
  const mocked=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Must not call upstream');});
  const shared=make(); shared.redis={eval:async()=>{const e=new Error('down');e.code='shared_unavailable';throw e;}};
  const client=new ArofloClient({coordinator:shared});
  await assert.rejects(client.get({zone:'Quotes'}),{code:'unavailable'});
  assert.equal(mocked.mock.callCount(),0);
});

integration('global pending work is bounded, and released capacity can be reused', async () => {
  const shared=make(), pending=[];let finish;
  const ready=new Promise(r=>{finish=r;});
  for (let i=0;i<32;i++) pending.push(shared.cached('work'+i,1,async()=>{await ready;return 1;}));
  for (let i=0;i<100;i++) {
    if (await redis.command(['ZCARD',shared.cachePrefix+'pending'])===32) break;
    await sleep(5);
  }
  await assert.rejects(shared.cached('overflow',1,async()=>2),{code:'rate_limit'});
  finish();await Promise.all(pending);
  assert.equal(await shared.cached('overflow',1,async()=>2),2);
});
integration('ten cross-instance quote lookups spend four upstream reads including LastUpdate and recheck identity', async (t) => {
  const scope=randomUUID();let calls=0;
  t.mock.method(globalThis,'fetch',async(url)=>{
    calls++;
    const zone=new URL(url).searchParams.get('zone');
    const zones={
      LastUpdate:{lastupdate:[]},
      Quotes:{quotes:[{quoteid:'synthetic-quote',jobnumber:'999999999999',status:'Approved',org:{orgname:'MAJOR MODS'}}]},
      Tasks:{tasks:[{taskid:'synthetic-task',jobnumber:'999999999999',status:'Pending',substatus:'Booked',
        tasklocation:{locationid:'synthetic-location'},location:{locationid:'synthetic-location',SiteContact:'Synthetic Resident',postcode:'3999'}}]},
      Schedules:{schedules:[]},
    };
    assert.ok(zones[zone]);
    return new Response(JSON.stringify({status:'0',zoneresponse:zones[zone]}));
  });
  const cfg={mockMode:false,jobNumberOnly:false,cacheTtlSeconds:120,aroflo:{secretKey:'synthetic-secret',baseUrl:'https://aroflo.invalid'}};
  const a=new QuoteService(cfg,make(scope)),b=new QuoteService(cfg,make(scope));
  const values=await Promise.all(Array.from({length:10},(_,i)=>(i%2?a:b).lookup('999999999999','Synthetic Resident','3999')));
  assert.ok(values.every(v=>v.outcome==='verified'));
  assert.equal(calls,4);
  assert.equal((await b.lookup('999999999999','Wrong Resident','3999')).outcome,'mismatch');
  assert.equal(calls,4);
  const metrics=await a.client.shared.usage();assert.equal(metrics.admissions,4);assert.ok(metrics.cacheHits>0);
});
integration('HTTP throttle received by one instance blocks another instance without spending a call', async (t) => {
  const scope=randomUUID();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('busy',{status:429,headers:{'Retry-After':'10'}});});
  const options={secretKey:'synthetic-secret',baseUrl:'https://aroflo.invalid'};
  const a=new ArofloClient({...options,coordinator:make(scope)}),b=new ArofloClient({...options,coordinator:make(scope)});
  await assert.rejects(a.get({zone:'Quotes'}),{code:'rate_limit'});
  await assert.rejects(b.get({zone:'Tasks'}),{code:'rate_limit'});
  assert.equal(calls,1);
});
integration('provider failure and malformed incremental feed cache a fallback without cursor advancement', async () => {
  const shared=make();let calls=0;
  const client={get:async()=>{calls++;throw new Error('synthetic provider error');}};
  assert.equal((await refreshUpdates(client,shared)).healthy,false);
  assert.equal((await refreshUpdates(client,shared)).healthy,false);
  assert.equal(calls,1);
  assert.equal(await redis.command(['GET',shared.cachePrefix+'update-cursor']),null);
});

integration('seeding the record-ID cache never extends an existing resource freshness window', async (t) => {
  const shared=make();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({status:'0',zoneresponse:{quotes:[{quoteid:'synthetic',jobnumber:'999999999999'}]}}));});
  const client=new ArofloClient({coordinator:shared,secretKey:'synthetic',baseUrl:'https://aroflo.invalid',cacheTtlSeconds:0.15});
  await client.get({zone:'Quotes',where:['and|jobnumber|=|999999999999']});
  await sleep(90);
  await client.getByJob('Quotes','999999999999',{updatesHealthy:true});
  assert.equal(calls,1);
  await sleep(80);
  await client.getByJob('Quotes','999999999999',{updatesHealthy:true});
  assert.equal(calls,2);
});
