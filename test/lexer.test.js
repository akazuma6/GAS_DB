'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox } = require('./support/gasMock.js');

test('lexer: 基本トークン(識別子・数値・演算子)', () => {
  const sb = createSandbox();
  const tokens = sb.tokenize_('SELECT a, b FROM t WHERE a = 1');
  const types = tokens.map((t) => t.type);
  assert.deepEqual(types, ['KEYWORD', 'IDENT', ',', 'IDENT', 'KEYWORD', 'IDENT', 'KEYWORD', 'IDENT', 'OP', 'NUMBER', 'EOF']);
});

test('lexer: 文字列リテラル(シングルクォート・エスケープ)', () => {
  const sb = createSandbox();
  const tokens = sb.tokenize_("SELECT 'it''s a pen'");
  const str = tokens.find((t) => t.type === 'STRING');
  assert.strictEqual(str.value, "it's a pen");
});

test('lexer: ダブルクォート識別子', () => {
  const sb = createSandbox();
  const tokens = sb.tokenize_('SELECT "weird col" FROM t');
  assert.strictEqual(tokens[1].type, 'IDENT');
  assert.strictEqual(tokens[1].value, 'weird col');
});

test('lexer: 行コメント(--)は無視される', () => {
  const sb = createSandbox();
  const tokens = sb.tokenize_('SELECT 1 -- これはコメント\nFROM t');
  const types = tokens.map((t) => t.type);
  assert.ok(!types.includes('STRING'));
  assert.deepEqual(types, ['KEYWORD', 'NUMBER', 'KEYWORD', 'IDENT', 'EOF']);
});

test('lexer: 複合比較演算子(!= <> <= >=)', () => {
  const sb = createSandbox();
  const vals = sb.tokenize_('a != 1 AND b <> 2 AND c <= 3 AND d >= 4').filter((t) => t.type === 'OP').map((t) => t.value);
  assert.deepEqual(vals, ['!=', '!=', '<=', '>=']);
});

test('lexer: 日本語識別子(漢字/かな/カナ)をIDENTとして認識する', () => {
  const sb = createSandbox();
  const tokens = sb.tokenize_('SELECT * FROM 顧客マスタ WHERE 都道府県 = 東京都');
  const idents = tokens.filter((t) => t.type === 'IDENT').map((t) => t.value);
  assert.deepEqual(idents, ['顧客マスタ', '都道府県', '東京都']);
});

test('lexer: 数値(小数)', () => {
  const sb = createSandbox();
  const tokens = sb.tokenize_('SELECT 3.14');
  assert.strictEqual(tokens[1].type, 'NUMBER');
  assert.strictEqual(tokens[1].value, 3.14);
});

test('lexer: 未終端の文字列リテラルはSyntaxErrorになる', () => {
  const sb = createSandbox();
  assert.throws(() => sb.tokenize_("SELECT 'abc"), (err) => err instanceof sb.SqlError && err.code === 'SYNTAX_ERROR');
});

test('lexer: 不正な文字はSyntaxErrorになる', () => {
  const sb = createSandbox();
  assert.throws(() => sb.tokenize_('SELECT a # b'), (err) => err instanceof sb.SqlError && err.code === 'SYNTAX_ERROR');
});
