'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

test('shardstore: 閾値ちょうどでは新規シャードを作らない', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'v', type: 'INTEGER' }], 5);
  for (let i = 1; i <= 5; i++) sb.appendRows_('t', [{ v: i }]);
  assert.deepEqual(sb.getTableSchema_('t').shards, ['t__1']);
});

test('shardstore: 閾値超過で新規シャードが自動作成される', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'v', type: 'INTEGER' }], 5);
  for (let i = 1; i <= 6; i++) sb.appendRows_('t', [{ v: i }]);
  assert.deepEqual(sb.getTableSchema_('t').shards, ['t__1', 't__2']);
});

test('shardstore: 1回のappendRows_でも閾値を跨ぐ場合は複数シャードへ分割される', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'v', type: 'INTEGER' }], 3);
  const objs = [];
  for (let i = 1; i <= 10; i++) objs.push({ v: i });
  sb.appendRows_('t', objs); // 3+3+3+1 -> 4シャード
  assert.strictEqual(sb.getTableSchema_('t').shards.length, 4);
  const all = sb.readTableRows_('t').rows.map((r) => r.v).sort((a, b) => a - b);
  assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('shardstore: appendRows_ はID(__id)を連番で採番する', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'v', type: 'INTEGER' }], 100);
  const ids1 = sb.appendRows_('t', [{ v: 1 }, { v: 2 }]);
  const ids2 = sb.appendRows_('t', [{ v: 3 }]);
  assert.deepEqual(ids1, [1, 2]);
  assert.deepEqual(ids2, [3]);
});

test('shardstore: readTableRows_ は物理位置情報(__shard/__rowIndex)を付与する', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'v', type: 'INTEGER' }], 100);
  sb.appendRows_('t', [{ v: 1 }]);
  const row = sb.readTableRows_('t').rows[0];
  assert.strictEqual(row.__shard, 't__1');
  assert.strictEqual(row.__rowIndex, 2); // ヘッダーが1行目
});

test('shardstore: replaceShardData_ でシャードの行数を縮小できる(DELETE相当)', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('t', [{ name: 'v', type: 'INTEGER' }], 100);
  sb.appendRows_('t', [{ v: 1 }, { v: 2 }, { v: 3 }]);
  const header = sb.tableHeader_(sb.getTableSchema_('t'));
  sb.replaceShardData_('t__1', [[99, 'x', new Date(), new Date()]], header.length);
  const rows = sb.readTableRows_('t').rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].__id, 99);
});

test('shardstore: 型強制(coerceValue_)でINTEGER/REAL/BOOLEAN/DATEが変換される', () => {
  const sb = createInitializedSandbox();
  assert.strictEqual(sb.coerceValue_('42', 'INTEGER'), 42);
  assert.strictEqual(sb.coerceValue_('3.5', 'REAL'), 3.5);
  assert.strictEqual(sb.coerceValue_('true', 'BOOLEAN'), true);
  assert.strictEqual(sb.coerceValue_('TRUE', 'BOOLEAN'), true);
  assert.strictEqual(sb.coerceValue_('0', 'BOOLEAN'), false);
  const d = sb.coerceValue_('2026-01-01', 'DATE');
  assert.strictEqual(typeof d.getTime, 'function');
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(sb.coerceValue_(null, 'TEXT'), null);
});
