import test from 'node:test';
import assert from 'node:assert/strict';
import { personaPrompt } from '../desktop/src/main/conversation.js';
import { ago, createVaultMemory } from '../desktop/src/main/vault-memory.js';

// 2026-11-13, 9:07 PM: a summary kept the afternoon before, "…advised attending the upcoming class", reached Groq's
// gpt-oss-120b as "- Thursday at 2:18 PM: …" and came back as "You have a class starting in about an hour".
const NOW = new Date('2026-11-13T21:07:00');

test('how long ago a day was, by the calendar and not the clock', () => {
  const at = (text) => new Date(text);
  assert.equal(ago(at('2026-11-13T00:05:00'), NOW), 'today');
  assert.equal(ago(at('2026-11-12T23:59:00'), NOW), 'yesterday', 'an hour and a bit before midnight is still the day before');
  assert.equal(ago(at('2026-11-12T14:18:00'), NOW), 'yesterday');
  assert.equal(ago(at('2026-11-10T09:00:00'), NOW), '3 days ago');
  assert.equal(ago(at('2026-10-31T09:00:00'), NOW), '13 days ago');
  assert.equal(ago(at('2026-10-30T09:00:00'), NOW), '2 weeks ago');
  assert.equal(ago(at('2026-09-01T09:00:00'), NOW), '2 months ago');
  assert.equal(ago(at('2025-11-13T09:00:00'), NOW), 'a year ago');
  assert.equal(ago(at('2023-11-13T09:00:00'), NOW), '3 years ago');
  // A clock that's wrong, or a note dated ahead: never "in 2 days".
  assert.equal(ago(at('2026-11-15T09:00:00'), NOW), 'today');
  assert.equal(ago(at('2026-11-12T14:18:00').getTime(), NOW.getTime()), 'yesterday', 'milliseconds do as well as dates');
});

test('an earlier conversation says how old it is, and that what it called upcoming has likely happened', () => {
  const prompt = personaPrompt(NOW, [
    { at: new Date('2026-11-12T14:18:00').getTime(), summary: 'Provided current weather, time, and advised attending the upcoming class.' },
    { at: new Date('2026-11-10T12:12:00').getTime(), summary: 'Asked to open the PSU Canvas bookmark.' },
    { at: new Date('2026-11-13T20:07:00').getTime(), summary: 'Planned a trip.' }
  ]);
  assert.match(prompt, /^- Yesterday \(Thursday\) at 2:18.PM: Provided current weather/m);
  assert.match(prompt, /^- 3 days ago \(Tuesday\) at 12:12.PM: Asked to open/m);
  assert.match(prompt, /^- Today at 8:07.PM: Planned a trip\.$/m);
  // Not the weekday alone, which reads as well for the one coming.
  assert.doesNotMatch(prompt, /^- Thursday at/m);
  assert.match(prompt, /What one calls "upcoming", "soon" or "tomorrow" was so when it was said, which is how long ago its line says: by now it has most likely happened\./);
});

test('a conversation is summed up in the past tense, with when things were by date or clock', async () => {
  const calls = [];
  const memory = createVaultMemory({
    vault: () => null,
    index: { search: async () => [] },
    request: async (options) => (calls.push(options), { json: { title: 'A class', summary: 'The user had a class at 3 PM on Thursday, November 12.', topics: [], people: [], facts: { add: [], remove: [] } } }),
    now: () => new Date('2026-11-12T14:18:00').getTime()
  });
  const { summary } = await memory.ended([
    { who: 'you', text: 'what time is it? I have class in about an hour', at: '2026-11-12T14:17:00' },
    { who: 'jester', text: 'It’s 2:17. Better get moving.', at: '2026-11-12T14:17:05' }
  ]);
  assert.equal(summary, 'The user had a class at 3 PM on Thursday, November 12.');
  const system = calls[0].system;
  assert.match(system, /It began on Thursday, November 12, 2026 at 2:17 PM\./);
  assert.match(system, /\n"summary": [^\n]*It will be read on another day, so write it in the past tense, and say when a thing was by its date or its time on the clock: never "upcoming", "soon", "later", "in an hour", "today", "tonight" or "tomorrow", not even to repeat what was said\./);
});
