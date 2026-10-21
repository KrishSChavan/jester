import test from 'node:test';
import assert from 'node:assert/strict';
import { createPooledModelClient, nextModelCooldown, AllModelsRateLimitedError } from '../jester-extension/src/background/model-pool.js';
import { normalizeModelConfig, RateLimitError, ModelTimeoutError } from '../jester-extension/src/background/model-client.js';
import { runAssistant } from '../jester-extension/src/background/assistant.js';

const config = (id,provider='groq') => ({id,...normalizeModelConfig({provider,model:`model-${id}`,key:`private-key-${id}`}),cooldownUntil:0});
const result = {action:{action:'finish',success:true,say:'Done.'}};
function fixture(initial=[config('a'),config('b')]) {
  let entries=structuredClone(initial);
  let time=1000000;
  const limited=[];
  return {
    load:async()=>structuredClone(entries),now:()=>time,
    markLimited:async(id,until)=>{
      const entry=entries.find(item=>item.id===id);
      entry.cooldownUntil=Math.max(entry.cooldownUntil,until);
      entries=[...entries.filter(item=>item.id!==id),entry];
      limited.push(id);
    },
    advance:ms=>{time+=ms;},get entries(){return entries;},limited
  };
}
const options = {system:'Return JSON actions.',prompt:'Complete the original task exactly.'};

test('a 429 rotates to the next saved provider with the same request and its own key',async()=>{
  const h=fixture([config('a','google'),config('b')]);
  const requests=[];
  const client=createPooledModelClient(h);
  const output=await client({...options,fetchImpl:async(url,init)=>{
    requests.push({url,headers:init.headers,body:JSON.parse(init.body)});
    return requests.length===1
      ? Response.json({error:{message:'Rate limited',details:[{retryDelay:'33s'}]}},{status:429})
      : Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
  }});
  assert.equal(output.model,'model-b');
  assert.equal(output.provider,'groq');
  assert.equal(output.timings.attempts,2);
  assert.deepEqual(h.entries.map(entry=>entry.id),['b','a']);
  assert.equal(h.entries[1].cooldownUntil,h.now()+33000);
  assert.equal(requests.length,2);
  assert.equal(requests[0].headers['x-goog-api-key'],'private-key-a');
  assert.equal(requests[1].headers.authorization,'Bearer private-key-b');
  assert.equal(requests[0].body.contents[0].parts[0].text,options.prompt);
  assert.equal(requests[1].body.messages[1].content,options.prompt);
  assert.equal(JSON.stringify(requests[0]).includes('private-key-b'),false);
  assert.equal(JSON.stringify(requests[1]).includes('private-key-a'),false);
  const reused=[];
  const same=createPooledModelClient({...h,request:async({config})=>{reused.push(config.model);return {json:result,model:config.model};}});
  await same(options);
  assert.deepEqual(reused,['model-b']);
});

test('all rate limits return the earliest deadline and cooled models are not called again',async()=>{
  const h=fixture();const calls=[];const badges=[];
  const client=createPooledModelClient({...h,onUnavailable:async badge=>badges.push(badge),
    request:async({config})=>{calls.push(config.model);throw new RateLimitError({provider:'groq',retryAfterMs:config.model==='model-a'?33000:60000});}});
  await assert.rejects(client(options),error=>{
    assert.ok(error instanceof AllModelsRateLimitedError);
    assert.equal(error.cooldown.model,'model-a');
    assert.equal(error.cooldown.readyAt,h.now()+33000);
    return true;
  });
  assert.deepEqual(calls,['model-a','model-b']);
  assert.equal(badges[0].allLimited,true);
  await assert.rejects(client(options),AllModelsRateLimitedError);
  assert.equal(calls.length,2,'No polling requests during cooldown');
  h.advance(33001);
  assert.equal(nextModelCooldown(h.entries,h.now()),null);
  const ready=createPooledModelClient({...h,request:async({config})=>({json:result,model:config.model})});
  assert.equal((await ready(options)).model,'model-a');
});

test('authorization, schema and server failures stop without rotating models',async()=>{
  for(const error of [Object.assign(new Error('Rejected key'),{code:'http_error',status:401}),
    Object.assign(new Error('Busy'),{code:'provider_busy',status:503}),
    Object.assign(new Error('Truncated'),{code:'model_output_truncated'})]) {
    const h=fixture();let calls=0;
    const client=createPooledModelClient({...h,request:async()=>{calls++;throw error;}});
    await assert.rejects(client(options),failure=>failure===error);
    assert.equal(calls,1);
    assert.deepEqual(h.limited,[]);
    assert.deepEqual(h.entries.map(entry=>entry.id),['a','b']);
  }
});

test('canceling during failover prevents the next model request',async()=>{
  const h=fixture();const controller=new AbortController();let calls=0;
  const client=createPooledModelClient({...h,onLimited:()=>controller.abort(),
    request:async()=>{calls++;throw new RateLimitError({provider:'groq',retryAfterMs:33000});}});
  await assert.rejects(client({...options,signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,1);
  assert.deepEqual(h.limited,['a']);
});

test('fallback models share one deadline including selection overhead',async()=>{
  const h=fixture();let elapsed=0;const budgets=[];
  const client=createPooledModelClient({...h,clock:()=>elapsed,onSelected:()=>{elapsed+=100;},
    request:async({maxElapsedMs,config})=>{
      budgets.push(maxElapsedMs);
      if(config.model==='model-a'){elapsed+=6000;throw new RateLimitError({provider:'groq',retryAfterMs:33000});}
      throw new ModelTimeoutError();
    }});
  await assert.rejects(client(options),ModelTimeoutError);
  assert.deepEqual(budgets,[9900,3800]);
});

test('stalled selection callbacks are covered by the pool deadline',async()=>{
  const h=fixture();let calls=0;
  const client=createPooledModelClient({...h,onSelected:async()=>new Promise(()=>{}),
    request:async()=>{calls++;return {json:result};}});
  await assert.rejects(client({...options,maxElapsedMs:20}),ModelTimeoutError);
  assert.equal(calls,0);
});

test('a stalled provider counts its in-flight request when the shared deadline expires',async()=>{
  const h=fixture();
  const client=createPooledModelClient({...h,request:async()=>new Promise(()=>{})});
  await assert.rejects(client({...options,maxElapsedMs:20}),error=>{
    assert.ok(error instanceof ModelTimeoutError);
    assert.equal(error.timings.attempts,1);
    assert.ok(error.timings.requestMs>=15);
    return true;
  });
});

test('cancellation ends stalled storage reads and cannot later launch a request',async()=>{
  const controller=new AbortController();let release;let calls=0;
  const client=createPooledModelClient({load:()=>new Promise(resolve=>{release=resolve;}),
    request:async()=>{calls++;return {json:result};}});
  const pending=client({...options,signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  release([config('a')]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,0);
});

test('unknown quota delays have bounded conservative retry deadlines',async()=>{
  for(const [daily,delay] of [[false,60000],[true,86400000]]) {
    const h=fixture([config('only')]);
    const client=createPooledModelClient({...h,request:async()=>{throw new RateLimitError({provider:'groq',daily});}});
    await assert.rejects(client(options),error=>error.cooldown.readyAt===h.now()+delay);
  }
});

test('an expired earlier cooldown never produces a false all-limited countdown',async()=>{
  const h=fixture();const badges=[];let calls=0;
  const client=createPooledModelClient({...h,onUnavailable:badge=>badges.push(badge),
    request:async()=>{
      calls++;
      if(calls===2)h.advance(2000);
      throw new RateLimitError({provider:'groq',retryAfterMs:calls===1?1000:33000});
    }});
  await assert.rejects(client(options),error=>{
    assert.equal(error.code,'model_pool_retry_ready');
    assert.match(error.message,/retried now/);
    return true;
  });
  assert.equal(calls,2);
  assert.deepEqual(badges,[null]);
});

test('model failover continues the same assistant step and executes its page action once',async(t)=>{
  t.mock.method(console,'info',()=>{});
  const h=fixture();let calls=0;let executions=0;const checkpoints=[];
  const modelClient=createPooledModelClient({...h,request:async({config})=>{
    calls++;
    if(calls===1)throw new RateLimitError({provider:'groq',retryAfterMs:33000});
    return {model:config.model,json:executions?result:{action:{action:'click',elementId:'episode'}}};
  }});
  const answer=await runAssistant({text:'Open this episode',env:h.entries[0],modelClient,
    host:{observe:async()=>({ok:true,pageId:'page',revision:executions,title:'Show',url:'https://www.hulu.com/',text:'[episode] button Play'}),
      execute:async()=>{executions++;return {ok:true,detail:'Clicked'};},checkpoint:async state=>checkpoints.push(structuredClone(state))}});
  assert.equal(answer.ok,true);
  assert.equal(executions,1);
  assert.equal(calls,3,'429 + successful action response + completion response');
  assert.equal(checkpoints.at(-1),null);
  assert.equal(checkpoints.find(state=>state?.pendingAction)?.goal,'Open this episode');
});
