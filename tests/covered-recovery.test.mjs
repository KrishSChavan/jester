import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAssistant } from '../jester-extension/src/background/assistant.js';

const frame = (elements) => ({ok:true,pageId:'results:1',revision:1,
  url:'https://watch.example/search',title:'Search',elements,text:''});
const poster = {id:'poster',role:'link',name:'Rick and Morty',url:'https://watch.example/series/rick'};
const details = {id:'details',role:'link',name:'Details',url:poster.url};

test('a covering link omitted by the compact page is read live before clicking with zero model calls', async (t) => {
  t.mock.method(console,'info',()=>{});
  const actions = [], checkpoints = [];
  let startedPlayback = false;
  let modelCalls = 0;
  const result = await runAssistant({text:'go to rick and morty season 3 episode 2',
    host:{
      checkpoint:async state => checkpoints.push(structuredClone(state)),
      observe:async()=> startedPlayback ? frame([{id:'video',role:'video',name:'Video',playing:true,
        paused:false,context:'Rick and Morty Season 3 Episode 2'}]) : frame(actions.length ? [] : [poster]),
      execute:async action => {
        assert.deepEqual(checkpoints.at(-1).pendingAction,action);
        actions.push(action);
        if (action.elementId === 'poster') return {ok:false,pageId:'results:1',errorClass:'covered_target',
          notDispatched:true,blockingElements:[{...details,sameDestination:true}]};
        if (action.action === 'read_element') return frame([details]);
        assert.equal(action.action,'click');
        assert.equal(action.elementId,'details');
        startedPlayback = true;
        return {ok:true};
      }
    },
    modelClient:async()=>{ modelCalls++; throw new Error('Unexpected model request'); }
  });
  assert.equal(result.ok,true);
  assert.equal(modelCalls,0);
  assert.deepEqual(actions.map(({action,elementId})=>[action,elementId]),[
    ['click','poster'],['read_element','details'],['click','details']
  ]);
});

test('a stale reported covering ID is retrieved once and never clicked or replayed', async (t) => {
  t.mock.method(console,'info',()=>{});
  const actions = [];
  const result = await runAssistant({text:'go to rick and morty season 3 episode 2',
    env:{provider:'groq',model:'openai/gpt-oss-120b',key:'fixture-key'},
    host:{
      observe:async()=>frame(actions.length ? [] : [poster]),
      execute:async action => {
        actions.push(action);
        if (action.elementId === 'poster') return {ok:false,pageId:'results:1',errorClass:'covered_target',
          notDispatched:true,blockingElements:[{...details,sameDestination:true}]};
        assert.equal(action.action,'read_element');
        assert.equal(action.elementId,'details');
        return {ok:false,detail:'STALE_ELEMENT: observe the current page again'};
      }
    },
    modelClient:async()=>({json:{action:{action:'finish',success:false,say:'The result needs inspection.'}}})
  });
  assert.equal(result.ok,false);
  assert.deepEqual(actions.map(({action,elementId})=>[action,elementId]),[
    ['click','poster'],['read_element','details']
  ]);
});
