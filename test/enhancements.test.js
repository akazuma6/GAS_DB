'use strict';
/**
 * 機能拡張のテスト: 算術式 / UPDATE式 / ORDER BY式・集計 / バリデーション強化 /
 * ハッシュ等値結合 / スキーマキャッシュ整合性。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

// サンドボックス(vm)由来の配列/オブジェクトはプロトタイプが別レルムのため、
// deepStrictEqual の前にホスト側の素のオブジェクトへ変換する。
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// ---------- 算術式 ----------

test('arith: 演算子の優先順位と括弧(+ - * /)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1)');
  const r = sb.executeSql_('SELECT 2 + 3 * 4 AS a, (2 + 3) * 4 AS b, 10 - 4 - 3 AS c, 20 / 2 / 2 AS d FROM t');
  assert.deepStrictEqual(plain(r.rows[0]), { a: 14, b: 20, c: 3, d: 5 });
});

test('arith: 列を含む算術式(SELECT / WHERE / 集計引数 / HAVING)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE items (name TEXT, price INTEGER, qty INTEGER)');
  sb.executeSql_("INSERT INTO items (name, price, qty) VALUES ('a', 100, 3), ('b', 50, 2), ('c', 200, 1)");

  const sel = sb.executeSql_('SELECT name, price * qty AS total FROM items ORDER BY total DESC');
  assert.deepStrictEqual(plain(sel.rows), [
    { name: 'a', total: 300 },
    { name: 'c', total: 200 },
    { name: 'b', total: 100 }
  ]);

  assert.strictEqual(sb.executeSql_('SELECT name FROM items WHERE price * qty > 150').rowCount, 2);

  const agg = sb.executeSql_('SELECT SUM(price * qty) AS gross FROM items');
  assert.strictEqual(agg.rows[0].gross, 600);

  const hav = sb.executeSql_('SELECT name, SUM(price * qty) AS s FROM items GROUP BY name HAVING SUM(price * qty) >= 200');
  assert.strictEqual(hav.rowCount, 2);
});

test('arith: 単項マイナス(列・式・関数)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (5)');
  const r = sb.executeSql_('SELECT -v AS nv, -(v + 1) AS ne, -COUNT(*) AS nc FROM t');
  assert.deepStrictEqual(plain(r.rows[0]), { nv: -5, ne: -6, nc: -1 });
});

test('arith: NULL伝播と0除算はNULLを返す(SQLite準拠)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (a INTEGER, b INTEGER)');
  sb.executeSql_('INSERT INTO t (a, b) VALUES (10, NULL), (10, 0)');
  const r = sb.executeSql_('SELECT a + b AS s, a / b AS q FROM t');
  assert.deepStrictEqual(plain(r.rows), [
    { s: null, q: null },
    { s: 10, q: null }
  ]);
  // NULLを含む算術式との比較は不成立(b=NULL行は除外され、b=0行のみマッチ)
  assert.strictEqual(sb.executeSql_('SELECT a FROM t WHERE a + b > 0').rowCount, 1);
  // 0除算(NULL)との比較も不成立
  assert.strictEqual(sb.executeSql_('SELECT a FROM t WHERE a / b > 0').rowCount, 0);
});

// ---------- UPDATE 式 ----------

test('update-expr: SET stock = stock - 1 のような自己参照式が使える', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE stock (code TEXT, qty INTEGER)');
  sb.executeSql_("INSERT INTO stock (code, qty) VALUES ('A', 10), ('B', 5)");
  sb.executeSql_("UPDATE stock SET qty = qty - 1 WHERE code = 'A'");
  const r = sb.executeSql_('SELECT code, qty FROM stock ORDER BY code');
  assert.deepStrictEqual(plain(r.rows), [{ code: 'A', qty: 9 }, { code: 'B', qty: 5 }]);
});

test('update-expr: 複数代入は更新前の値で評価される(SET a = b, b = a でスワップ)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE p (a INTEGER, b INTEGER)');
  sb.executeSql_('INSERT INTO p (a, b) VALUES (1, 2)');
  sb.executeSql_('UPDATE p SET a = b, b = a');
  const r = sb.executeSql_('SELECT a, b FROM p');
  assert.deepStrictEqual(plain(r.rows[0]), { a: 2, b: 1 });
});

test('update-expr: 代入式内の未知の列はNO_SUCH_COLUMN', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1)');
  assert.throws(
    () => sb.executeSql_('UPDATE t SET v = nope + 1'),
    (err) => err.code === 'NO_SUCH_COLUMN'
  );
});

// ---------- ORDER BY 式・集計 ----------

test('orderby-expr: ORDER BY 算術式', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE items (name TEXT, price INTEGER, qty INTEGER)');
  sb.executeSql_("INSERT INTO items (name, price, qty) VALUES ('a', 100, 1), ('b', 10, 50), ('c', 30, 3)");
  const r = sb.executeSql_('SELECT name FROM items ORDER BY price * qty DESC');
  assert.deepStrictEqual(plain(r.rows.map((x) => x.name)), ['b', 'a', 'c']);
});

test('orderby-expr: ORDER BY COUNT(*) DESC(SELECTに集計エイリアスが無くても可)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE s (region TEXT)');
  sb.executeSql_("INSERT INTO s (region) VALUES ('西'), ('東'), ('東'), ('北'), ('東'), ('西')");
  const r = sb.executeSql_('SELECT region FROM s GROUP BY region ORDER BY COUNT(*) DESC');
  assert.deepStrictEqual(plain(r.rows.map((x) => x.region)), ['東', '西', '北']);
});

test('orderby-expr: 式内の未知の列は静的検証でNO_SUCH_COLUMN', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  assert.throws(
    () => sb.executeSql_('SELECT v FROM t ORDER BY nope + 1'),
    (err) => err.code === 'NO_SUCH_COLUMN'
  );
});

// ---------- バリデーション強化 ----------

test('validation: LIMIT / OFFSET に非整数はSYNTAX_ERROR', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  assert.throws(() => sb.executeSql_('SELECT v FROM t LIMIT 1.5'), (err) => err.code === 'SYNTAX_ERROR');
  assert.throws(() => sb.executeSql_('SELECT v FROM t LIMIT 10 OFFSET 0.5'), (err) => err.code === 'SYNTAX_ERROR');
});

test('validation: INSERT の重複列指定はDUPLICATE_COLUMN', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (a INTEGER, b INTEGER)');
  assert.throws(
    () => sb.executeSql_('INSERT INTO t (a, a) VALUES (1, 2)'),
    (err) => err.code === 'DUPLICATE_COLUMN'
  );
});

test('validation: doGet は先頭コメント付きSELECTを許可し、更新系は構文レベルで拒否する', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1)');

  const ok = JSON.parse(sb.doGet({ parameter: { apiKey: key, sql: '-- 確認用\nSELECT v FROM t' } })._text);
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.result.rowCount, 1);

  const ng = JSON.parse(sb.doGet({ parameter: { apiKey: key, sql: 'DELETE FROM t' } })._text);
  assert.strictEqual(ng.success, false);
  assert.strictEqual(ng.code, 'METHOD_NOT_ALLOWED');
  // 拒否されたので行は残っている
  assert.strictEqual(sb.executeSql_('SELECT v FROM t').rowCount, 1);
});

// ---------- ハッシュ等値結合 ----------

test('hashjoin: 等値INNER JOINの結果がネステッドループと同一(重複キー含む)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE o (cust TEXT, item TEXT)');
  sb.executeSql_('CREATE TABLE c (cust TEXT, pref TEXT)');
  sb.executeSql_("INSERT INTO o (cust, item) VALUES ('C1','りんご'), ('C1','みかん'), ('C2','ぶどう'), ('C9','なし')");
  sb.executeSql_("INSERT INTO c (cust, pref) VALUES ('C1','東京都'), ('C2','大阪府')");
  const r = sb.executeSql_('SELECT o.item, c.pref FROM o JOIN c ON o.cust = c.cust ORDER BY o.item');
  assert.deepStrictEqual(plain(r.rows), [
    { item: 'ぶどう', pref: '大阪府' },
    { item: 'みかん', pref: '東京都' },
    { item: 'りんご', pref: '東京都' }
  ]);
});

test('hashjoin: LEFT JOIN 不一致行はNULL埋め、NULLキーはマッチしない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE a (k TEXT)');
  sb.executeSql_('CREATE TABLE b (k TEXT, v TEXT)');
  sb.executeSql_("INSERT INTO a (k) VALUES ('x'), (NULL), ('z')");
  sb.executeSql_("INSERT INTO b (k, v) VALUES ('x','X'), (NULL,'N')");
  const r = sb.executeSql_('SELECT a.k, b.v FROM a LEFT JOIN b ON a.k = b.k ORDER BY a.__id');
  assert.deepStrictEqual(plain(r.rows), [
    { k: 'x', v: 'X' },
    { k: null, v: null }, // NULL同士は等値マッチしない(SQLセマンティクス)
    { k: 'z', v: null }
  ]);
});

test('hashjoin: 数値と数字文字列は型不一致でマッチしない(1 vs \'1\')', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE ni (k INTEGER)');
  sb.executeSql_('CREATE TABLE ns (k TEXT)');
  sb.executeSql_('INSERT INTO ni (k) VALUES (1)');
  sb.executeSql_("INSERT INTO ns (k) VALUES ('1')");
  const r = sb.executeSql_('SELECT ni.k FROM ni JOIN ns ON ni.k = ns.k');
  assert.strictEqual(r.rowCount, 0);
});

test('hashjoin: DATE列の等値JOINはフォールバックし文字列⇔Date変換の等価性を維持', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE d1 (d DATE, name TEXT)');
  sb.executeSql_('CREATE TABLE d2 (d DATE, memo TEXT)');
  sb.executeSql_("INSERT INTO d1 (d, name) VALUES ('2026-01-15','締切A')");
  sb.executeSql_("INSERT INTO d2 (d, memo) VALUES ('2026-01-15','要対応')");
  const r = sb.executeSql_('SELECT d1.name, d2.memo FROM d1 JOIN d2 ON d1.d = d2.d');
  assert.strictEqual(r.rowCount, 1);
  assert.strictEqual(r.rows[0].memo, '要対応');
});

test('hashjoin: 3テーブルの連鎖JOINとON複合条件(AND)の混在', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t1 (k TEXT)');
  sb.executeSql_('CREATE TABLE t2 (k TEXT, g TEXT)');
  sb.executeSql_('CREATE TABLE t3 (g TEXT, label TEXT)');
  sb.executeSql_("INSERT INTO t1 (k) VALUES ('a'), ('b')");
  sb.executeSql_("INSERT INTO t2 (k, g) VALUES ('a','G1'), ('b','G2')");
  sb.executeSql_("INSERT INTO t3 (g, label) VALUES ('G1','グループ1'), ('G2','グループ2')");
  // t2はハッシュ結合、t3のONは複合条件(AND)なのでネステッドループへフォールバック
  const r = sb.executeSql_(
    "SELECT t1.k, t3.label FROM t1 JOIN t2 ON t1.k = t2.k JOIN t3 ON t2.g = t3.g AND t3.label LIKE 'グループ%' ORDER BY t1.k"
  );
  assert.deepStrictEqual(plain(r.rows), [
    { k: 'a', label: 'グループ1' },
    { k: 'b', label: 'グループ2' }
  ]);
});

// ---------- スキーマキャッシュ整合性 ----------

test('cache: DROP→再CREATE(別スキーマ)後も古い定義が残らない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (old_col TEXT)');
  sb.executeSql_("INSERT INTO t (old_col) VALUES ('x')");
  assert.strictEqual(sb.executeSql_('SELECT old_col FROM t').rowCount, 1);

  sb.executeSql_('DROP TABLE t');
  sb.executeSql_('CREATE TABLE t (new_col INTEGER)');
  sb.executeSql_('INSERT INTO t (new_col) VALUES (7)');

  // 新スキーマで動作し、旧列は参照不可
  assert.strictEqual(sb.executeSql_('SELECT new_col FROM t').rows[0].new_col, 7);
  assert.throws(() => sb.executeSql_('SELECT old_col FROM t'), (err) => err.code === 'NO_SUCH_COLUMN');
  // IDは再CREATEで1から振り直し
  assert.strictEqual(sb.executeSql_('SELECT __id FROM t').rows[0].__id, 1);
});

test('cache: INSERTを跨いでnextIdが正しく進む(キャッシュがID採番を汚染しない)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1)');
  sb.executeSql_('SELECT * FROM t'); // 読み取りでキャッシュを温める
  sb.executeSql_('INSERT INTO t (v) VALUES (2), (3)');
  const r = sb.executeSql_('SELECT __id FROM t ORDER BY __id');
  assert.deepStrictEqual(plain(r.rows.map((x) => x.__id)), [1, 2, 3]);
});
