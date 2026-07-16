'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox } = require('./support/gasMock.js');

function parse(sb, sql) { return sb.parseSql_(sql); }

test('parser: SELECT * FROM t', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT * FROM t');
  assert.strictEqual(ast.type, 'SELECT');
  assert.deepEqual(ast.columns, [{ star: true }]);
  assert.deepEqual(ast.from, { name: 't', alias: 't' });
  assert.deepEqual(ast.joins, []);
  assert.strictEqual(ast.where, null);
});

test('parser: SELECT列リスト(通常列・AS別名)', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT a, b AS bb FROM t');
  assert.strictEqual(ast.columns.length, 2);
  assert.deepEqual(ast.columns[0].expr, { type: 'column', table: null, name: 'a' });
  assert.strictEqual(ast.columns[0].alias, undefined);
  assert.deepEqual(ast.columns[1].expr, { type: 'column', table: null, name: 'b' });
  assert.strictEqual(ast.columns[1].alias, 'bb');
});

test('parser: COUNT(*) を集計ノードとして解析する', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT COUNT(*) AS cnt FROM t');
  assert.deepEqual(ast.columns[0].expr, { type: 'agg', func: 'COUNT', argStar: true, arg: null, distinctArg: false });
  assert.strictEqual(ast.columns[0].alias, 'cnt');
});

test('parser: SUM(DISTINCT col) を解析する', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT SUM(DISTINCT a) AS total FROM t');
  const expr = ast.columns[0].expr;
  assert.strictEqual(expr.type, 'agg');
  assert.strictEqual(expr.func, 'SUM');
  assert.strictEqual(expr.distinctArg, true);
  assert.deepEqual(expr.arg, { type: 'column', table: null, name: 'a' });
});

test('parser: テーブル修飾列参照 alias.col', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT a.x FROM t a');
  assert.deepEqual(ast.columns[0].expr, { type: 'column', table: 'a', name: 'x' });
  assert.deepEqual(ast.from, { name: 't', alias: 'a' });
});

test('parser: JOIN / LEFT JOIN', () => {
  const sb = createSandbox();
  const ast1 = parse(sb, 'SELECT * FROM a JOIN b ON a.id = b.id');
  assert.strictEqual(ast1.joins.length, 1);
  assert.strictEqual(ast1.joins[0].joinType, 'INNER');
  assert.deepEqual(ast1.joins[0].table, { name: 'b', alias: 'b' });

  const ast2 = parse(sb, 'SELECT * FROM a LEFT JOIN b ON a.id = b.id');
  assert.strictEqual(ast2.joins[0].joinType, 'LEFT');

  const ast3 = parse(sb, 'SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id');
  assert.strictEqual(ast3.joins[0].joinType, 'LEFT');
});

test('parser: WHERE IN / NOT IN', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT * FROM t WHERE a IN (1, 2, 3)');
  assert.strictEqual(ast.where.type, 'in');
  assert.strictEqual(ast.where.negate, false);
  assert.strictEqual(ast.where.list.length, 3);

  const astNot = parse(sb, 'SELECT * FROM t WHERE a NOT IN (1, 2)');
  assert.strictEqual(astNot.where.type, 'in');
  assert.strictEqual(astNot.where.negate, true);
});

test('parser: WHERE BETWEEN / NOT BETWEEN', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT * FROM t WHERE a BETWEEN 1 AND 10');
  assert.strictEqual(ast.where.type, 'between');
  assert.strictEqual(ast.where.negate, false);

  const astNot = parse(sb, 'SELECT * FROM t WHERE a NOT BETWEEN 1 AND 10');
  assert.strictEqual(astNot.where.negate, true);
});

test('parser: WHERE LIKE / NOT LIKE', () => {
  const sb = createSandbox();
  const ast = parse(sb, "SELECT * FROM t WHERE a LIKE '%x%'");
  assert.strictEqual(ast.where.type, 'like');

  const astNot = parse(sb, "SELECT * FROM t WHERE a NOT LIKE '%x%'");
  assert.strictEqual(astNot.where.type, 'not');
  assert.strictEqual(astNot.where.expr.type, 'like');
});

test('parser: WHERE IS NULL / IS NOT NULL', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT * FROM t WHERE a IS NULL');
  assert.strictEqual(ast.where.type, 'isnull');
  assert.strictEqual(ast.where.negate, false);

  const ast2 = parse(sb, 'SELECT * FROM t WHERE a IS NOT NULL');
  assert.strictEqual(ast2.where.negate, true);
});

test('parser: GROUP BY / HAVING(集計式含む) / ORDER BY / LIMIT OFFSET', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'SELECT c, COUNT(*) AS n FROM t GROUP BY c HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 5 OFFSET 10');
  assert.strictEqual(ast.groupBy.length, 1);
  assert.strictEqual(ast.having.type, 'binary');
  assert.strictEqual(ast.having.left.type, 'agg');
  assert.strictEqual(ast.orderBy[0].dir, 'DESC');
  assert.strictEqual(ast.limit, 5);
  assert.strictEqual(ast.offset, 10);
});

test('parser: INSERT INTO(列指定あり)', () => {
  const sb = createSandbox();
  const ast = parse(sb, "INSERT INTO t (a, b) VALUES (1, 'x')");
  assert.strictEqual(ast.type, 'INSERT');
  assert.deepEqual(ast.columns, ['a', 'b']);
  assert.deepEqual(ast.valueRows, [[{ type: 'literal', value: 1 }, { type: 'literal', value: 'x' }]]);
});

test('parser: INSERT INTO 複数行VALUES', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'INSERT INTO t (a) VALUES (1), (2), (3)');
  assert.strictEqual(ast.valueRows.length, 3);
});

test('parser: UPDATE ... SET ... WHERE', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'UPDATE t SET a = 1, b = 2 WHERE c = 3');
  assert.strictEqual(ast.type, 'UPDATE');
  assert.strictEqual(ast.assignments.length, 2);
  assert.strictEqual(ast.where.type, 'binary');
});

test('parser: DELETE FROM ... WHERE', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'DELETE FROM t WHERE a = 1');
  assert.strictEqual(ast.type, 'DELETE');
  assert.strictEqual(ast.table, 't');
});

test('parser: CREATE TABLE(型・PRIMARY KEY)', () => {
  const sb = createSandbox();
  const ast = parse(sb, 'CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
  assert.strictEqual(ast.type, 'CREATE_TABLE');
  assert.deepEqual(ast.columns[0], { name: 'a', type: 'INTEGER', primaryKey: true });
  assert.deepEqual(ast.columns[1], { name: 'b', type: 'TEXT', primaryKey: false });
});

test('parser: CREATE TABLE IF NOT EXISTS / DROP TABLE IF EXISTS', () => {
  const sb = createSandbox();
  const ast1 = parse(sb, 'CREATE TABLE IF NOT EXISTS t (a TEXT)');
  assert.strictEqual(ast1.ifNotExists, true);
  const ast2 = parse(sb, 'DROP TABLE IF EXISTS t');
  assert.strictEqual(ast2.type, 'DROP_TABLE');
  assert.strictEqual(ast2.ifExists, true);
});

test('parser: 末尾セミコロンは許容される', () => {
  const sb = createSandbox();
  assert.doesNotThrow(() => parse(sb, 'SELECT * FROM t;'));
});

test('parser: FROM句が無いSELECTはSyntaxError', () => {
  const sb = createSandbox();
  assert.throws(() => parse(sb, 'SELECT a WHERE b = 1'), (err) => err instanceof sb.SqlError && err.code === 'SYNTAX_ERROR');
});

test('parser: 未対応の文はSyntaxError', () => {
  const sb = createSandbox();
  assert.throws(() => parse(sb, 'MERGE INTO t'), (err) => err instanceof sb.SqlError && err.code === 'SYNTAX_ERROR');
});
