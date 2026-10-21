import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_BOUNDARIES, webPage, requiresConfirmation } from '../jester-extension/src/common/agent-permissions.js';

test('a task may use any ordinary web page, on any site, and never Chrome pages, files or scripts', () => {
  for (const url of ['https://www.netflix.com/watch/123', 'https://mail.google.com/mail/u/0/', 'http://localhost:3000/',
    'https://www.netflix.com.evil.example/watch']) assert.equal(webPage(url), true, url);
  for (const url of ['javascript:alert(1)', 'file:///tmp/page', 'chrome://settings', 'chrome-extension://abc/x.html',
    'data:text/html,hi', 'invalid-url', '', undefined]) assert.equal(webPage(url), false, String(url));
});

test('invalid or inherited permission policies never authorize any action', () => {
  for (const policy of ['unexpected', '__proto__', 'constructor', '', null]) {
    for (const category of ['read', 'browse', 'sensitive', undefined]) {
      assert.equal(requiresConfirmation(policy, category), true);
    }
  }
});

test('confirmation policy distinguishes read-only, entertainment, and sensitive operations', () => {
  for (const boundary of Object.keys(PERMISSION_BOUNDARIES)) assert.equal(requiresConfirmation(boundary, 'read'), false);
  assert.equal(requiresConfirmation('ask', 'browse'), true);
  assert.equal(requiresConfirmation('ask', 'sensitive'), true);
  assert.equal(requiresConfirmation('entertainment', 'browse'), false);
  assert.equal(requiresConfirmation('entertainment', 'sensitive'), true);
  assert.equal(requiresConfirmation('site', 'browse'), false);
  assert.equal(requiresConfirmation('site', 'sensitive'), false);
});

test('missing or unknown classification never gains automatic action permission', () => {
  for (const category of [undefined, null, 'unclassified', '__proto__', 'constructor']) {
    for (const boundary of Object.keys(PERMISSION_BOUNDARIES)) {
      assert.equal(requiresConfirmation(boundary, category), true, `${boundary} must confirm ${category}`);
    }
  }
});
