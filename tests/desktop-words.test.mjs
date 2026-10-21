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
