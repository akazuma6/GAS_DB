'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

test('schema: createTable_ でカタログとシャードシート1枚目が作られる', () => {
  const sb = createInitializedSandbox();
  const schema = sb.createTable_('t', [{ name: 'a', type: 'TEXT' }], 100);
  assert.strictEqual(schema.tableName, 't');
  assert.deepEqual(schema.shards, ['t__1']);
  assert.strictEqual(schema.nextId, 1);
  assert.strictEqual(schema.shardThreshold, 100);

  const db = sb.getDb_();
  const sheet = db.getSheetByName('t__1');
  assert.ok(sheet, 'シャードシートが作成されている');
  assert.deepEqual(sheet.getRange(1, 1, 1, 4).getValues()[0], ['__id', 'a', '__created_at', '__updated_at']);
});

test('schema: 同名テーブルを重複作成しようとするとTABLE_EXISTS', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'a', type: 'TEXT' }], 100);
  assert.throws(
    () => sb.createTable_('t', [{ name: 'a', type: 'TEXT' }], 100),
    (err) => err instanceof sb.SqlError && err.code === 'TABLE_EXISTS'
  );
});

test('schema: 予約列名(__id等)は列定義に使用不可', () => {
  const sb = createInitializedSandbox();
  assert.throws(
    () => sb.createTable_('t', [{ name: '__id', type: 'TEXT' }], 100),
    (err) => err instanceof sb.SqlError && err.code === 'RESERVED_COLUMN'
  );
});

test('schema: listTables_ / getTableSchema_', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t1', [{ name: 'a', type: 'TEXT' }], 100);
  sb.createTable_('t2', [{ name: 'b', type: 'TEXT' }], 100);
  assert.deepEqual(sb.listTables_().sort(), ['t1', 't2']);
  assert.strictEqual(sb.getTableSchema_('nope'), null);
});

test('schema: dropTable_ でシャードシートとカタログ行が消える', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'a', type: 'TEXT' }], 100);
  sb.dropTable_('t');
  assert.strictEqual(sb.getTableSchema_('t'), null);
  assert.strictEqual(sb.getDb_().getSheetByName('t__1'), null);
});

test('schema: dropTable_ 未存在テーブルはNO_SUCH_TABLE', () => {
  const sb = createInitializedSandbox();
  assert.throws(
    () => sb.dropTable_('nope'),
    (err) => err instanceof sb.SqlError && err.code === 'NO_SUCH_TABLE'
  );
});

test('schema: allocateIds_ は連番を払い出しnextIdを更新する', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'a', type: 'TEXT' }], 100);
  const first = sb.allocateIds_('t', 3);
  assert.strictEqual(first, 1);
  const second = sb.allocateIds_('t', 2);
  assert.strictEqual(second, 4);
  assert.strictEqual(sb.getTableSchema_('t').nextId, 6);
});

test('DB未初期化状態でgetDb_を呼ぶとDATABASE_NOT_INITIALIZED', () => {
  const { createSandbox } = require('./support/gasMock.js');
  const sb = createSandbox();
  assert.throws(
    () => sb.getDb_(),
    (err) => err instanceof sb.SqlError && err.code === 'DATABASE_NOT_INITIALIZED'
  );
});
