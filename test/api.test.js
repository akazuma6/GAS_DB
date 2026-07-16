'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

function post(sb, bodyObj) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(bodyObj) } })._text);
}
function get(sb, params) {
  return JSON.parse(sb.doGet({ parameter: params })._text);
}

function setup() {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1)');
  sb.executeSql_('INSERT INTO t (v) VALUES (2)');
  const key = sb.issueApiKey_('client-a');
  return { sb, key };
}

test('api: doPost 正常系(単一SQL)', () => {
  const { sb, key } = setup();
  const res = post(sb, { apiKey: key, sql: 'SELECT * FROM t' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.client, 'client-a');
  assert.strictEqual(res.result.rowCount, 2);
});

test('api: doPost 正常系(sqls配列でバッチ実行)', () => {
  const { sb, key } = setup();
  const res = post(sb, { apiKey: key, sqls: ["INSERT INTO t (v) VALUES (3)", 'SELECT COUNT(*) AS n FROM t'] });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.results.length, 2);
  assert.strictEqual(res.results[1].rows[0].n, 3);
});

test('api: doPost APIキー不正はsuccess:falseでAUTH_FAILED', () => {
  const { sb } = setup();
  const res = post(sb, { apiKey: 'wrong', sql: 'SELECT 1' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'AUTH_FAILED');
});

test('api: doPost APIキー未指定はAUTH_REQUIRED', () => {
  const { sb } = setup();
  const res = post(sb, { sql: 'SELECT 1' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'AUTH_REQUIRED');
});

test('api: doPost sql/sqls両方未指定はBAD_REQUEST', () => {
  const { sb, key } = setup();
  const res = post(sb, { apiKey: key });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'BAD_REQUEST');
});

test('api: doPost SQL構文エラーはSYNTAX_ERRORとして返る(例外を投げない)', () => {
  const { sb, key } = setup();
  const res = post(sb, { apiKey: key, sql: 'SELECT FROM' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'SYNTAX_ERROR');
});

test('api: doGet ping', () => {
  const { sb } = setup();
  const res = get(sb, { ping: '1' });
  assert.strictEqual(res.success, true);
});

test('api: doGet SELECT成功', () => {
  const { sb, key } = setup();
  const res = get(sb, { apiKey: key, sql: 'SELECT * FROM t' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.result.rowCount, 2);
});

test('api: doGet 更新系SQLはMETHOD_NOT_ALLOWEDで拒否される', () => {
  const { sb, key } = setup();
  const res = get(sb, { apiKey: key, sql: "INSERT INTO t (v) VALUES (9)" });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'METHOD_NOT_ALLOWED');
});

test('api: doGet APIキー不正', () => {
  const { sb } = setup();
  const res = get(sb, { apiKey: 'wrong', sql: 'SELECT 1' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'AUTH_FAILED');
});
