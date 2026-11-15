/**
 * What makes him quicker to answer (2026-11-14): a reply read as it's written, his first sentence said while the rest
 * comes, Claude asked plainly for a reply the prompt spells out, and each turn's time told in the log.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelRequest, normalizeModelConfig, requestModel, streams } from '../jester-extension/src/background/model-client.js';
import { askModel, createConversation, firstSaid } from '../desktop/src/main/conversation.js';
import { createSpeaker } from '../desktop/src/main/speaker.js';

const key = 'user-secret-api-key';
const claude = normalizeModelConfig({ provider: 'anthropic', key, model: 'claude-haiku-5-5' });
const ollama = normalizeModelConfig({ provider: 'ollama', model: 'qwen3.5:9b' });
const groq = normalizeModelConfig({ provider: 'groq', key, model: 'openai/gpt-oss-120b' });
const SCHEMA = { type: 'object', properties: { say: { type: 'string' } }, required: ['say'], additionalProperties: false };

/** A reply sent as server-sent events, in the pieces given: each a network chunk. */
const events = (chunks, status = 200) =>
  new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  }), { status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const claudeEvents = (pieces, { stop = 'end_turn' } = {}) => [
  `event: message_start\n${data({ type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 1900, output_tokens: 1 } } })}`,
  ...pieces.map((text) => `event: content_block_delta\n${data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`),
  ...(stop ? [`event: message_delta\n${data({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 31 } })}`, `event: message_stop\n${data({ type: 'message_stop' })}`] : [])
];

test('only the models whose replies are worth reading as they’re written are asked to send them so', () => {
  assert.equal(streams(claude), true);
  assert.equal(streams(ollama), true);
  assert.equal(streams(groq), false);
  const body = (config, options = {}) => JSON.parse(buildModelRequest(config, { system: 's', prompt: 'p', schema: SCHEMA, ...options }).init.body);
  assert.equal(body(claude).stream, undefined);
  assert.equal(body(claude, { stream: true }).stream, true);
  assert.deepEqual(body(ollama, { stream: true }).stream_options, { include_usage: true });
  assert.equal(body(groq, { stream: true }).stream, undefined);
});

test('asked plainly, Claude isn’t held to the schema; everyone else is asked as ever', () => {
  const body = (config, options = {}) => JSON.parse(buildModelRequest(config, { system: 's', prompt: 'p', schema: SCHEMA, ...options }).init.body);
  assert.deepEqual(body(claude).output_config.format, { type: 'json_schema', schema: SCHEMA });
  assert.deepEqual(body(claude, { plain: true }).output_config, { effort: 'low' });
  // A model on this computer needs the schema to write JSON at all.
  assert.equal(body(ollama, { plain: true }).response_format.type, 'json_schema');
});

test('Claude’s reply is read as it’s written: the text so far each time it grows, and the same result at the end', async () => {
  const heard = [];
  let sent;
  const result = await requestModel({
    config: claude, system: 's', prompt: 'p', schema: SCHEMA, onText: (text) => heard.push(text),
    // An event split across two network chunks is still one event.
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      const whole = claudeEvents(['{"say":"Good', ' evening. ', 'All quiet."}']).join('');
      return events([whole.slice(0, 150), whole.slice(150)]);
    }
  });
  assert.equal(sent.stream, true);
  assert.deepEqual(heard, ['{"say":"Good', '{"say":"Good evening. ', '{"say":"Good evening. All quiet."}']);
  assert.deepEqual(result.json, { say: 'Good evening. All quiet.' });
  // What it cost is still told: the cache's share from the start of the stream, the output from its end.
  assert.equal(result.usage.cache_read_input_tokens, 1900);
  assert.equal(result.usage.output_tokens, 31);
});

test('a model on this computer is read the same way, and one asked without onText isn’t streamed at all', async () => {
  const heard = [];
  const chunk = (content, extra = {}) => data({ choices: [{ delta: { content }, ...extra }] });
  const result = await requestModel({
    config: ollama, system: 's', prompt: 'p', schema: SCHEMA, onText: (text) => heard.push(text),
    fetchImpl: async () => events([chunk('{"say":"Hel'), chunk('lo."}'), data({ choices: [{ delta: {}, finish_reason: 'stop' }] }), data({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 6 } }), 'data: [DONE]\n\n'])
  });
  assert.deepEqual(heard, ['{"say":"Hel', '{"say":"Hello."}']);
  assert.deepEqual(result.json, { say: 'Hello.' });
  assert.equal(result.usage.completion_tokens, 6);

  let sent;
  await requestModel({ config: claude, system: 's', prompt: 'p', schema: SCHEMA, fetchImpl: async (_url, init) => ((sent = JSON.parse(init.body)), new Response(JSON.stringify({ content: [{ type: 'text', text: '{"say":"Hi."}' }] }), { headers: { 'content-type': 'application/json' } })) });
  assert.equal(sent.stream, undefined);
  // Groq sends it all at once either way, so it's asked as it always was, and onText simply never hears.
  const quiet = [];
  await requestModel({ config: groq, system: 's', prompt: 'p', schema: SCHEMA, onText: (text) => quiet.push(text), fetchImpl: async (_url, init) => ((sent = JSON.parse(init.body)), new Response(JSON.stringify({ choices: [{ message: { content: '{"say":"Hi."}' } }] }), { headers: { 'content-type': 'application/json' } })) });
  assert.equal(sent.stream, undefined);
  assert.deepEqual(quiet, []);
});

test('a stream cut short, or one that says it failed, is the provider failing: never half a reply', async () => {
  const cut = await requestModel({ config: claude, system: 's', prompt: 'p', schema: SCHEMA, onText: () => undefined, maxRetries: 0, fetchImpl: async () => events(claudeEvents(['{"say":"Good'], { stop: null })) }).catch((err) => err);
  assert.equal(cut.code, 'provider_busy');
  const overloaded = await requestModel({ config: claude, system: 's', prompt: 'p', schema: SCHEMA, onText: () => undefined, maxRetries: 0, fetchImpl: async () => events([...claudeEvents(['{"say":"Good'], { stop: null }), `event: error\n${data({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}`]) }).catch((err) => err);
  assert.equal(overloaded.code, 'provider_busy');
  const broken = await requestModel({ config: claude, system: 's', prompt: 'p', schema: SCHEMA, onText: () => undefined, maxRetries: 0, fetchImpl: async () => events([`event: error\n${data({ type: 'error', error: { type: 'api_error', message: `Internal trouble with ${key}` } })}`]) }).catch((err) => err);
  assert.equal(broken.status, 500);
  assert.equal(broken.message.includes(key), false);
  // Cut off at the output limit is still that, as unstreamed.
  const long = await requestModel({ config: claude, system: 's', prompt: 'p', schema: SCHEMA, onText: () => undefined, fetchImpl: async () => events(claudeEvents(['{"say":"Good'], { stop: 'max_tokens' })) }).catch((err) => err);
  assert.equal(long.code, 'model_output_truncated');
  // A refusal before the stream starts is read as any other.
  const refused = await requestModel({ config: claude, system: 's', prompt: 'p', schema: SCHEMA, onText: () => undefined, fetchImpl: async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }), { status: 401, headers: { 'content-type': 'application/json' } }) }).catch((err) => err);
  assert.equal(refused.status, 401);
  // And a listener that throws costs the reply nothing.
  const fine = await requestModel({ config: claude, system: 's', prompt: 'p', schema: SCHEMA, onText: () => { throw new Error('mine'); }, fetchImpl: async () => events(claudeEvents(['{"say":"Hi."}'])) });
  assert.deepEqual(fine.json, { say: 'Hi.' });
});

test('asked plainly, a reply that isn’t JSON is asked for once more, held to the schema', async () => {
  const bodies = [];
  const result = await requestModel({
    config: claude, system: 's', prompt: 'p', schema: SCHEMA, plain: true, onText: () => undefined,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? events(claudeEvents(['Sure! Here you go: {"say":"Hi."}'])) : new Response(JSON.stringify({ content: [{ type: 'text', text: '{"say":"Hi."}' }] }), { headers: { 'content-type': 'application/json' } });
    }
  });
  assert.deepEqual(result.json, { say: 'Hi.' });
  assert.equal(bodies[0].output_config.format, undefined);
  assert.deepEqual(bodies[1].output_config.format, { type: 'json_schema', schema: SCHEMA });
  // The second asking isn't read as it's written: his first sentence is only ever begun once.
  assert.equal(bodies[1].stream, undefined);
  // Any other failure is told as it is, once.
  let asked = 0;
  const failed = await requestModel({ config: claude, system: 's', prompt: 'p', schema: SCHEMA, plain: true, maxRetries: 0, fetchImpl: async () => ((asked += 1), new Response('{"error":{"message":"no"}}', { status: 500, headers: { 'content-type': 'application/json' } })) }).catch((err) => err);
  assert.equal(failed.status, 500);
  assert.equal(asked, 1);
});

test('his first sentence is known as soon as it’s written, and no sooner', () => {
  assert.equal(firstSaid(''), null);
  assert.equal(firstSaid('{"say":"Dynamic programming is a way of solving'), null);
  // The sentence is over once what follows it has begun.
  assert.equal(firstSaid('{"say":"Dynamic programming breaks a problem down.'), null);
  assert.deepEqual(firstSaid('{"say":"Dynamic programming breaks a problem down. You'), { text: 'Dynamic programming breaks a problem down.', whole: false });
  // All of it, when that's all there is.
  assert.deepEqual(firstSaid('{"say":"On it.","do":"play'), { text: 'On it.', whole: true });
  assert.deepEqual(firstSaid('{ "say" : "Why did the scarecrow win an award? Because'), { text: 'Why did the scarecrow win an award?', whole: false });
  // A word or two is no head start: it waits for the next sentence.
  assert.deepEqual(firstSaid('{"say":"Sure. It’s at ten in 100 Thomas. Then'), { text: 'Sure. It’s at ten in 100 Thomas.', whole: false });
  // A full stop that ends nothing: a title, an initial, a time, a number.
  assert.equal(firstSaid('{"say":"You’re seeing Dr. Patel at 3 p.m. tomorrow'), null);
  assert.deepEqual(firstSaid('{"say":"You’re seeing Dr. Patel at 3 p.m. tomorrow. Bring'), { text: 'You’re seeing Dr. Patel at 3 p.m. tomorrow.', whole: false });
  // Escapes are read as JSON reads them, and one half written is waited for.
  assert.equal(firstSaid('{"say":"She said \\'), null);
  assert.deepEqual(firstSaid('{"say":"She said \\"go ahead\\" twice. Then'), { text: 'She said "go ahead" twice.', whole: false });
  assert.deepEqual(firstSaid('{"say":"It\\u2019s nearly midnight. Sleep'), { text: 'It’s nearly midnight.', whole: false });
  // In a fence, as a model asked plainly may write it.
  assert.deepEqual(firstSaid('```json\n{"say":"All done here.","do":""'), { text: 'All done here.', whole: true });
  // "say" not first: he waits for the whole reply, as he always did.
  assert.equal(firstSaid('{"do":"","say":"Hello there, how are you. Fine'), null);
  assert.equal(firstSaid('Sure! {"say":"Hello there, how are you. Fine'), null);
});

test('the talking model is asked plainly, and read as it’s written only when someone’s waiting to speak', async () => {
  const asked = [];
  const request = async (options) => {
    asked.push(options);
    options.onText?.('{"say":"Good evening to you. All');
    options.onText?.('{"say":"Good evening to you. All quiet. Nothing');
    return { json: { say: 'Good evening to you. All quiet. Nothing on tonight.', do: '', new: false } };
  };
  const firsts = [];
  const reply = await askModel({ request, text: 'how are things', history: [], onFirst: (sentence, whole) => firsts.push([sentence, whole]) });
  assert.equal(asked[0].plain, true);
  // Once: what he's begun saying is never begun again.
  assert.deepEqual(firsts, [['Good evening to you.', false]]);
  assert.equal(reply.say, 'Good evening to you. All quiet. Nothing on tonight.');
  await askModel({ request, text: 'how are things', history: [] });
  assert.equal(asked[1].onText, undefined);
});

/** A conversation whose model writes its reply in pieces, a moment apart, and whose speaker says when it spoke. */
function talking({ pieces, reply, fail = null, speakMs = 5 }) {
  const said = [];
  const prepared = [];
  const lines = [];
  const logged = [];
  const shown = [];
  let time = 1_000_000;
  const tick = (ms) => new Promise((resolve) => setTimeout(() => ((time += ms), resolve()), 1));
  const conversation = createConversation({
    chat: async ({ onFirst }) => {
      let raw = '';
      let told = false;
      for (const piece of pieces) {
        await tick(100);
        raw += piece;
        const first = firstSaid(raw);
        if (onFirst && first && !told) {
          told = true;
          onFirst(first.text, first.whole);
        }
      }
      await tick(100);
      if (fail) throw fail;
      return reply;
    },
    speaker: {
      say: async (line, { onSound } = {}) => {
        onSound?.();
        said.push({ line, at: time });
        await new Promise((resolve) => setTimeout(resolve, speakMs));
      },
      prepare: (line) => prepared.push(line),
      stop: () => undefined
    },
    memory: { add: (who, text) => lines.push([who, text]), current: () => [], idleFor: () => 0, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
    assistant: { asking: false, running: false },
    show: (frame) => shown.push(frame),
    log: (...parts) => logged.push(parts.join(' ')),
    now: () => time
  });
  return { conversation, said, prepared, lines, logged, shown };
}

test('he starts on his first sentence while the rest is still being written, and it’s one line in the conversation', async () => {
  const whole = 'Dynamic programming breaks a problem down. You solve each piece once and keep the answer.';
  const { conversation, said, prepared, lines, logged, shown } = talking({
    pieces: ['{"say":"Dynamic programming ', 'breaks a problem down. You ', 'solve each piece once ', 'and keep the answer.","do":"","new":false}'],
    reply: { say: whole, do: '', new: false }
  });
  await conversation.told('explain dynamic programming');
  assert.deepEqual(said.map((entry) => entry.line), ['Dynamic programming breaks a problem down.', 'You solve each piece once and keep the answer.']);
  // Begun at the second piece (200 ms in), not after the fifth (500 ms).
  assert.equal(said[0].at, 1_000_200);
  // The rest's sound was fetched while the first sentence played.
  assert.deepEqual(prepared, ['You solve each piece once and keep the answer.']);
  assert.deepEqual(lines, [['you', 'explain dynamic programming'], ['jester', whole]]);
  // The pill ends up showing all of it, and says he's done once, after the lot.
  assert.equal(shown.filter((frame) => frame.phase === 'speaking' && frame.done).length, 1);
  assert.equal(shown.filter((frame) => frame.phase === 'speaking' && frame.text).at(-1).text, whole);
  // Where the time went, once.
  const turns = logged.filter((line) => line.startsWith('turn:'));
  assert.equal(turns.length, 1);
  assert.match(turns[0], /first sentence at 200 ms · reply at 500 ms · speaking at 200 ms/);
});

test('one sentence is said once, and a reply that came whole is said as it always was', async () => {
  const short = talking({ pieces: ['{"say":"Doing well, thanks for asking.","do":"","new":false}'], reply: { say: 'Doing well, thanks for asking.', do: '', new: false } });
  await short.conversation.told('how are you');
  assert.deepEqual(short.said.map((entry) => entry.line), ['Doing well, thanks for asking.']);
  assert.deepEqual(short.prepared, []);
  assert.deepEqual(short.lines.at(-1), ['jester', 'Doing well, thanks for asking.']);
  // A model that doesn't send its reply as it writes it: nothing's begun early.
  const whole = talking({ pieces: [], reply: { say: 'First things first. Then the rest.', do: '', new: false } });
  await whole.conversation.told('what now');
  assert.deepEqual(whole.said.map((entry) => entry.line), ['First things first. Then the rest.']);
  assert.match(whole.logged.find((line) => line.startsWith('turn:')), /reply at 100 ms · speaking at 100 ms/);
});

test('typed to, asked for a note or to remember, or about to claim a note, he waits for the whole reply', async () => {
  const pieces = ['{"say":"Here is the first part of it. And ', 'here is the second.","do":"","new":false}'];
  const reply = { say: 'Here is the first part of it. And here is the second.', do: '', new: false };
  // Typed: written, whole.
  const typed = talking({ pieces, reply });
  await typed.conversation.told('tell me the two parts', { typed: true });
  assert.deepEqual(typed.said, []);
  assert.deepEqual(typed.lines.at(-1), ['jester', reply.say]);
  // What he says of a note or of remembering is how that went, which isn't known until the reply's whole.
  for (const asking of ['add milk to my shopping list', 'remember that my locker is 114']) {
    const waited = talking({ pieces, reply });
    await waited.conversation.told(asking);
    assert.equal(waited.said.some((entry) => entry.line === 'Here is the first part of it.'), false, asking);
  }
  // A first sentence about a note nobody asked for is never begun: the turn may yet say "Got it." instead.
  const noting = talking({ pieces: ['{"say":"I’ve made a note of that for you. Anything ', 'else?","do":"","new":false}'], reply: { say: 'I’ve made a note of that for you. Anything else?', do: '', new: false, note: { title: 'Parking', add: 'level 3', open: false } } });
  await noting.conversation.told('I parked on level 3 today');
  assert.deepEqual(noting.said.map((entry) => entry.line), ['Got it.']);
});

test('a first sentence that only mentions notes is begun on: it claims nothing', async () => {
  const whole = 'Start by redoing old problems and take notes on what trips you up. Then time yourself.';
  const { conversation, said } = talking({ pieces: ['{"say":"Start by redoing old problems and take notes on what trips you up. Then ', 'time yourself.","do":"","new":false}'], reply: { say: whole, do: '', new: false } });
  await conversation.told('how should I study for my midterm');
  assert.deepEqual(said.map((entry) => entry.line), ['Start by redoing old problems and take notes on what trips you up.', 'Then time yourself.']);
  assert.equal(said[0].at, 1_000_100);
});

test('a reply that fails after he’s begun: what he said stays said, and then why', async () => {
  const { conversation, said, lines } = talking({ pieces: ['{"say":"Let me think about that one. It '], reply: null, fail: new Error('The model stopped answering.') });
  await conversation.told('what should I do this weekend');
  assert.deepEqual(said.map((entry) => entry.line), ['Let me think about that one.', 'The model stopped answering.']);
  assert.deepEqual(lines.slice(1), [['jester', 'Let me think about that one.'], ['jester', 'The model stopped answering.']]);
});

test('a turn that ends up saying something else says it after what he’d begun, never the same thing twice', async () => {
  const { conversation, said, lines } = talking({ pieces: ['{"say":"Let me get that going for you. One '], reply: { say: 'Opening it now.', do: '', new: false } });
  await conversation.told('get the thing going');
  assert.deepEqual(said.map((entry) => entry.line), ['Let me get that going for you.', 'Opening it now.']);
  assert.deepEqual(lines.at(-1), ['jester', 'Let me get that going for you. Opening it now.']);
});

test('his name heard, what a turn waits on is got ready; and a turn says how long after the last word it began', async () => {
  let warmed = 0;
  const logged = [];
  const conversation = createConversation({
    chat: async () => ({ say: 'Evening.', do: '', new: false }),
    speaker: { say: async (_line, { onSound } = {}) => onSound?.(), stop: () => undefined },
    memory: { add: () => undefined, current: () => [], idleFor: () => 0, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    commands: { knows: async () => false, risky: async () => false, run: async () => ({ outcome: null }) },
    assistant: { asking: false, running: false },
    show: () => undefined,
    warm: () => (warmed += 1),
    log: (...parts) => logged.push(parts.join(' '))
  });
  conversation.woken();
  assert.equal(warmed, 1);
  await conversation.heard('Jester, good evening', { lag: 684 });
  assert.match(logged.find((line) => line.startsWith('turn:')), /^turn: heard 684 ms after the last word · /);
});

test('the voice says when its sound starts, and a line prepared ahead is fetched once and played without a wait', async () => {
  const fetched = [];
  const played = [];
  const order = [];
  const speaker = createSpeaker({
    token: async () => 'token',
    synthesize: async (text) => {
      fetched.push(text);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { bytes: new Uint8Array([text.length]), type: 'audio/mpeg' };
    },
    play: async (bytes) => {
      order.push('play');
      played.push(bytes[0]);
    },
    stopPlaying: () => undefined,
    system: { say: async () => order.push('system'), stop: () => undefined }
  });
  await speaker.say('First.', { onSound: () => order.push('sound') });
  assert.deepEqual(order, ['sound', 'play']);
  speaker.prepare('Second sentence.');
  await speaker.say('Second sentence.');
  assert.deepEqual(fetched, ['First.', 'Second sentence.']);
  assert.deepEqual(played, [6, 16]);
  // Prepared, then something else is said instead: the prepared one is dropped, not played later.
  speaker.prepare('Never said.');
  await speaker.say('Something else.');
  await speaker.say('Never said.');
  assert.deepEqual(fetched.filter((text) => text === 'Never said.').length, 2);
  // With no Puter, the computer's own voice still reports its start, once.
  const starts = [];
  const plain = createSpeaker({ token: async () => null, synthesize: async () => null, play: async () => undefined, stopPlaying: () => undefined, system: { say: async () => undefined, stop: () => undefined } });
  await plain.say('Hello.', { onSound: () => starts.push(1) });
  assert.deepEqual(starts, [1]);
});

/** What he knows of it is in (a moment's work, with nothing to recall here), and his model's been asked. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** A conversation that may think ahead, whose model takes 300 ms and says what it was asked, and when. */
function pausing({ thinkAhead = () => true, knows = async () => false } = {}) {
  let time = 1_000_000;
  const asked = [];
  const said = [];
  const lines = [];
  const shown = [];
  const logged = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(() => ((time += ms), resolve()), 2));
  const conversation = createConversation({
    chat: async ({ text, signal }) => {
      const call = { text, at: time, signal };
      asked.push(call);
      await wait(300);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      return { say: `You said ${text}.`, do: '', new: false };
    },
    speaker: { say: async (line, { onSound } = {}) => (onSound?.(), said.push({ line, at: time })), stop: () => undefined },
    memory: { add: (who, text) => lines.push([who, text]), current: () => [], idleFor: () => 0, startNew: () => [] },
    recollections: { keep: async () => undefined, relevant: () => [] },
    commands: { knows, risky: async () => false, run: async () => ({ outcome: { ok: true, text: 'Done.' } }) },
    assistant: { asking: false, running: false },
    show: (frame) => shown.push(frame),
    thinkAhead,
    log: (...parts) => logged.push(parts.join(' ')),
    now: () => time
  });
  return { conversation, asked, said, lines, shown, logged, wait, pass: (ms) => (time += ms) };
}

test('at a pause that may be the end, his reply is begun; heard whole, those words carry on from there', async () => {
  const { conversation, asked, said, lines, shown, logged, pass } = pausing();
  await conversation.paused('Jester, how are things');
  await settled();
  // Thought about, and nothing more: not said, shown or kept.
  assert.deepEqual(asked.map((call) => call.text), ['how are things']);
  assert.deepEqual([said, lines, shown], [[], [], []]);
  // The pause lasted: 300 ms on, the utterance is over.
  pass(300);
  await conversation.heard('Jester, how are things', { lag: 600 });
  // Asked once, and the reply is the one begun at the pause.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].signal.aborted, false);
  assert.deepEqual(said.map((entry) => entry.line), ['You said how are things.']);
  assert.deepEqual(lines, [['you', 'how are things'], ['jester', 'You said how are things.']]);
  assert.match(logged.find((line) => line.startsWith('turn:')), /^turn: heard 600 ms after the last word · thinking since 300 ms before that · /);
});

test('they went on talking: what was begun is called off, and the whole of it is asked afresh', async () => {
  const { conversation, asked, said, lines } = pausing();
  await conversation.paused('Jester, what’s the weather');
  await settled();
  conversation.wentOn();
  assert.equal(asked[0].signal.aborted, true);
  await conversation.heard('Jester, what’s the weather in Boston on Friday');
  assert.deepEqual(asked.map((call) => call.text), ['what’s the weather', 'what’s the weather in Boston on Friday']);
  assert.deepEqual(said.map((entry) => entry.line), ['You said what’s the weather in Boston on Friday.']);
  assert.equal(lines.filter(([who]) => who === 'jester').length, 1);
  // Other words than the pause's, with no word that they went on: the same.
  const other = pausing();
  await other.conversation.paused('Jester, tell me a joke');
  await settled();
  await other.conversation.heard('Jester, tell me a joke about cats');
  assert.equal(other.asked[0].signal.aborted, true);
  assert.deepEqual(other.said.map((entry) => entry.line), ['You said tell me a joke about cats.']);
});

test('he thinks ahead only where it’s allowed, only on what’s said to him, and never on a command', async () => {
  // Not allowed (the default: a free plan, or a model on this computer): a pause is nothing.
  const off = pausing({ thinkAhead: () => false });
  await off.conversation.paused('Jester, how are things');
  await settled();
  assert.equal(off.asked.length, 0);
  await off.conversation.heard('Jester, how are things');
  assert.equal(off.asked.length, 1);
  // Without his name, and with nothing he's waiting to hear: it isn't for him.
  const aside = pausing();
  await aside.conversation.paused('how are things with you lately');
  await settled();
  assert.equal(aside.asked.length, 0);
  // Only maybe their voice, it counts with his name, as it does heard whole.
  const maybe = pausing();
  await maybe.conversation.paused('how are things', { unsure: true });
  await settled();
  assert.equal(maybe.asked.length, 0);
  await maybe.conversation.paused('Jester, how are things', { unsure: true });
  await settled();
  assert.equal(maybe.asked.length, 1);
  // A command is the laptop's: nothing of it is begun at a pause, and it's done once, when it's heard whole.
  const command = pausing({ knows: async () => true });
  await command.conversation.paused('Jester, open Spotify');
  await settled();
  assert.equal(command.asked.length, 0);
  assert.deepEqual(command.said, []);
});

test('a reply begun at a pause that’s never followed up is dropped, and so is one when listening ends', async () => {
  const { conversation, asked } = pausing();
  await conversation.paused('Jester, how are things');
  await settled();
  conversation.reset();
  assert.equal(asked[0].signal.aborted, true);
  // Typed meanwhile, the typed words are their own turn: the pause's reply isn't theirs.
  const typed = pausing();
  await typed.conversation.paused('Jester, how are things');
  await settled();
  await typed.conversation.told('how are things', { typed: true });
  assert.equal(typed.asked.length, 2);
  assert.equal(typed.asked[0].signal.aborted, true);
});
