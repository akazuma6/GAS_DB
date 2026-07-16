'use strict';
/**
 * 実環境用診断関数(src/Diagnostics.js)のテスト。
 * runSelfTest / diagnoseDatabase はGASエディタから手動実行する想定だが、
 * モック上でもロジックが正しく動くことを保証する。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

test('diagnostics: runSelfTest はモック上で全ケース成功し、一時テーブルを残さない', () => {
  const sb = createInitializedSandbox();
  const summary = sb.runSelfTest();
  assert.strictEqual(summary.failed, 0, JSON.stringify(summary.results.filter((r) => !r.ok)));
  assert.strictEqual(summary.passed, summary.total);
  // 一時テーブルがクリーンアップされている
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.listTables_())), []);
  // 一時シャードシートも物理的に残っていない
  const leftover = sb.getDb_().getSheets().filter((s) => s.getName().indexOf('__selftest_') === 0);
  assert.strictEqual(leftover.length, 0);
});

test('diagnostics: diagnoseDatabase 正常系(異常なしレポート)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER, s TEXT)');
  sb.executeSql_("INSERT INTO t (v, s) VALUES (1, 'a'), (2, 'b')");
  const report = sb.diagnoseDatabase();
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.tables.length, 1);
  assert.strictEqual(report.tables[0].rowCount, 2);
  assert.strictEqual(report.tables[0].maxId, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(report.orphanSheets)), []);
  assert.ok(report.cellUsage.cells > 0);
});

test('diagnostics: 孤立シャードシートを検出する', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.getDb_().insertSheet('ghost__1'); // カタログ未登録のシャード風シート
  const report = sb.diagnoseDatabase();
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(report.orphanSheets)), ['ghost__1']);
});

test('diagnostics: nextId の巻き戻り(ID衝突リスク)を検出する', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1), (2), (3)');
  // カタログの nextId を不正に巻き戻す(手動操作や障害の想定)
  const schema = sb.getTableSchema_('t');
  sb.getSchemaSheet_().getRange(schema.rowIndex, 5).setValue(2);
  sb.invalidateSchemaCache_();
  const report = sb.diagnoseDatabase();
  assert.strictEqual(report.ok, false);
  assert.ok(report.problems.some((p) => p.indexOf('ID衝突の危険') !== -1), JSON.stringify(report.problems));
});

test('diagnostics: シャードシート欠損を検出する', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  const db = sb.getDb_();
  db.deleteSheet(db.getSheetByName('t__1')); // シャードだけ物理削除
  const report = sb.diagnoseDatabase();
  assert.strictEqual(report.ok, false);
  assert.ok(report.problems.some((p) => p.indexOf('シャードシート欠損') !== -1), JSON.stringify(report.problems));
});

test('diagnostics: DB未初期化でも例外を投げずレポートで返す', () => {
  const { createSandbox } = require('./support/gasMock.js');
  const sb = createSandbox(); // initializeDatabase() を呼ばない
  const report = sb.diagnoseDatabase();
  assert.strictEqual(report.ok, false);
  assert.ok(report.problems.some((p) => p.indexOf('未設定') !== -1));
});

test('diagnostics: debugSql_ は成功・失敗の両方を構造化して返す', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1), (2)');

  const ok = sb.debugSql_('SELECT v FROM t ORDER BY v');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.result.rowCount, 2);
  assert.strictEqual(typeof ok.ms, 'number');

  const ng = sb.debugSql_('SELECT * FROM nope');
  assert.strictEqual(ng.ok, false);
  assert.strictEqual(ng.code, 'NO_SUCH_TABLE');
});
