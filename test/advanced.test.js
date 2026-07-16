'use strict';
/**
 * 高度機能のテスト: サブクエリ(IN / スカラー、非相関) / UNION / UNION ALL /
 * sqlsバッチのトランザクション(全体ロック+失敗時ロールバック)。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function post(sb, key, body) {
  const payload = Object.assign({ apiKey: key }, body);
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(payload) } })._text);
}

// ---------- サブクエリ ----------

test('subquery: WHERE x IN (SELECT ...) / NOT IN', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE customers (code TEXT, name TEXT)');
  sb.executeSql_('CREATE TABLE orders (code TEXT, item TEXT)');
  sb.executeSql_("INSERT INTO customers (code, name) VALUES ('C1','鈴木'), ('C2','山田'), ('C3','佐藤')");
  sb.executeSql_("INSERT INTO orders (code, item) VALUES ('C1','りんご'), ('C3','みかん')");

  const r = sb.executeSql_('SELECT name FROM customers WHERE code IN (SELECT code FROM orders) ORDER BY code');
  assert.deepStrictEqual(plain(r.rows.map((x) => x.name)), ['鈴木', '佐藤']);

  const n = sb.executeSql_('SELECT name FROM customers WHERE code NOT IN (SELECT code FROM orders)');
  assert.deepStrictEqual(plain(n.rows.map((x) => x.name)), ['山田']);
});

test('subquery: スカラーサブクエリ(WHERE比較・SELECT列・算術式内)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE sales (region TEXT, amount INTEGER)');
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('東', 100), ('西', 300), ('北', 200)");

  const mx = sb.executeSql_('SELECT region FROM sales WHERE amount = (SELECT MAX(amount) FROM sales)');
  assert.deepStrictEqual(plain(mx.rows), [{ region: '西' }]);

  const col = sb.executeSql_('SELECT region, (SELECT COUNT(*) FROM sales) AS total FROM sales LIMIT 1');
  assert.strictEqual(col.rows[0].total, 3);

  // 算術式との組み合わせ: 平均超えの地域
  const avg = sb.executeSql_('SELECT region FROM sales WHERE amount > (SELECT AVG(amount) FROM sales) ORDER BY region');
  assert.deepStrictEqual(plain(avg.rows.map((x) => x.region)), ['西']);
});

test('subquery: 0行のスカラーサブクエリはNULL、複数行はSUBQUERY_ERROR', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('CREATE TABLE empty (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1), (2)');

  const r = sb.executeSql_('SELECT (SELECT v FROM empty) AS x FROM t LIMIT 1');
  assert.strictEqual(r.rows[0].x, null);
  // NULLとの比較は不成立
  assert.strictEqual(sb.executeSql_('SELECT v FROM t WHERE v = (SELECT v FROM empty)').rowCount, 0);

  assert.throws(
    () => sb.executeSql_('SELECT v FROM t WHERE v = (SELECT v FROM t)'),
    (err) => err.code === 'SUBQUERY_ERROR'
  );
});

test('subquery: INサブクエリが複数列を返すとSUBQUERY_ERROR', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (a INTEGER, b INTEGER)');
  sb.executeSql_('INSERT INTO t (a, b) VALUES (1, 2)');
  assert.throws(
    () => sb.executeSql_('SELECT a FROM t WHERE a IN (SELECT a, b FROM t)'),
    (err) => err.code === 'SUBQUERY_ERROR'
  );
});

test('subquery: IN (SELECT ... UNION SELECT ...) の複合サブクエリ', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v TEXT)');
  sb.executeSql_('CREATE TABLE w1 (v TEXT)');
  sb.executeSql_('CREATE TABLE w2 (v TEXT)');
  sb.executeSql_("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')");
  sb.executeSql_("INSERT INTO w1 (v) VALUES ('a')");
  sb.executeSql_("INSERT INTO w2 (v) VALUES ('c')");
  const r = sb.executeSql_('SELECT v FROM t WHERE v IN (SELECT v FROM w1 UNION SELECT v FROM w2) ORDER BY v');
  assert.deepStrictEqual(plain(r.rows.map((x) => x.v)), ['a', 'c']);
});

// ---------- UNION ----------

test('union: UNIONは重複排除、UNION ALLは保持', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE a (v TEXT)');
  sb.executeSql_('CREATE TABLE b (v TEXT)');
  sb.executeSql_("INSERT INTO a (v) VALUES ('x'), ('y'), ('y')");
  sb.executeSql_("INSERT INTO b (v) VALUES ('y'), ('z')");

  const u = sb.executeSql_('SELECT v FROM a UNION SELECT v FROM b ORDER BY v');
  assert.deepStrictEqual(plain(u.rows.map((x) => x.v)), ['x', 'y', 'z']);

  const ua = sb.executeSql_('SELECT v FROM a UNION ALL SELECT v FROM b ORDER BY v');
  assert.deepStrictEqual(plain(ua.rows.map((x) => x.v)), ['x', 'y', 'y', 'y', 'z']);
});

test('union: 列名は先頭SELECTを採用し位置ベースで揃える、ORDER BY/LIMITは全体へ適用', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE cur (name TEXT, amount INTEGER)');
  sb.executeSql_('CREATE TABLE arch (title TEXT, total INTEGER)');
  sb.executeSql_("INSERT INTO cur (name, amount) VALUES ('今期A', 100), ('今期B', 300)");
  sb.executeSql_("INSERT INTO arch (title, total) VALUES ('旧X', 200)");

  const r = sb.executeSql_(
    'SELECT name, amount FROM cur UNION ALL SELECT title, total FROM arch ORDER BY amount DESC LIMIT 2'
  );
  assert.deepStrictEqual(plain(r.columns), ['name', 'amount']);
  assert.deepStrictEqual(plain(r.rows), [
    { name: '今期B', amount: 300 },
    { name: '旧X', amount: 200 }
  ]);
});

test('union: A UNION B UNION ALL C は左結合で段階評価される', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE ta (v TEXT)');
  sb.executeSql_('CREATE TABLE tb (v TEXT)');
  sb.executeSql_('CREATE TABLE tc (v TEXT)');
  sb.executeSql_("INSERT INTO ta (v) VALUES ('x'), ('x')");
  sb.executeSql_("INSERT INTO tb (v) VALUES ('x')");
  sb.executeSql_("INSERT INTO tc (v) VALUES ('x')");
  // (ta UNION tb) → ['x'] に tc をALL連結 → ['x','x']
  const r = sb.executeSql_('SELECT v FROM ta UNION SELECT v FROM tb UNION ALL SELECT v FROM tc');
  assert.strictEqual(r.rowCount, 2);
});

test('union: 列数不一致はUNION_COLUMN_MISMATCH', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE a (v TEXT, w TEXT)');
  sb.executeSql_('CREATE TABLE b (v TEXT)');
  assert.throws(
    () => sb.executeSql_('SELECT v, w FROM a UNION SELECT v FROM b'),
    (err) => err.code === 'UNION_COLUMN_MISMATCH'
  );
});

test('union: doGet はUNIONクエリを読み取り系として許可する', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE a (v TEXT)');
  sb.executeSql_("INSERT INTO a (v) VALUES ('x')");
  const res = JSON.parse(sb.doGet({ parameter: { apiKey: key, sql: 'SELECT v FROM a UNION SELECT v FROM a' } })._text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.result.rowCount, 1);
});

// ---------- バッチトランザクション ----------

test('tx: バッチ成功時は全文の結果が返り、全て反映される', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  const res = post(sb, key, { sqls: ['INSERT INTO t (v) VALUES (1)', 'INSERT INTO t (v) VALUES (2)', 'SELECT COUNT(*) AS n FROM t'] });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.results.length, 3);
  assert.strictEqual(res.results[2].rows[0].n, 2);
});

test('tx: 途中失敗でINSERTがロールバックされ、失敗位置が報告される', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (99)');

  const res = post(sb, key, {
    sqls: [
      'INSERT INTO t (v) VALUES (1)',
      'INSERT INTO t (v) VALUES (2)',
      'INSERT INTO t (nope) VALUES (3)' // NO_SUCH_COLUMN で失敗
    ]
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'NO_SUCH_COLUMN');
  assert.strictEqual(res.statementIndex, 2);
  assert.strictEqual(res.rolledBack, true);

  // バッチ前の状態(v=99 の1行のみ)へ復元されている
  const after = sb.executeSql_('SELECT v FROM t');
  assert.deepStrictEqual(plain(after.rows), [{ v: 99 }]);
  // ロールバック後のINSERTはnextIdも復元されているため連番が続く
  sb.executeSql_('INSERT INTO t (v) VALUES (100)');
  const ids = sb.executeSql_('SELECT __id FROM t ORDER BY __id');
  assert.deepStrictEqual(plain(ids.rows.map((x) => x.__id)), [1, 2]);
});

test('tx: UPDATE / DELETE も失敗時にロールバックされる', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (v INTEGER, s TEXT)');
  sb.executeSql_("INSERT INTO t (v, s) VALUES (1, 'a'), (2, 'b'), (3, 'c')");

  const res = post(sb, key, {
    sqls: [
      "UPDATE t SET s = 'updated' WHERE v = 1",
      'DELETE FROM t WHERE v = 2',
      'SELECT * FROM broken_table' // NO_SUCH_TABLE で失敗
    ]
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.rolledBack, true);

  const after = sb.executeSql_('SELECT v, s FROM t ORDER BY v');
  assert.deepStrictEqual(plain(after.rows), [
    { v: 1, s: 'a' },
    { v: 2, s: 'b' },
    { v: 3, s: 'c' }
  ]);
});

test('tx: バッチ内CREATE TABLEのロールバックでテーブルごと消える', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  const res = post(sb, key, {
    sqls: [
      'CREATE TABLE newt (v INTEGER)',
      'INSERT INTO newt (v) VALUES (1)',
      'INSERT INTO newt (v) VALUES (bad syntax' // 構文エラー
    ]
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.rolledBack, true);
  assert.throws(() => sb.executeSql_('SELECT * FROM newt'), (err) => err.code === 'NO_SUCH_TABLE');
});

test('tx: DROP TABLEのロールバックでデータ・採番ごと復元される', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (10), (20)');

  const res = post(sb, key, {
    sqls: ['DROP TABLE t', 'SELECT * FROM t'] // DROP直後のSELECTで失敗
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'NO_SUCH_TABLE');
  assert.strictEqual(res.rolledBack, true);

  // データ復元確認
  const after = sb.executeSql_('SELECT v FROM t ORDER BY v');
  assert.deepStrictEqual(plain(after.rows.map((x) => x.v)), [10, 20]);
  // 採番継続確認(復元されたnextIdから)
  sb.executeSql_('INSERT INTO t (v) VALUES (30)');
  const ids = sb.executeSql_('SELECT __id FROM t ORDER BY __id');
  assert.deepStrictEqual(plain(ids.rows.map((x) => x.__id)), [1, 2, 3]);
});

test('tx: 複数テーブルにまたがる変更も全てロールバックされる', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE x (v INTEGER)');
  sb.executeSql_('CREATE TABLE y (v INTEGER)');
  sb.executeSql_('INSERT INTO x (v) VALUES (1)');

  const res = post(sb, key, {
    sqls: [
      'INSERT INTO x (v) VALUES (2)',
      'INSERT INTO y (v) VALUES (100)',
      'DELETE FROM x',
      'INSERT INTO z (v) VALUES (0)' // NO_SUCH_TABLE で失敗
    ]
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.rolledBack, true);

  assert.deepStrictEqual(plain(sb.executeSql_('SELECT v FROM x').rows), [{ v: 1 }]);
  assert.strictEqual(sb.executeSql_('SELECT v FROM y').rowCount, 0);
});
