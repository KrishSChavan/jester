import test from 'node:test';
import assert from 'node:assert/strict';
import { sameWords, wer, words } from '../desktop/src/main/speech/words.js';

test('words ignore case and punctuation and spell numbers out', () => {
  assert.deepEqual(words('Set the volume to 30%.'), ['set', 'the', 'volume', 'to', 'thirty', 'percent']);
  assert.deepEqual(words("MrBeast's latest video!"), ['mrbeasts', 'latest', 'video']);
  assert.deepEqual(words('Press Command-Shift-4'), ['press', 'command', 'shift', 'four']);
  assert.deepEqual(words('season 3 episode 21'), ['season', 'three', 'episode', 'twenty', 'one']);
});

test('word error rate counts substitutions, insertions and deletions', () => {
  assert.equal(wer('pause the music', 'Pause the music.'), 0);
  assert.equal(wer('pause the music', 'cause the music'), 1 / 3);
  assert.equal(wer('lock the screen', 'the screen'), 1 / 3);
  assert.equal(wer('mute', ''), 1);
  assert.equal(wer('', 'something'), 1);
  assert.equal(wer('', ''), 0);
});

test('spacing differences are not errors when comparing commands', () => {
  assert.equal(sameWords('search for lo-fi beats', 'Search for lofi beats.'), true);
  assert.equal(sameWords("show me MrBeast's latest video", 'Show me Mr. Beasts latest video'), true);
  assert.equal(sameWords('lock the screen', 'the screen'), false);
});

test('the speech model: the one chosen if downloaded, else the most accurate that is', async () => {
  const { pickModel } = await import('../desktop/src/main/speech/models.js');
  const only = (...ids) => (id) => ids.includes(id);
  assert.equal(pickModel(undefined, only('parakeet-110m', 'parakeet-0.6b')), 'parakeet-0.6b');
  assert.equal(pickModel('parakeet-110m', only('parakeet-110m', 'parakeet-0.6b')), 'parakeet-110m');
  assert.equal(pickModel('parakeet-0.6b', only('parakeet-110m')), 'parakeet-110m', 'a choice that isn\'t downloaded falls back');
  assert.equal(pickModel('kroko', only('parakeet-110m')), 'parakeet-110m', 'only the offered models');
  assert.equal(pickModel(undefined, only()), null);
});
