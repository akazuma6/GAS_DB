'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

test('auth: issueApiKey_ で発行したキーはvalidateApiKey_を通る', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('client-a');
  assert.strictEqual(sb.validateApiKey_(key), 'client-a');
});

test('auth: 不正なキーはAUTH_FAILED', () => {
  const sb = createInitializedSandbox();
  sb.issueApiKey_('client-a');
  assert.throws(
    () => sb.validateApiKey_('wrong-key'),
    (err) => err instanceof sb.SqlError && err.code === 'AUTH_FAILED'
  );
});

test('auth: キー未指定はAUTH_REQUIRED', () => {
  const sb = createInitializedSandbox();
  assert.throws(
    () => sb.validateApiKey_(null),
    (err) => err instanceof sb.SqlError && err.code === 'AUTH_REQUIRED'
  );
  assert.throws(
    () => sb.validateApiKey_(''),
    (err) => err instanceof sb.SqlError && err.code === 'AUTH_REQUIRED'
  );
});

test('auth: revokeApiKey_ 後は無効化される', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('client-a');
  sb.revokeApiKey_('client-a');
  assert.throws(
    () => sb.validateApiKey_(key),
    (err) => err instanceof sb.SqlError && err.code === 'AUTH_FAILED'
  );
});

test('auth: 複数クライアントを個別に発行・識別できる', () => {
  const sb = createInitializedSandbox();
  const keyA = sb.issueApiKey_('client-a');
  const keyB = sb.issueApiKey_('client-b');
  assert.strictEqual(sb.validateApiKey_(keyA), 'client-a');
  assert.strictEqual(sb.validateApiKey_(keyB), 'client-b');
});
