'use strict';
/**
 * 複雑クエリの複合テストと、ロールバックの高負荷・境界シナリオ。
 * 業務シナリオ(顧客マスタ/進捗管理 風)に近いデータで、複数機能の組み合わせを検証する。
 */
const test = require('node:test');
const assert = require('node:assert');
const { createInitializedSandbox } = require('./support/gasMock.js');

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function post(sb, key, body) {
  const payload = Object.assign({ apiKey: key }, body);
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(payload) } })._text);
}

function seedOffice(sb) {
  sb.executeSql_('CREATE TABLE 顧客マスタ (customer_code TEXT, name TEXT, pref TEXT, contract_type TEXT)');
  sb.executeSql_('CREATE TABLE 進捗管理 (customer_code TEXT, task_name TEXT, status TEXT, due_date DATE, hours REAL)');
  sb.executeSql_(
    "INSERT INTO 顧客マスタ (customer_code, name, pref, contract_type) VALUES " +
    "('C001','鈴木商事','東京都','顧問'), ('C002','山田工業','大阪府','顧問'), " +
    "('C003','佐藤建設','東京都','スポット'), ('C004','田中物産','東京都','顧問')"
  );
  sb.executeSql_(
    "INSERT INTO 進捗管理 (customer_code, task_name, status, due_date, hours) VALUES " +
    "('C001','決算申告','完了','2026-05-31',10.5), ('C001','月次監査','進行中','2026-07-15',2.0), " +
    "('C002','決算申告','進行中','2026-08-31',4.0), ('C002','年末調整','未着手','2026-12-20',0), " +
    "('C003','記帳代行','完了','2026-06-30',6.5), ('C001','年末調整','未着手','2026-12-20',0)"
  );
  return sb;
}

// ---------- 複雑クエリ ----------

test('complex: JOIN + サブクエリIN + GROUP BY + HAVING + 集計ORDER BY + LIMIT の複合', () => {
  const sb = seedOffice(createInitializedSandbox());
  // 「未完了タスクを持つ顧客」のうち、タスク2件以上の顧客を件数降順で
  const r = sb.executeSql_(
    "SELECT c.name, COUNT(*) AS task_count, SUM(p.hours) AS total_hours " +
    "FROM 顧客マスタ c JOIN 進捗管理 p ON c.customer_code = p.customer_code " +
    "WHERE c.customer_code IN (SELECT customer_code FROM 進捗管理 WHERE status != '完了') " +
    "GROUP BY c.name " +
    "HAVING COUNT(*) >= 2 " +
    "ORDER BY COUNT(*) DESC, c.name LIMIT 5"
  );
  assert.deepStrictEqual(plain(r.rows), [
    { name: '鈴木商事', task_count: 3, total_hours: 12.5 },
    { name: '山田工業', task_count: 2, total_hours: 4 }
  ]);
});

test('complex: LEFT JOIN + IS NULL によるアンチジョイン(タスクが1件もない顧客)', () => {
  const sb = seedOffice(createInitializedSandbox());
  const r = sb.executeSql_(
    'SELECT DISTINCT c.name FROM 顧客マスタ c ' +
    'LEFT JOIN 進捗管理 p ON c.customer_code = p.customer_code ' +
    'WHERE p.customer_code IS NULL'
  );
  assert.deepStrictEqual(plain(r.rows), [{ name: '田中物産' }]);
});

test('complex: スカラーサブクエリ + 算術式 + BETWEEN + LIKE 日本語の混合WHERE', () => {
  const sb = seedOffice(createInitializedSandbox());
  // 平均工数の2倍を超えるタスク、かつ期日が上期、かつタスク名が「決算」で始まる
  const r = sb.executeSql_(
    "SELECT task_name, hours FROM 進捗管理 " +
    "WHERE hours > (SELECT AVG(hours) FROM 進捗管理) * 2 " +
    "AND due_date BETWEEN '2026-01-01' AND '2026-06-30' " +
    "AND task_name LIKE '決算%'"
  );
  assert.deepStrictEqual(plain(r.rows), [{ task_name: '決算申告', hours: 10.5 }]);
});

test('complex: COUNT(DISTINCT) と AVG(算術式) の集計', () => {
  const sb = seedOffice(createInitializedSandbox());
  const r = sb.executeSql_(
    'SELECT COUNT(DISTINCT customer_code) AS customers, AVG(hours * 60) AS avg_minutes FROM 進捗管理'
  );
  assert.strictEqual(r.rows[0].customers, 3);
  assert.strictEqual(r.rows[0].avg_minutes, 230); // (10.5+2+4+0+6.5+0)*60/6
});

test('complex: JOINクエリ同士のUNION + 全体ORDER BY/LIMIT', () => {
  const sb = seedOffice(createInitializedSandbox());
  const r = sb.executeSql_(
    "SELECT c.name, p.task_name FROM 顧客マスタ c JOIN 進捗管理 p ON c.customer_code = p.customer_code WHERE p.status = '完了' " +
    "UNION " +
    "SELECT c.name, p.task_name FROM 顧客マスタ c JOIN 進捗管理 p ON c.customer_code = p.customer_code WHERE p.hours > 3 " +
    "ORDER BY name, task_name LIMIT 3"
  );
  assert.deepStrictEqual(plain(r.rows), [
    { name: '佐藤建設', task_name: '記帳代行' },
    { name: '山田工業', task_name: '決算申告' },
    { name: '鈴木商事', task_name: '決算申告' }
  ]);
});

test('complex: 3テーブルJOIN + GROUP BY + 式ORDER BY + OFFSETページング', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE staff (code TEXT, name TEXT)');
  sb.executeSql_('CREATE TABLE assign (staff_code TEXT, customer_code TEXT)');
  sb.executeSql_('CREATE TABLE bill (customer_code TEXT, amount INTEGER)');
  sb.executeSql_("INSERT INTO staff (code, name) VALUES ('S1','担当A'), ('S2','担当B')");
  sb.executeSql_("INSERT INTO assign (staff_code, customer_code) VALUES ('S1','C1'), ('S1','C2'), ('S2','C3')");
  sb.executeSql_("INSERT INTO bill (customer_code, amount) VALUES ('C1',100), ('C1',50), ('C2',200), ('C3',30)");

  const page = (offset) => sb.executeSql_(
    'SELECT s.name, SUM(b.amount) AS total ' +
    'FROM staff s JOIN assign a ON s.code = a.staff_code JOIN bill b ON a.customer_code = b.customer_code ' +
    'GROUP BY s.name ORDER BY SUM(b.amount) DESC LIMIT 1 OFFSET ' + offset
  );
  assert.deepStrictEqual(plain(page(0).rows), [{ name: '担当A', total: 350 }]);
  assert.deepStrictEqual(plain(page(1).rows), [{ name: '担当B', total: 30 }]);
});

test('complex: 1,000行超の一括INSERT(実GASのグリッド上限を跨ぐ)と横断集計', () => {
  const sb = createInitializedSandbox();
  sb.executeSql_('CREATE TABLE big (v INTEGER)');
  const tuples = [];
  for (let i = 1; i <= 1500; i++) tuples.push('(' + i + ')');
  // 実GASの新規シートは1,000行グリッド。書き込み前の自動拡張が無いと out of bounds になる
  sb.executeSql_('INSERT INTO big (v) VALUES ' + tuples.join(','));
  const r = sb.executeSql_('SELECT COUNT(*) AS n, SUM(v) AS s FROM big WHERE v > 500');
  assert.strictEqual(r.rows[0].n, 1000);
  assert.strictEqual(r.rows[0].s, (501 + 1500) * 1000 / 2);
});

// ---------- ロールバック(境界・高負荷シナリオ) ----------

test('rollback: シャード分割を跨いだINSERTのロールバックで新規シャードシートごと消える', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.createTable_('t', [{ name: 'v', type: 'INTEGER' }], 3); // 閾値3で分割しやすく
  sb.executeSql_('INSERT INTO t (v) VALUES (1), (2)');
  assert.deepStrictEqual(plain(sb.getTableSchema_('t').shards), ['t__1']);

  const res = post(sb, key, {
    sqls: [
      'INSERT INTO t (v) VALUES (3), (4), (5), (6), (7), (8)', // t__2, t__3 が新規作成される
      'SELECT * FROM missing_table' // 失敗
    ]
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.rolledBack, true);

  // シャード構成・データ・シートの物理実体すべてがバッチ前へ復元されている
  assert.deepStrictEqual(plain(sb.getTableSchema_('t').shards), ['t__1']);
  assert.strictEqual(sb.getDb_().getSheetByName('t__2'), null);
  assert.strictEqual(sb.getDb_().getSheetByName('t__3'), null);
  assert.deepStrictEqual(plain(sb.executeSql_('SELECT v FROM t ORDER BY v').rows.map((x) => x.v)), [1, 2]);
});

test('rollback: 複数シャードにまたがる全件UPDATE+DELETEの完全復元(数百行の一致検証)', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.createTable_('t', [{ name: 'v', type: 'INTEGER' }, { name: 's', type: 'TEXT' }], 50); // 300行 → 6シャード
  const objs = [];
  for (let i = 1; i <= 300; i++) objs.push({ v: i, s: 'row' + i });
  sb.appendRows_('t', objs);
  const before = plain(sb.executeSql_('SELECT __id, v, s FROM t ORDER BY __id').rows);

  const res = post(sb, key, {
    sqls: [
      "UPDATE t SET s = 'changed', v = v * 10", // 全300行更新(全シャード)
      'DELETE FROM t WHERE v <= 1500',           // 150行削除
      "INSERT INTO t (v, s) VALUES (-1, 'x')",
      'DROP TABLE nonexistent'                    // 失敗
    ]
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.statementIndex, 3);
  assert.strictEqual(res.rolledBack, true);

  const after = plain(sb.executeSql_('SELECT __id, v, s FROM t ORDER BY __id').rows);
  assert.deepStrictEqual(after, before); // 300行完全一致
});

test('rollback: 先頭文で失敗した場合も安全(スナップショット不要ケース)', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  const res = post(sb, key, { sqls: ['INSERT INTO t (v) VALUES (broken', 'INSERT INTO t (v) VALUES (1)'] });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.statementIndex, 0);
  assert.strictEqual(res.rolledBack, true);
  assert.strictEqual(sb.executeSql_('SELECT * FROM t').rowCount, 0);
});

test('rollback: バッチ内 DROP→再CREATE(別定義)→INSERT の失敗で元テーブルへ完全復帰', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (orig TEXT)');
  sb.executeSql_("INSERT INTO t (orig) VALUES ('original-1'), ('original-2')");

  const res = post(sb, key, {
    sqls: [
      'DROP TABLE t',
      'CREATE TABLE t (renewed INTEGER)',
      'INSERT INTO t (renewed) VALUES (1)',
      'SELECT orig FROM t' // 新定義に orig は無い → NO_SUCH_COLUMN で失敗
    ]
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.code, 'NO_SUCH_COLUMN');
  assert.strictEqual(res.rolledBack, true);

  // 旧定義・旧データ・採番が復元されている
  const rows = sb.executeSql_('SELECT __id, orig FROM t ORDER BY __id');
  assert.deepStrictEqual(plain(rows.rows), [
    { __id: 1, orig: 'original-1' },
    { __id: 2, orig: 'original-2' }
  ]);
  sb.executeSql_("INSERT INTO t (orig) VALUES ('original-3')");
  assert.strictEqual(sb.executeSql_('SELECT __id FROM t ORDER BY __id DESC LIMIT 1').rows[0].__id, 3);
});

test('rollback: 失敗バッチの直後に成功バッチを実行しても状態が汚染されない', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (v INTEGER)');

  const fail = post(sb, key, { sqls: ['INSERT INTO t (v) VALUES (1)', 'BROKEN SQL'] });
  assert.strictEqual(fail.success, false);
  assert.strictEqual(fail.rolledBack, true);

  const ok = post(sb, key, { sqls: ['INSERT INTO t (v) VALUES (10)', 'INSERT INTO t (v) VALUES (20)'] });
  assert.strictEqual(ok.success, true);

  const rows = sb.executeSql_('SELECT __id, v FROM t ORDER BY __id');
  // 失敗バッチのIDは採番ごと巻き戻るため、成功バッチが 1, 2 を使う
  assert.deepStrictEqual(plain(rows.rows), [
    { __id: 1, v: 10 },
    { __id: 2, v: 20 }
  ]);
});

test('rollback: 更新系と読み取り系が混在するバッチで、読み取り結果は当時の中間状態を反映しつつ全て巻き戻る', () => {
  const sb = createInitializedSandbox();
  const key = sb.issueApiKey_('c1');
  sb.executeSql_('CREATE TABLE t (v INTEGER)');
  sb.executeSql_('INSERT INTO t (v) VALUES (1)');

  const res = post(sb, key, {
    sqls: [
      'INSERT INTO t (v) VALUES (2)',
      'SELECT COUNT(*) AS n FROM t', // この時点では2行見える(はず)だが…
      'DELETE FROM t',
      'INSERT INTO t (bad_col) VALUES (0)' // 失敗 → 全ロールバック
    ]
  });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.statementIndex, 3);

  // 中間のDELETEも含めて巻き戻り、バッチ前の1行だけが残る
  assert.deepStrictEqual(plain(sb.executeSql_('SELECT v FROM t').rows), [{ v: 1 }]);
});
