import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_RESPONSE_SCHEMA } from '../jester-extension/src/common/agent-response-schema.js';
import { validateTurn } from '../jester-extension/src/background/assistant.js';
import { COMMAND_IDS } from '../jester-extension/src/common/agent-actions.js';

// Evaluate the documented subset used by the request schema without adding a
// production dependency. Host validation additionally checks strings/URLs/IDs.
function accepts(value, schema = AGENT_RESPONSE_SCHEMA) {
  if (schema.$ref) return accepts(value, AGENT_RESPONSE_SCHEMA.$defs[schema.$ref.split('/').at(-1)]);
  if (schema.anyOf && !schema.anyOf.some((part) => accepts(value, part))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((schema.required || []).some((key) => !Object.hasOwn(value,key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties,key))) return false;
    return Object.entries(schema.properties).every(([key, part]) => !Object.hasOwn(value,key) || accepts(value[key],part));
  }
  if (schema.type === 'array') return Array.isArray(value) &&
    value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) &&
    value.every((item) => accepts(item,schema.items));
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) return false;
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (['string','boolean'].includes(schema.type) && typeof value !== schema.type) return false;
  return (schema.minimum === undefined || value >= schema.minimum) &&
    (schema.maximum === undefined || value <= schema.maximum);
}

test('Gemini action schema admits supported actions, optional bounded memory and existing-control groups', () => {
  const target = {elementId:'page.1'};
  const cases = [
    ...['click','focus','clear','hover','read_element','read_nearby','get_table'].map(action => ({action,...target})),
    {action:'type',...target,text:'Rick and Morty'}, {action:'select',...target,value:'3'},
    {action:'scroll',direction:'down',amount:1}, {action:'press_key',...target,key:'Enter'},
    {action:'find_text',query:'Season 3'}, {action:'find_elements',query:'Episodes'},
    {action:'get_form_fields'}, {action:'inspect_section',...target,query:'Season'},
    {action:'observe'}, {action:'wait',ms:100}, {action:'navigate',url:'https://www.hulu.com/search'},
    ...COMMAND_IDS.map(actionId => ({action:'command',actionId})),
    {action:'finish',success:true,say:'Playing the requested episode.'}
  ];
  for (const action of cases) {
    const response = {action,memory:{subgoal:'Select the requested season',facts:['Show page open']}};
    assert.equal(accepts(response),true,JSON.stringify(response));
    assert.doesNotThrow(() => validateTurn(response));
  }
  const group = {actions:[{action:'type',...target,text:'Rick and Morty'},{action:'press_key',...target,key:'Enter'}]};
  assert.equal(accepts(group),true);
  assert.doesNotThrow(() => validateTurn(group));
});

test('Gemini action schema rejects malformed actions and unsafe or mixed groups before execution', () => {
  const click = {action:'click',elementId:'page.1'};
  const invalid = [
    {action:'click'}, {action:{...click,selector:'#season'}}, {action:{...click,script:'alert(1)'}},
    {action:{action:'type',elementId:'page.1'}}, {action:{action:'select',elementId:'page.1',text:'3'}},
    {action:click,actions:[click]}, {actions:[]}, {actions:[click,click,click,click]},
    {actions:[{action:'finish',say:'Done',success:true}]}, {actions:[{action:'wait',ms:100}]},
    {action:{action:'press_key',key:'F12'}}, {action:click,memory:{goal:'Different goal'}},
    {action:click,memory:{facts:Array(11).fill('Fact')}}, {action:{action:'finish',say:'Done'}},
    {action:{action:'execute_js',code:'alert(1)'}}
  ];
  for (const response of invalid) {
    assert.equal(accepts(response),false,JSON.stringify(response));
    assert.throws(() => validateTurn(response));
  }
});

test('host checks remain authoritative for semantic IDs and navigation even with a response schema', () => {
  for (const response of [
    {action:{action:'click',elementId:'#selector'}},
    {action:{action:'navigate',url:'javascript:alert(1)'}},
    {action:{action:'type',elementId:'page.1',text:'x'.repeat(2001)}}
  ]) {
    assert.equal(accepts(response),true);
    assert.throws(() => validateTurn(response));
  }
  assert.ok(JSON.stringify(AGENT_RESPONSE_SCHEMA).length < 7000,'Keep schema overhead bounded');
});
