'use strict';
// 実機接続(Go/Echoバックエンド)で判明したギャップの解消を検証する:
//  1. CREATE TABLE の列制約 DEFAULT / NOT NULL(schema.sql 正本の自動実行で必要)
//  2. `?` プレースホルダ + params バインド(クライアント側エスケープ展開の廃止)
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

// ---------- 列制約: DEFAULT ----------

test('constraint: DEFAULT は未指定列へ適用される', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_("CREATE TABLE t (name TEXT, status TEXT DEFAULT 'active', n INTEGER DEFAULT 0)");
  sb.executeSql_("INSERT INTO t (name) VALUES ('a')");
  const row = sb.executeSql_('SELECT * FROM t').rows[0];
  assert.strictEqual(row.status, 'active');
  assert.strictEqual(row.n, 0);
});

test('constraint: 明示的な値・NULL指定は DEFAULT より優先される', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_("CREATE TABLE t (name TEXT, status TEXT DEFAULT 'active')");
  sb.executeSql_("INSERT INTO t (name, status) VALUES ('a', 'archived'), ('b', NULL)");
  const rows = sb.executeSql_('SELECT name, status FROM t ORDER BY name').rows;
  assert.strictEqual(rows[0].status, 'archived');
  assert.strictEqual(rows[1].status, null, '明示NULLはDEFAULTで上書きしない(SQL標準)');
});

test('constraint: DEFAULT 負数・TRUE/FALSE・NULL リテラル対応', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (a INTEGER DEFAULT -5, b BOOLEAN DEFAULT TRUE, c TEXT DEFAULT NULL)');
  sb.executeSql_("INSERT INTO t (c) VALUES ('x')");
  const row = sb.executeSql_('SELECT * FROM t').rows[0];
  assert.strictEqual(row.a, -5);
  assert.strictEqual(row.b, true);
});

test('constraint: 実機schema.sql形式の CREATE TABLE IF NOT EXISTS + PRIMARY KEY + DEFAULT が通る', () => {
  const sb = createInitializedSandbox();
  const r = sb.executeSql_(
    "CREATE TABLE IF NOT EXISTS clients (code TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active', priority INTEGER DEFAULT 3)"
  );
  assert.strictEqual(r.created, true);
  // 再実行は alreadyExists
  const r2 = sb.executeSql_("CREATE TABLE IF NOT EXISTS clients (code TEXT PRIMARY KEY)");
  assert.strictEqual(r2.alreadyExists, true);
  // DEFAULT が実際に効く
  sb.executeSql_("INSERT INTO clients (code, name) VALUES ('C001', '山田商事')");
  const row = sb.executeSql_("SELECT * FROM clients WHERE code = 'C001'").rows[0];
  assert.strictEqual(row.status, 'active');
  assert.strictEqual(row.priority, 3);
});

// ---------- 列制約: NOT NULL ----------

test('constraint: NOT NULL 違反の INSERT は NOT_NULL_VIOLATION', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (name TEXT NOT NULL, memo TEXT)');
  assert.throws(
    () => sb.executeSql_("INSERT INTO t (memo) VALUES ('x')"),
    (err) => err.code === 'NOT_NULL_VIOLATION'
  );
  assert.throws(
    () => sb.executeSql_("INSERT INTO t (name, memo) VALUES (NULL, 'x')"),
    (err) => err.code === 'NOT_NULL_VIOLATION'
  );
  // 違反INSERTは1行も書き込まない
  assert.strictEqual(sb.executeSql_('SELECT COUNT(*) AS n FROM t').rows[0].n, 0);
});

test('constraint: NOT NULL 列でも DEFAULT があれば未指定で通る', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_("CREATE TABLE t (status TEXT NOT NULL DEFAULT 'open', memo TEXT)");
  sb.executeSql_("INSERT INTO t (memo) VALUES ('x')");
  assert.strictEqual(sb.executeSql_('SELECT status FROM t').rows[0].status, 'open');
});

test('constraint: NOT NULL 列への UPDATE ... = NULL は拒否され1行も更新されない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (name TEXT NOT NULL, n INTEGER)');
  sb.executeSql_("INSERT INTO t (name, n) VALUES ('a', 1), ('b', 2)");
  assert.throws(
    () => sb.executeSql_('UPDATE t SET name = NULL'),
    (err) => err.code === 'NOT_NULL_VIOLATION'
  );
  const rows = sb.executeSql_('SELECT name FROM t ORDER BY n').rows.map((r) => r.name);
  assert.deepEqual(rows, ['a', 'b'], '違反UPDATEはシートへ書き込まれない');
});

// ---------- ? プレースホルダ / params ----------

test('params: SELECT WHERE の ? バインド', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (name TEXT, n INTEGER)');
  sb.executeSql_("INSERT INTO t (name, n) VALUES ('a', 1), ('b', 2), ('c', 3)");
  const rows = sb.executeSql_('SELECT name FROM t WHERE n > ? AND name != ? ORDER BY name', [1, 'c']).rows;
  assert.deepEqual(rows.map((r) => r.name), ['b']);
});

test('params: INSERT / UPDATE / DELETE の ? バインド', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (name TEXT, n INTEGER, flag BOOLEAN)');
  const ins = sb.executeSql_('INSERT INTO t (name, n, flag) VALUES (?, ?, ?)', ['x', 42, true]);
  assert.strictEqual(ins.insertedCount, 1);
  sb.executeSql_('UPDATE t SET n = ? WHERE name = ?', [100, 'x']);
  assert.strictEqual(sb.executeSql_('SELECT n FROM t').rows[0].n, 100);
  sb.executeSql_('DELETE FROM t WHERE n = ?', [100]);
  assert.strictEqual(sb.executeSql_('SELECT COUNT(*) AS c FROM t').rows[0].c, 0);
});

test('params: null バインドは SQL NULL として扱われる', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (name TEXT, memo TEXT)');
  sb.executeSql_('INSERT INTO t (name, memo) VALUES (?, ?)', ['a', null]);
  assert.strictEqual(sb.executeSql_('SELECT COUNT(*) AS c FROM t WHERE memo IS NULL').rows[0].c, 1);
});

test('params: SQL断片を含む文字列はリテラルのまま(インジェクション不能)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (name TEXT)');
  const evil = "x' OR '1'='1";
  sb.executeSql_('INSERT INTO t (name) VALUES (?)', [evil]);
  // 攻撃文字列と完全一致する行だけがヒットする(OR条件として解釈されない)
  const hit = sb.executeSql_('SELECT COUNT(*) AS c FROM t WHERE name = ?', [evil]).rows[0].c;
  assert.strictEqual(hit, 1);
  const miss = sb.executeSql_('SELECT COUNT(*) AS c FROM t WHERE name = ?', ['other']).rows[0].c;
  assert.strictEqual(miss, 0, "' OR '1'='1 が条件として効いていない");
});

test('params: 個数不一致・非配列・未対応型は BAD_REQUEST', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (n INTEGER)');
  assert.throws(
    () => sb.executeSql_('SELECT * FROM t WHERE n = ?', []),
    (err) => err.code === 'BAD_REQUEST'
  );
  assert.throws(
    () => sb.executeSql_('SELECT * FROM t WHERE n = ?', [1, 2]),
    (err) => err.code === 'BAD_REQUEST'
  );
  assert.throws(
    () => sb.executeSql_('SELECT * FROM t WHERE n = 1', [1]),
    (err) => err.code === 'BAD_REQUEST',
    'プレースホルダ無しでparamsを渡すのも不一致エラー'
  );
  assert.throws(
    () => sb.executeSql_('SELECT * FROM t WHERE n = ?', 'not-array'),
    (err) => err.code === 'BAD_REQUEST'
  );
  assert.throws(
    () => sb.executeSql_('SELECT * FROM t WHERE n = ?', [{ obj: 1 }]),
    (err) => err.code === 'BAD_REQUEST'
  );
});

test('params: doPost の params / sqls内 {sql, params} が動作する', () => {
  const sb = createInitializedSandbox();
  const apiKey = sb.issueApiKeyForClient('tester');
  sb.executeSql_('CREATE TABLE t (name TEXT, n INTEGER)');

  const post = (body) => JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(body) } })._text);

  const r1 = post({ apiKey, sql: 'INSERT INTO t (name, n) VALUES (?, ?)', params: ['a', 1] });
  assert.strictEqual(r1.success, true);
  assert.strictEqual(r1.result.insertedCount, 1);

  const r2 = post({
    apiKey,
    sqls: [
      { sql: 'INSERT INTO t (name, n) VALUES (?, ?)', params: ['b', 2] },
      "INSERT INTO t (name, n) VALUES ('c', 3)"
    ]
  });
  assert.strictEqual(r2.success, true);
  assert.strictEqual(r2.results.length, 2);

  const r3 = post({ apiKey, sql: 'SELECT COUNT(*) AS c FROM t WHERE n >= ?', params: [1] });
  assert.strictEqual(r3.result.rows[0].c, 3);
});

test('params: doGet の ?params=JSON配列 バインドと不正JSONの BAD_REQUEST', () => {
  const sb = createInitializedSandbox();
  const apiKey = sb.issueApiKeyForClient('tester');
  sb.executeSql_('CREATE TABLE t (name TEXT)');
  sb.executeSql_("INSERT INTO t (name) VALUES ('東京'), ('大阪')");

  const get = (parameter) => JSON.parse(sb.doGet({ parameter })._text);

  const ok = get({ apiKey, sql: 'SELECT * FROM t WHERE name = ?', params: '["東京"]' });
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.result.rowCount, 1);

  const bad = get({ apiKey, sql: 'SELECT * FROM t WHERE name = ?', params: '[broken' });
  assert.strictEqual(bad.success, false);
  assert.strictEqual(bad.code, 'BAD_REQUEST');

  // paramsを使ってもGET経由の更新系は遮断されたまま
  const blocked = get({ apiKey, sql: 'DELETE FROM t WHERE name = ?', params: '["東京"]' });
  assert.strictEqual(blocked.code, 'METHOD_NOT_ALLOWED');
});

test('params: バッチ失敗時も {sql, params} 形式でロールバックされる', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (n INTEGER NOT NULL)');
  sb.executeSql_('INSERT INTO t (n) VALUES (1)');
  assert.throws(
    () => sb.executeSqlBatch_([
      { sql: 'INSERT INTO t (n) VALUES (?)', params: [2] },
      { sql: 'INSERT INTO t (n) VALUES (?)', params: [null] } // NOT NULL違反で全体ロールバック
    ]),
    (err) => err.code === 'NOT_NULL_VIOLATION' && err.statementIndex === 1 && err.rolledBack === true
  );
  assert.strictEqual(sb.executeSql_('SELECT COUNT(*) AS c FROM t').rows[0].c, 1);
});

test('params: 制約付きテーブルはバックアップ復元後も制約が維持される', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_("CREATE TABLE t (name TEXT NOT NULL, status TEXT DEFAULT 'open')");
  sb.executeSql_("INSERT INTO t (name) VALUES ('a')");
  const b = sb.createBackup();
  sb.executeSql_('DROP TABLE t');
  sb.restoreFromBackup(b.id);
  // 復元後もDEFAULT/NOT NULLが効く(columnsJson経由で制約が永続化されている)
  sb.executeSql_("INSERT INTO t (name) VALUES ('b')");
  assert.strictEqual(sb.executeSql_("SELECT status FROM t WHERE name = 'b'").rows[0].status, 'open');
  assert.throws(
    () => sb.executeSql_('INSERT INTO t (status) VALUES (?)', ['x']),
    (err) => err.code === 'NOT_NULL_VIOLATION'
  );
});
