'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

function seed(sb) {
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1), (2), (3)');
  return sb;
}

test('backup: createBackup はDB全体を別ファイルへ複製しレジストリへ記録する', () => {
  const sb = seed(createInitializedSandbox());
  const b = sb.createBackup('手動');
  assert.ok(b.id, 'バックアップIDが返る');
  assert.ok(b.name.indexOf('GAS-DB-backup-') === 0, 'ファイル名prefix');
  assert.ok(b.name.indexOf('手動') !== -1, 'ラベルがファイル名に含まれる');

  // バックアップファイルに全シートが複製されている
  const copy = sb.SpreadsheetApp.openById(b.id);
  assert.ok(copy.getSheetByName('_schema'), '_schemaシートが複製されている');
  assert.ok(copy.getSheetByName('t__1'), 'シャードシートが複製されている');

  const list = sb.listBackups();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, b.id);
  assert.strictEqual(list[0].missing, false);
});

test('backup: バックアップ後の変更はバックアップファイルへ影響しない(独立性)', () => {
  const sb = seed(createInitializedSandbox());
  const b = sb.createBackup();
  sb.executeSql_('INSERT INTO t (v) VALUES (99)');
  sb.executeSql_('UPDATE t SET v = 1000 WHERE v = 1');

  // 現DBは変更済み
  assert.strictEqual(sb.executeSql_('SELECT COUNT(*) AS n FROM t').rows[0].n, 4);
  // バックアップは無傷(シャードシートの生データを直接確認)
  const copy = sb.SpreadsheetApp.openById(b.id);
  const shard = copy.getSheetByName('t__1');
  const values = shard.getRange(2, 2, 3, 1).getValues().map((r) => r[0]);
  assert.deepEqual(values, [1, 2, 3]);
});

test('backup: restoreFromBackup でバックアップ時点のデータへ戻る', () => {
  const sb = seed(createInitializedSandbox());
  const b = sb.createBackup();

  // バックアップ後に破壊的変更
  sb.executeSql_('DELETE FROM t');
  sb.executeSql_('DROP TABLE t');
  assert.strictEqual(sb.listTables_().indexOf('t'), -1);

  const r = sb.restoreFromBackup(b.id);
  assert.strictEqual(r.restoredFrom, b.id);
  assert.notStrictEqual(r.newDbId, b.id, '復元先はバックアップ自体ではなく複製');
  assert.ok(r.oldDbId, '旧DBのIDが返る');

  // 復元後: バックアップ時点のデータが読める
  const rows = sb.executeSql_('SELECT v FROM t ORDER BY v').rows.map((x) => x.v);
  assert.deepEqual(rows, [1, 2, 3]);
  // INSERTも正常動作(nextId等のカタログも復元されている)
  sb.executeSql_('INSERT INTO t (v) VALUES (4)');
  assert.strictEqual(sb.executeSql_('SELECT COUNT(*) AS n FROM t').rows[0].n, 4);
});

test('backup: 復元してもバックアップ自体と旧DBは無傷で残る', () => {
  const sb = seed(createInitializedSandbox());
  const oldDbId = sb.PropertiesService.getScriptProperties().getProperty('DB_SPREADSHEET_ID');
  const b = sb.createBackup();
  sb.restoreFromBackup(b.id);

  // バックアップファイルは開ける(ゴミ箱行きしていない)
  assert.ok(sb.SpreadsheetApp.openById(b.id).getSheetByName('t__1'));
  // 旧DBファイルも開ける
  assert.ok(sb.SpreadsheetApp.openById(oldDbId).getSheetByName('t__1'));
});

test('backup: 保持世代数を超えた古いバックアップは自動削除される', () => {
  const sb = seed(createInitializedSandbox());
  sb.PropertiesService.getScriptProperties().setProperty('BACKUP_RETENTION', '3');

  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(sb.createBackup('g' + i).id);

  const list = sb.listBackups();
  assert.strictEqual(list.length, 3, 'レジストリは3世代のみ');
  // 残っているのは新しい3つ(g2, g3, g4)
  assert.deepEqual(list.map((b) => b.id), [ids[4], ids[3], ids[2]]);
  // 古い2つはゴミ箱行き
  assert.ok(sb.DriveApp.getFileById(ids[0]).isTrashed());
  assert.ok(sb.DriveApp.getFileById(ids[1]).isTrashed());
  // 新しい3つは無傷
  assert.ok(!sb.DriveApp.getFileById(ids[4]).isTrashed());
});

test('backup: deleteBackup はファイルをゴミ箱へ移動しレジストリから除去する', () => {
  const sb = seed(createInitializedSandbox());
  const b1 = sb.createBackup('a');
  const b2 = sb.createBackup('b');
  sb.deleteBackup(b1.id);

  const list = sb.listBackups();
  assert.deepEqual(list.map((x) => x.id), [b2.id]);
  assert.ok(sb.DriveApp.getFileById(b1.id).isTrashed());
});

test('backup: 存在しないIDのdeleteBackup/restoreFromBackupはエラー', () => {
  const sb = seed(createInitializedSandbox());
  assert.throws(
    () => sb.deleteBackup('nonexistent'),
    (err) => err.code === 'BACKUP_NOT_FOUND'
  );
  assert.throws(
    () => sb.restoreFromBackup('nonexistent'),
    (err) => err.code === 'BACKUP_NOT_FOUND'
  );
  assert.throws(
    () => sb.restoreFromBackup(null),
    (err) => err.code === 'BAD_REQUEST'
  );
});

test('backup: _schemaシートの無いスプレッドシートからの復元は拒否される', () => {
  const sb = seed(createInitializedSandbox());
  const rogue = sb.SpreadsheetApp.create('not-a-backup');
  rogue.insertSheet('random');
  assert.throws(
    () => sb.restoreFromBackup(rogue.getId()),
    (err) => err.code === 'BACKUP_INVALID'
  );
});

test('backup: ゴミ箱移動済みバックアップは listBackups で missing 表示', () => {
  const sb = seed(createInitializedSandbox());
  const b = sb.createBackup();
  sb.DriveApp.getFileById(b.id).setTrashed(true);
  const list = sb.listBackups();
  assert.strictEqual(list[0].missing, true);
});

test('backup: レジストリJSON破損時も createBackup は成功する(自己修復)', () => {
  const sb = seed(createInitializedSandbox());
  sb.PropertiesService.getScriptProperties().setProperty('BACKUPS', '{broken json');
  const b = sb.createBackup();
  assert.ok(b.id);
  assert.strictEqual(sb.listBackups().length, 1);
});

test('backup: setupDailyBackupTrigger はトリガーを1つだけ登録し再実行で置き換える', () => {
  const sb = createInitializedSandbox();
  sb.setupDailyBackupTrigger(4);
  assert.strictEqual(sb.__triggers.length, 1);
  assert.strictEqual(sb.__triggers[0].getHandlerFunction(), 'createDailyBackup');
  assert.strictEqual(sb.__triggers[0]._config.atHour, 4);

  sb.setupDailyBackupTrigger(2); // 再設定 → 置き換え(重複登録しない)
  assert.strictEqual(sb.__triggers.length, 1);
  assert.strictEqual(sb.__triggers[0]._config.atHour, 2);
});

test('backup: createDailyBackup(トリガーハンドラ)は daily ラベルで作成する', () => {
  const sb = seed(createInitializedSandbox());
  const b = sb.createDailyBackup();
  assert.ok(b.name.indexOf('daily') !== -1);
});

test('backup: シャード分割済みテーブルも全シャード復元される', () => {
  const sb = createInitializedSandbox();
  sb.createTable_('big', [{ name: 'v', type: 'INTEGER' }], 3);
  const objs = [];
  for (let i = 1; i <= 8; i++) objs.push({ v: i });
  sb.appendRows_('big', objs); // 3シャードに分割される
  const b = sb.createBackup();

  sb.executeSql_('DELETE FROM big');
  sb.restoreFromBackup(b.id);

  assert.strictEqual(sb.getTableSchema_('big').shards.length, 3);
  assert.strictEqual(sb.executeSql_('SELECT SUM(v) AS s FROM big').rows[0].s, 36);
});
