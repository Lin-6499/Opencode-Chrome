import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized, isExtensionOrigin } from '../auth.mjs';

test('token comparison rejects empty, missing, wrong, and differently sized values', () => {
  assert.equal(isAuthorized('abc', 'abc'), true);
  for (const value of ['', undefined, null, 'ab', 'abd', 'abcd']) assert.equal(isAuthorized(value, 'abc'), false);
  assert.equal(isAuthorized('', ''), false);
});
test('only valid Chrome extension origins may open the control connection', () => {
  assert.equal(isExtensionOrigin(`chrome-extension://${'a'.repeat(32)}`), true);
  for (const origin of [undefined, 'null', 'https://example.com', 'http://127.0.0.1:17891', 'chrome-extension://abc', `chrome-extension://${'z'.repeat(32)}`]) assert.equal(isExtensionOrigin(origin), false);
});
