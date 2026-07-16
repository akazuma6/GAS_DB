'use strict';
/**
 * 過去に検出・修正した不具合の回帰防止テスト。
 * ここに追加した項目は将来のリファクタで再発しないことを保証する。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

// サンドボックス(vm)由来の配列/オブジェクトはプロトタイプが別レルムのため、
// deepStrictEqual の前にホスト側の素のオブジェクトへ変換する。
function plain(v) { return JSON.parse(JSON.stringify(v)); }

test('regression#1: SELECT * / COUNT(*) の "*" トークン誤認識(type "*" vs "OP") を再発させない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1)');
  assert.doesNotThrow(() => sb.executeSql_('SELECT * FROM t'));
  const r = sb.executeSql_('SELECT COUNT(*) AS n FROM t');
  assert.strictEqual(r.rows[0].n, 1);
});

test('regression#2: テーブル修飾列 alias.col の "." トークン誤認識(type "." vs "OP") を再発させない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE a (id TEXT)');
  sb.executeSql_('CREATE TABLE b (id TEXT)');
  sb.executeSql_("INSERT INTO a (id) VALUES ('1')");
  sb.executeSql_("INSERT INTO b (id) VALUES ('1')");
  assert.doesNotThrow(() => sb.executeSql_('SELECT a.id FROM a JOIN b ON a.id = b.id'));
});

test('regression#3: COUNT/SUM/AVG/MIN/MAXがレクサでKEYWORD未登録によりGROUP BY集計が構文エラーになる不具合を再発させない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE sales (region TEXT, amount INTEGER)');
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('東', 100)");
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('東', 200)");
  const r = sb.executeSql_('SELECT region, SUM(amount) AS total, AVG(amount) AS avg, MIN(amount) AS mn, MAX(amount) AS mx FROM sales GROUP BY region');
  assert.strictEqual(r.rows[0].total, 300);
  assert.strictEqual(r.rows[0].avg, 150);
});

test('regression#4: DATE型列とのBETWEEN比較で Date/文字列 型不一致により常にfalseになる不具合を再発させない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE tasks (name TEXT, due_date DATE)');
  sb.executeSql_("INSERT INTO tasks (name, due_date) VALUES ('決算申告','2026-05-31')");
  const r = sb.executeSql_("SELECT name FROM tasks WHERE due_date BETWEEN '2026-01-01' AND '2026-05-31'");
  assert.strictEqual(r.rowCount, 1);
  assert.strictEqual(r.rows[0].name, '決算申告');

  // 等号・大小比較でも同様にDate/文字列比較が機能すること
  const eq = sb.executeSql_("SELECT name FROM tasks WHERE due_date = '2026-05-31'");
  assert.strictEqual(eq.rowCount, 1);
  const lt = sb.executeSql_("SELECT name FROM tasks WHERE due_date < '2026-06-01'");
  assert.strictEqual(lt.rowCount, 1);
});

test('regression#5: 負数リテラルがレクサで「不正な文字: -」になる不具合を再発させない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER, r REAL)');
  sb.executeSql_('INSERT INTO t (v, r) VALUES (-5, -1.5), (3, +2.5)');

  const all = sb.executeSql_('SELECT v, r FROM t ORDER BY v');
  assert.deepStrictEqual(plain(all.rows.map((x) => x.v)), [-5, 3]);
  assert.strictEqual(all.rows[0].r, -1.5);
  assert.strictEqual(all.rows[1].r, 2.5);

  // WHERE / IN / BETWEEN / UPDATE の各所で符号付き数値が使えること
  assert.strictEqual(sb.executeSql_('SELECT v FROM t WHERE v < -1').rowCount, 1);
  assert.strictEqual(sb.executeSql_('SELECT v FROM t WHERE v IN (-5, 99)').rowCount, 1);
  assert.strictEqual(sb.executeSql_('SELECT v FROM t WHERE v BETWEEN -10 AND 0').rowCount, 1);
  sb.executeSql_('UPDATE t SET v = -3 WHERE v = 3');
  assert.strictEqual(sb.executeSql_('SELECT v FROM t WHERE v = -3').rowCount, 1);

  // "--" は引き続きコメントとして扱われること
  const c = sb.executeSql_('SELECT v FROM t -- WHERE v = 999');
  assert.strictEqual(c.rowCount, 2);
});

test('regression#6: GROUP BY 複合キーの結合で (1,12) と (11,2) が同一グループに潰れる衝突を再発させない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE g (a INTEGER, b INTEGER)');
  sb.executeSql_('INSERT INTO g (a, b) VALUES (1, 12), (11, 2), (1, 12)');
  const r = sb.executeSql_('SELECT a, b, COUNT(*) AS n FROM g GROUP BY a, b ORDER BY a');
  assert.strictEqual(r.rowCount, 2);
  assert.deepStrictEqual(plain(r.rows), [
    { a: 1, b: 12, n: 2 },
    { a: 11, b: 2, n: 1 }
  ]);
});

test('regression#7: 実GASでは空セルが \'\' で返るため、NULL格納値の比較がSQLセマンティクスから外れる不具合を再発させない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE n (v INTEGER, w TEXT)');
  sb.executeSql_("INSERT INTO n (v, w) VALUES (NULL, 'x'), (5, 'y')");

  // NULL との比較は常に不成立(= / != いずれも)
  assert.strictEqual(sb.executeSql_('SELECT w FROM n WHERE v != 5').rowCount, 0);
  assert.strictEqual(sb.executeSql_('SELECT w FROM n WHERE v = 5').rowCount, 1);

  // IS NULL / IS NOT NULL では検出できる
  const isnull = sb.executeSql_('SELECT w FROM n WHERE v IS NULL');
  assert.strictEqual(isnull.rowCount, 1);
  assert.strictEqual(isnull.rows[0].w, 'x');
  assert.strictEqual(sb.executeSql_('SELECT w FROM n WHERE v IS NOT NULL').rowCount, 1);

  // SELECT結果でもNULLは(''ではなく)nullとして返る
  const all = sb.executeSql_("SELECT v FROM n WHERE w = 'x'");
  assert.strictEqual(all.rows[0].v, null);
});

test('regression#8: ORDER BY でNULL混在時の順序が非決定的になる不具合を再発させない(NULLは最小値扱い)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE o (v INTEGER)');
  sb.executeSql_('INSERT INTO o (v) VALUES (3), (NULL), (1)');
  const asc = sb.executeSql_('SELECT v FROM o ORDER BY v ASC');
  assert.deepStrictEqual(plain(asc.rows.map((x) => x.v)), [null, 1, 3]);
  const desc = sb.executeSql_('SELECT v FROM o ORDER BY v DESC');
  assert.deepStrictEqual(plain(desc.rows.map((x) => x.v)), [3, 1, null]);
});

test('regression#9: バッチロールバック中に1テーブルの復元が失敗しても残りのテーブルは復元される', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE r1 (v INTEGER)');
  sb.executeSql_('CREATE TABLE r2 (v INTEGER)');
  sb.executeSql_('INSERT INTO r1 (v) VALUES (1)');
  sb.executeSql_('INSERT INTO r2 (v) VALUES (10)');

  // r1 の復元だけ失敗するように restoreTableSnapshot_ を差し替える
  const original = sb.restoreTableSnapshot_;
  sb.restoreTableSnapshot_ = function (tableName, snap) {
    if (tableName === 'r1') throw new Error('simulated restore failure');
    return original(tableName, snap);
  };

  let thrown = null;
  try {
    sb.executeSqlBatch_([
      'UPDATE r1 SET v = 999',
      'UPDATE r2 SET v = 999',
      'SELECT * FROM __no_such_table__',
    ]);
  } catch (e) {
    thrown = e;
  }
  sb.restoreTableSnapshot_ = original;

  assert.ok(thrown, 'バッチは失敗する');
  assert.strictEqual(thrown.rolledBack, false, '一部復元失敗のため rolledBack=false');
  assert.ok(Array.isArray(plain(thrown.rollbackErrors)), 'rollbackErrors が付与される');
  assert.ok(plain(thrown.rollbackErrors)[0].indexOf('r1') === 0, '失敗テーブル名が含まれる');
  // r2 は復元されている(r1の失敗で中断されない)
  assert.strictEqual(sb.executeSql_('SELECT v FROM r2').rows[0].v, 10);
});

test('regression#10: CREATE TABLE IF NOT EXISTS / DROP TABLE IF EXISTS の存在判定はロック内キャッシュ無効化後に行われる', () => {
  const sb = createInitializedSandbox();
  // キャッシュに「テーブル無し」を焼き付けた後、キャッシュを経由しない直接操作でテーブルを作成し、
  // IF NOT EXISTS が古いキャッシュを信じて二重作成 → TABLE_EXISTS エラーにならないことを確認する
  sb.listTables_(); // スキーマキャッシュを温める
  const r1 = sb.executeSql_('CREATE TABLE IF NOT EXISTS c1 (v INTEGER)');
  assert.strictEqual(r1.created, true);
  const r2 = sb.executeSql_('CREATE TABLE IF NOT EXISTS c1 (v INTEGER)');
  assert.strictEqual(r2.alreadyExists, true);

  const d1 = sb.executeSql_('DROP TABLE IF EXISTS c1');
  assert.strictEqual(d1.dropped, true);
  const d2 = sb.executeSql_('DROP TABLE IF EXISTS c1');
  assert.strictEqual(d2.dropped, false);
});
