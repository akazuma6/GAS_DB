'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

function seedCustomers(sb) {
  sb.executeSql_('CREATE TABLE customers (code TEXT, name TEXT, pref TEXT, age INTEGER)');
  sb.executeSql_("INSERT INTO customers (code, name, pref, age) VALUES ('C001','鈴木商事','東京都',40)");
  sb.executeSql_("INSERT INTO customers (code, name, pref, age) VALUES ('C002','山田工業','大阪府',25)");
  sb.executeSql_("INSERT INTO customers (code, name, pref, age) VALUES ('C003','佐藤建設','東京都',NULL)");
  return sb;
}

test('executor: WHERE 比較演算子一式', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age = 40').rowCount, 1);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age != 40').rowCount, 1); // NULLは真にならない
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age > 25').rowCount, 1);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age >= 25').rowCount, 2);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age < 40').rowCount, 1);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age <= 25').rowCount, 1);
});

test('executor: WHERE AND / OR / NOT', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  assert.strictEqual(sb.executeSql_("SELECT * FROM customers WHERE pref = '東京都' AND age = 40").rowCount, 1);
  assert.strictEqual(sb.executeSql_("SELECT * FROM customers WHERE pref = '大阪府' OR age = 40").rowCount, 2);
  assert.strictEqual(sb.executeSql_("SELECT * FROM customers WHERE NOT pref = '東京都'").rowCount, 1);
});

test('executor: LIKE(前方一致/部分一致)', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  assert.strictEqual(sb.executeSql_("SELECT * FROM customers WHERE name LIKE '鈴木%'").rowCount, 1);
  assert.strictEqual(sb.executeSql_("SELECT * FROM customers WHERE name LIKE '%工業'").rowCount, 1);
  assert.strictEqual(sb.executeSql_("SELECT * FROM customers WHERE name LIKE '%建%'").rowCount, 1);
});

test('executor: IN / NOT IN', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  assert.strictEqual(sb.executeSql_("SELECT * FROM customers WHERE code IN ('C001','C003')").rowCount, 2);
  assert.strictEqual(sb.executeSql_("SELECT * FROM customers WHERE code NOT IN ('C001','C003')").rowCount, 1);
});

test('executor: IS NULL / IS NOT NULL', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age IS NULL').rowCount, 1);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age IS NOT NULL').rowCount, 2);
});

test('executor: BETWEEN(数値・日付)', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers WHERE age BETWEEN 20 AND 30').rowCount, 1);

  sb.executeSql_('CREATE TABLE tasks (name TEXT, due_date DATE)');
  sb.executeSql_("INSERT INTO tasks (name, due_date) VALUES ('決算申告','2026-05-31')");
  sb.executeSql_("INSERT INTO tasks (name, due_date) VALUES ('年末調整','2026-01-15')");
  const r = sb.executeSql_("SELECT name FROM tasks WHERE due_date BETWEEN '2026-01-01' AND '2026-05-31'");
  assert.strictEqual(r.rowCount, 2);
});

test('executor: INNER JOIN / LEFT JOIN', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  sb.executeSql_('CREATE TABLE orders (code TEXT, item TEXT)');
  sb.executeSql_("INSERT INTO orders (code, item) VALUES ('C001','商品A')");

  const inner = sb.executeSql_('SELECT c.name, o.item FROM customers c JOIN orders o ON c.code = o.code');
  assert.strictEqual(inner.rowCount, 1);
  assert.strictEqual(inner.rows[0].name, '鈴木商事');

  const left = sb.executeSql_('SELECT c.code, o.item FROM customers c LEFT JOIN orders o ON c.code = o.code ORDER BY c.code');
  assert.strictEqual(left.rowCount, 3);
  assert.strictEqual(left.rows[1].item, null); // C002はマッチなし
});

test('executor: GROUP BY + 集計関数(COUNT/SUM/AVG/MIN/MAX)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE sales (region TEXT, amount INTEGER)');
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('東','100')");
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('東','300')");
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('西','50')");

  const r = sb.executeSql_('SELECT region, COUNT(*) AS n, SUM(amount) AS total, AVG(amount) AS avg, MIN(amount) AS mn, MAX(amount) AS mx FROM sales GROUP BY region ORDER BY region');
  assert.strictEqual(r.rowCount, 2);
  const east = r.rows.find((x) => x.region === '東');
  assert.strictEqual(east.n, 2);
  assert.strictEqual(east.total, 400);
  assert.strictEqual(east.avg, 200);
  assert.strictEqual(east.mn, 100);
  assert.strictEqual(east.mx, 300);
});

test('executor: HAVING(集計式で絞り込み)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE sales (region TEXT, amount INTEGER)');
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('東','100')");
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('東','300')");
  sb.executeSql_("INSERT INTO sales (region, amount) VALUES ('西','50')");
  const r = sb.executeSql_('SELECT region, COUNT(*) AS n FROM sales GROUP BY region HAVING COUNT(*) > 1');
  assert.strictEqual(r.rowCount, 1);
  assert.strictEqual(r.rows[0].region, '東');
});

test('executor: GROUP BY無しでも集計関数のみなら1行返す(空集合含む)', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE empty_t (v INTEGER)');
  const r = sb.executeSql_('SELECT COUNT(*) AS n, SUM(v) AS s FROM empty_t');
  assert.strictEqual(r.rowCount, 1);
  assert.strictEqual(r.rows[0].n, 0);
  assert.strictEqual(r.rows[0].s, 0);
});

test('executor: ORDER BY 複数キー・ASC/DESC', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (a INTEGER, b INTEGER)');
  sb.executeSql_('INSERT INTO t (a, b) VALUES (1, 2)');
  sb.executeSql_('INSERT INTO t (a, b) VALUES (1, 1)');
  sb.executeSql_('INSERT INTO t (a, b) VALUES (0, 9)');
  const r = sb.executeSql_('SELECT a, b FROM t ORDER BY a DESC, b ASC');
  assert.deepEqual(r.rows.map((x) => [x.a, x.b]), [[1, 1], [1, 2], [0, 9]]);
});

test('executor: LIMIT / OFFSET', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  for (let i = 1; i <= 5; i++) sb.executeSql_(`INSERT INTO t (v) VALUES (${i})`);
  const r = sb.executeSql_('SELECT v FROM t ORDER BY v LIMIT 2 OFFSET 2');
  assert.deepEqual(r.rows.map((x) => x.v), [3, 4]);
});

test('executor: DISTINCT', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (v TEXT)');
  sb.executeSql_("INSERT INTO t (v) VALUES ('a')");
  sb.executeSql_("INSERT INTO t (v) VALUES ('a')");
  sb.executeSql_("INSERT INTO t (v) VALUES ('b')");
  const r = sb.executeSql_('SELECT DISTINCT v FROM t');
  assert.strictEqual(r.rowCount, 2);
});

test('executor: UPDATE(部分一致・全件・存在しない列でエラー)', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  const r1 = sb.executeSql_("UPDATE customers SET pref = '神奈川県' WHERE code = 'C002'");
  assert.strictEqual(r1.updatedCount, 1);
  assert.strictEqual(sb.executeSql_("SELECT pref FROM customers WHERE code = 'C002'").rows[0].pref, '神奈川県');

  const r2 = sb.executeSql_("UPDATE customers SET pref = '不明'");
  assert.strictEqual(r2.updatedCount, 3);
});

test('executor: DELETE(条件付き・全件)', () => {
  const sb = createInitializedSandbox();
  seedCustomers(sb);
  const r1 = sb.executeSql_("DELETE FROM customers WHERE pref = '東京都'");
  assert.strictEqual(r1.deletedCount, 2);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers').rowCount, 1);

  const r2 = sb.executeSql_('DELETE FROM customers');
  assert.strictEqual(r2.deletedCount, 1);
  assert.strictEqual(sb.executeSql_('SELECT * FROM customers').rowCount, 0);
});

test('executor: INSERT 列数不一致はCOLUMN_COUNT_MISMATCH', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (a TEXT, b TEXT)');
  assert.throws(
    () => sb.executeSql_("INSERT INTO t (a, b) VALUES ('x')"),
    (err) => err instanceof sb.SqlError && err.code === 'COLUMN_COUNT_MISMATCH'
  );
});

test('executor: 存在しないテーブル/列の参照はエラー', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (a TEXT)');
  assert.throws(() => sb.executeSql_('SELECT * FROM nope'), (err) => err.code === 'NO_SUCH_TABLE');
  assert.throws(() => sb.executeSql_('SELECT nope_col FROM t'), (err) => err.code === 'NO_SUCH_COLUMN');
});

test('executor: あいまいな列参照(複数テーブルに同名列)はAMBIGUOUS_COLUMN', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE a (id TEXT, v TEXT)');
  sb.executeSql_('CREATE TABLE b (id TEXT, v TEXT)');
  sb.executeSql_("INSERT INTO a (id, v) VALUES ('1','x')");
  sb.executeSql_("INSERT INTO b (id, v) VALUES ('1','y')");
  assert.throws(
    () => sb.executeSql_('SELECT v FROM a JOIN b ON a.id = b.id'),
    (err) => err instanceof sb.SqlError && err.code === 'AMBIGUOUS_COLUMN'
  );
});

test('executor: 未対応の列型はUNKNOWN_TYPE', () => {
  const sb = createInitializedSandbox();
  assert.throws(
    () => sb.executeSql_('CREATE TABLE t (a FOOBAR)'),
    (err) => err instanceof sb.SqlError && err.code === 'UNKNOWN_TYPE'
  );
});

test('executor: CREATE TABLE IF NOT EXISTS は既存テーブルに対して何もしない', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE t (a TEXT)');
  sb.executeSql_("INSERT INTO t (a) VALUES ('keep')");
  const r = sb.executeSql_('CREATE TABLE IF NOT EXISTS t (a TEXT)');
  assert.strictEqual(r.alreadyExists, true);
  assert.strictEqual(sb.executeSql_('SELECT * FROM t').rowCount, 1);
});
