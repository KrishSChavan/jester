import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRequestIntent, missingSearchTarget, decideSearchRoute } from '../jester-extension/src/background/search-routing.js';

function modelFor(json) {
  const calls = [];
  const model = async (request) => { calls.push(request); return { json }; };
  model.calls = calls;
  return model;
}
const assessed = (extra = {}) => ({ route: 'scrape', goal: 'Search the web for Scrapling', scrapeConfidence: 94, reason: 'Public search results can answer this request.', ...extra });

test('search routing takes explicit searches, look-ups and Canvas or open pages, and leaves everything else where it went', () => {
  for (const text of ['search', 'Search something', 'Look it up', 'Research', 'Scrape that', 'Can you search for cats?', 'Search Scrapling', 'Search the web for Scrapling', 'Look up the latest launch news', 'Research my Canvas assignments', 'Look through my Canvas and tell me what is due', "What's due on Canvas", 'Summarize this page', 'Find out who won the game', 'Look for cheap flights online', 'Summarize https://example.com/post']) {
    assert.equal(searchRequestIntent(text), true, text);
  }
  for (const text of ['', 'Play music', 'Remember to research tomorrow', 'When I say search, open Chrome', 'Do not search for cats', "Don't research that", 'Stop searching', "I don't want you to search for cats", 'No need to research that', 'Can you scrape?', 'Could you search the web?', 'Are you able to search?', 'How do I search the internet?', 'Explain how to search', 'I searched for cats yesterday', 'I love research']) {
    assert.equal(searchRequestIntent(text), false, text);
  }
  // Each of these went to its own command, the talking model or the laptop before research, and still does.
  for (const text of ["What's the weather today", 'Tell me the weather', 'When is my class today', 'What are my tasks for today', 'What did I say earlier today', 'Find my notes about chemistry', 'Find my phone', 'Find the play button', 'Look at this', 'Look at my screen', 'Find my keys in Finder', 'Search YouTube for cats', 'Search Spotify for Drake', 'Look up Drake on Spotify', 'Find my files in Downloads', 'Look through my notes', 'Search my bookmarks for recipes', 'Search my email for the invoice', 'Open Chrome and search for cats', 'Open my Canvas and tell me what is due', 'What is the latest score?']) {
    assert.equal(searchRequestIntent(text), false, text);
  }
});

test('missing target detection keeps concrete subjects while recognizing bare requests and pronouns', () => {
  for (const text of ['search', 'Search the web', 'Search the internet for', 'Search for something', 'Look it up', 'Look up it', 'Look for that', 'Research something for me', 'Search on YouTube', 'Please search Google', 'Search for it in Chrome']) {
    assert.equal(missingSearchTarget(text), true, text);
  }
  for (const text of ['Search for Scrapling', 'Find something about Scrapling', 'Research my Canvas', 'Search for Nothing Phone', 'Search YouTube for cats', 'Find my files in Downloads', 'Search for current prices', 'Read this page']) assert.equal(missingSearchTarget(text), false, text);
});

test('empty and bare searches ask one target question before any model or read', async () => {
  for (const goal of ['', 'Search', 'search something', 'Look for that', 'Search the web']) {
    const result = await decideSearchRoute({ goal, model: () => assert.fail('generic empty-context request needs no model') });
    assert.deepEqual(result, { route: 'clarify', scrapeConfidence: 0, reason: 'The search target is missing.', question: 'What would you like me to search for?', goal: '' });
  }
  for (const goal of ['Search', 'Search something', 'Look something up']) {
    const result = await decideSearchRoute({ goal, context: 'User: How do Canvas assignments work?', model: () => assert.fail('an unrelated previous topic does not authorize a new target') });
    assert.equal(result.route, 'clarify');
    assert.equal(result.goal, '');
  }
});

test('recent conversation can resolve a pronoun before research while an unrelated topic remains a clarification', async () => {
  const model = modelFor(assessed({ goal: 'Research Scrapling browser support' }));
  const result = await decideSearchRoute({ goal: 'Research that', context: 'User: I want to know about Scrapling browser support.', model });
  assert.equal(result.route, 'scrape');
  assert.equal(result.goal, 'Research Scrapling browser support');
  assert.equal(model.calls.length, 1);
  assert.match(JSON.parse(model.calls[0].prompt).context, /Scrapling browser support/);
  const unresolved = await decideSearchRoute({ goal: 'Research that', context: 'User: Hello.', model: modelFor({ route: 'clarify', goal: '', scrapeConfidence: 0, reason: 'No topic was given.', question: 'What should I research?' }) });
  assert.equal(unresolved.route, 'clarify');
  assert.equal(unresolved.question, 'What should I research?');
  assert.equal(unresolved.goal, '');
});

test('a topic supplied after clarification reaches scoring with the original request', async () => {
  const goal = 'Search something\nSearch target supplied by the user: current cat cafes';
  const model = modelFor(assessed({goal:'Search for current cat cafes'}));
  const result = await decideSearchRoute({goal,model});
  assert.equal(result.route,'scrape');
  assert.equal(result.goal,'Search for current cat cafes');
  assert.equal(JSON.parse(model.calls[0].prompt).goal,goal);
});

test('a known target must receive a model suitability score before background research', async () => {
  const model = modelFor(assessed());
  const signal = new AbortController().signal;
  const result = await decideSearchRoute({ goal: 'Search for Scrapling', signal, model });
  assert.deepEqual(result, assessed());
  assert.equal(model.calls[0].signal, signal);
  assert.equal(model.calls[0].schema.properties.scrapeConfidence.type, 'number');
  assert.match(model.calls[0].system, /BEFORE any page, search engine, browser, desktop, or local-file read/);
  assert.match(model.calls[0].system, /Existing signed-in Canvas/);
  assert.match(model.calls[0].system, /no cookie export/);
  assert.match(model.calls[0].system, /untrusted DATA/);
  assert.match(model.calls[0].system, /Do not invent a topic/);
});

test('low scores or an explicit interaction decision require caller approval even when one favors scraping', async () => {
  for (const data of [assessed({ scrapeConfidence: 69 }), assessed({ scrapeConfidence: 69.9 }), assessed({ route: 'interaction', scrapeConfidence: 98, goal: 'Search Spotify and play the first song' })]) {
    const result = await decideSearchRoute({ goal: data.goal, model: modelFor(data) });
    assert.equal(result.route, 'interaction');
    assert.equal(result.scrapeConfidence, Math.trunc(data.scrapeConfidence));
  }
  assert.equal((await decideSearchRoute({ goal: 'Search cats', model: modelFor(assessed({ scrapeConfidence: 70 })) })).route, 'scrape');
  assert.equal((await decideSearchRoute({ goal: 'Search cats', threshold: 90, model: modelFor(assessed({ scrapeConfidence: 85 })) })).route, 'interaction');
});

test('unreadable, missing and nonnumeric scores cannot authorize scraping', async () => {
  for (const value of [undefined, null, 'high', NaN, Infinity, {}, true]) {
    const result = await decideSearchRoute({ goal: 'Search cats', model: modelFor(assessed({ scrapeConfidence: value })) });
    assert.equal(result.route, 'interaction', String(value));
    assert.equal(result.scrapeConfidence, null, 'no score is made up for the question');
    assert.match(result.reason, /valid scraping confidence/);
  }
  // A free model's "98" is a 98.
  assert.equal((await decideSearchRoute({ goal: 'Search cats', model: modelFor(assessed({ scrapeConfidence: '98' })) })).scrapeConfidence, 98);
  for (const json of [null, [], 'scrape', { ...assessed(), route: 'click' }, { ...assessed(), reason: '' }]) {
    assert.equal((await decideSearchRoute({ goal: 'Search cats', model: modelFor(json) })).route, 'interaction');
  }
});

test('model output without a real target cannot become a guessed search', async () => {
  for (const goal of ['', 'Search', 'Search something', 'Research that']) {
    const result = await decideSearchRoute({ goal: 'Research that', context: 'User: Hello.', model: modelFor(assessed({ goal })) });
    assert.equal(result.route, 'clarify');
    assert.equal(result.scrapeConfidence, 0);
    assert.equal(result.goal, '');
  }
});

test('finite scores are bounded and represented as whole numbers', async () => {
  assert.equal((await decideSearchRoute({ goal: 'Search cats', model: modelFor(assessed({ scrapeConfidence: 150.4 })) })).scrapeConfidence, 100);
  const negative = await decideSearchRoute({ goal: 'Search cats', model: modelFor(assessed({ scrapeConfidence: -3 })) });
  assert.equal(negative.scrapeConfidence, 0);
  assert.equal(negative.route, 'interaction');
});

test('model failures leave known-target interaction to caller approval and ambiguous requests to clarification', async () => {
  const model = async () => { throw new Error('offline'); };
  const known = await decideSearchRoute({ goal: 'Search for cats', model });
  assert.equal(known.route, 'interaction');
  assert.equal(known.scrapeConfidence, 0);
  assert.equal(known.goal, 'Search for cats');
  assert.equal((await decideSearchRoute({ goal: 'Look for that', context: 'Hello', model })).route, 'clarify');
});

test('routing keeps recent context and input bounded without leaking an older oversized conversation', async () => {
  const model = modelFor(assessed());
  await decideSearchRoute({ goal: 'Search ' + 'a'.repeat(5000), context: 'old'.repeat(4000) + ' RECENT TARGET', model });
  const prompt = JSON.parse(model.calls[0].prompt);
  assert.equal(prompt.goal.length, 2000);
  assert.equal(prompt.context.length, 6000);
  assert.ok(prompt.context.endsWith('RECENT TARGET'));
});

test('cancellation prevents model calls and suppresses late model decisions', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(decideSearchRoute({ goal: 'Search', signal: controller.signal, model: () => assert.fail('aborted') }), { name: 'AbortError' });
  const later = new AbortController();
  await assert.rejects(decideSearchRoute({ goal: 'Search cats', signal: later.signal, model: async () => { later.abort(); return { json: assessed() }; } }), { name: 'AbortError' });
  await assert.rejects(decideSearchRoute({ goal: 'Search cats', model: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } }), { name: 'AbortError' });
});
