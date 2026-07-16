/**
 * SQL構文解析器(再帰下降パーサー)。tokenize_() のトークン列からASTを構築する。
 * サポート範囲: SELECT(WHERE/JOIN/GROUP BY/HAVING/ORDER BY/LIMIT/OFFSET/集計関数),
 *              INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE。
 */

var AGG_FUNCS_ = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];

function parseSql_(sql, params) {
  var tokens = bindParams_(tokenize_(sql), params);
  var p = new Parser_(tokens);
  var stmt = p.parseStatement();
  p.matchType(';');
  p.expectType('EOF');
  return stmt;
}

/**
 * `?` プレースホルダ(PARAMトークン)を params 配列の値でリテラルトークンへ置換する。
 * 値はトークンとして埋め込まれるため、文字列にSQL断片(' OR 1=1 等)が含まれていても
 * 構文として解釈されることはない(SQLインジェクション不能)。
 * プレースホルダ数と params 数の不一致は BAD_REQUEST。
 */
function bindParams_(tokens, params) {
  var placeholderCount = 0;
  for (var i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'PARAM') placeholderCount++;
  }
  var list = (params === undefined || params === null) ? [] : params;
  if (!Array.isArray(list)) throw new SqlError('BAD_REQUEST', 'params は配列で指定すること');
  if (placeholderCount !== list.length) {
    throw new SqlError('BAD_REQUEST', '? プレースホルダ数(' + placeholderCount + ')と params 数(' + list.length + ')が不一致');
  }
  if (placeholderCount === 0) return tokens;
  var idx = 0;
  return tokens.map(function (t) {
    return t.type === 'PARAM' ? paramToToken_(list[idx++], idx) : t;
  });
}

function paramToToken_(v, position) {
  if (v === null) return { type: 'KEYWORD', value: 'NULL' };
  if (typeof v === 'boolean') return { type: 'KEYWORD', value: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'number') {
    if (!isFinite(v)) throw new SqlError('BAD_REQUEST', 'params[' + (position - 1) + '] が有限数値でない: ' + v);
    return { type: 'NUMBER', value: v };
  }
  if (typeof v === 'string') return { type: 'STRING', value: v };
  throw new SqlError('BAD_REQUEST', 'params[' + (position - 1) + '] の型が未対応(string/number/boolean/nullのみ): ' + typeof v);
}

function Parser_(tokens) {
  this.tokens = tokens;
  this.pos = 0;
}

Parser_.prototype.peek = function () { return this.tokens[this.pos]; };
Parser_.prototype.next = function () { return this.tokens[this.pos++]; };

Parser_.prototype.isKeyword = function (kw) {
  var t = this.peek();
  return t.type === 'KEYWORD' && t.value === kw;
};

Parser_.prototype.matchKeyword = function (kw) {
  if (this.isKeyword(kw)) { this.pos++; return true; }
  return false;
};

Parser_.prototype.expectKeyword = function (kw) {
  if (!this.matchKeyword(kw)) {
    throw new SqlError('SYNTAX_ERROR', kw + ' が必要 (位置 ' + this.pos + ', 実際: ' + JSON.stringify(this.peek()) + ')');
  }
};

Parser_.prototype.matchType = function (type, value) {
  var t = this.peek();
  if (t.type === type && (value === undefined || t.value === value)) { this.pos++; return t; }
  return null;
};

Parser_.prototype.expectType = function (type, value) {
  var t = this.matchType(type, value);
  if (!t) {
    throw new SqlError('SYNTAX_ERROR', type + (value ? '(' + value + ')' : '') + ' が必要 (実際: ' + JSON.stringify(this.peek()) + ')');
  }
  return t;
};

Parser_.prototype.expectIdent = function () {
  var t = this.expectType('IDENT');
  return t.value;
};

// ---------- Statement ----------

Parser_.prototype.parseStatement = function () {
  if (this.isKeyword('SELECT')) return this.parseSelect();
  if (this.isKeyword('INSERT')) return this.parseInsert();
  if (this.isKeyword('UPDATE')) return this.parseUpdate();
  if (this.isKeyword('DELETE')) return this.parseDelete();
  if (this.isKeyword('CREATE')) return this.parseCreateTable();
  if (this.isKeyword('DROP')) return this.parseDropTable();
  throw new SqlError('SYNTAX_ERROR', '未対応のSQL文: ' + JSON.stringify(this.peek()));
};

// ---------- SELECT ----------

/**
 * SELECT文(UNION連結含む)を解析する。
 * 単一SELECTなら従来通り type:'SELECT' ノード、UNION連結なら type:'UNION' ノードを返す。
 * ORDER BY / LIMIT / OFFSET は複合クエリ全体の末尾句として解析する(SQL標準準拠)。
 */
Parser_.prototype.parseSelect = function () {
  var first = this.parseSelectCore_();
  if (!this.isKeyword('UNION')) {
    var tail = this.parseSelectTail_();
    first.orderBy = tail.orderBy;
    first.limit = tail.limit;
    first.offset = tail.offset;
    return first;
  }
  var selects = [first];
  var alls = []; // alls[i] = selects[i] と selects[i+1] の間が UNION ALL か
  while (this.matchKeyword('UNION')) {
    alls.push(this.matchKeyword('ALL'));
    selects.push(this.parseSelectCore_());
  }
  var tail2 = this.parseSelectTail_();
  return {
    type: 'UNION', selects: selects, alls: alls,
    orderBy: tail2.orderBy, limit: tail2.limit, offset: tail2.offset
  };
};

/**
 * SELECT本体(SELECT〜HAVINGまで)。ORDER BY/LIMITは含まない。
 */
Parser_.prototype.parseSelectCore_ = function () {
  this.expectKeyword('SELECT');
  var distinct = this.matchKeyword('DISTINCT');
  var columns = this.parseSelectList_();
  this.expectKeyword('FROM');
  var from = this.parseTableRef_();
  var joins = [];
  while (this.isKeyword('JOIN') || this.isKeyword('INNER') || this.isKeyword('LEFT')) {
    joins.push(this.parseJoin_());
  }
  var where = null;
  if (this.matchKeyword('WHERE')) where = this.parseExpr_();
  var groupBy = [];
  if (this.matchKeyword('GROUP')) {
    this.expectKeyword('BY');
    groupBy.push(this.expectColumnRef_());
    while (this.matchType(',')) groupBy.push(this.expectColumnRef_());
  }
  var having = null;
  if (this.matchKeyword('HAVING')) having = this.parseExpr_();
  return {
    type: 'SELECT', distinct: distinct, columns: columns, from: from, joins: joins,
    where: where, groupBy: groupBy, having: having, orderBy: [], limit: null, offset: null
  };
};

Parser_.prototype.parseSelectTail_ = function () {
  var orderBy = [];
  if (this.matchKeyword('ORDER')) {
    this.expectKeyword('BY');
    orderBy.push(this.parseOrderItem_());
    while (this.matchType(',')) orderBy.push(this.parseOrderItem_());
  }
  var limit = null, offset = null;
  if (this.matchKeyword('LIMIT')) {
    limit = this.expectNonNegativeInt_('LIMIT');
    if (this.matchKeyword('OFFSET')) offset = this.expectNonNegativeInt_('OFFSET');
  }
  return { orderBy: orderBy, limit: limit, offset: offset };
};

Parser_.prototype.parseSelectList_ = function () {
  var items = [];
  if (this.matchType('OP', '*')) { items.push({ star: true }); return items; }
  items.push(this.parseSelectItem_());
  while (this.matchType(',')) items.push(this.parseSelectItem_());
  return items;
};

Parser_.prototype.parseSelectItem_ = function () {
  var item = { expr: this.parseExpr_() };
  if (this.matchKeyword('AS')) {
    item.alias = this.expectIdent();
  } else if (this.peek().type === 'IDENT') {
    item.alias = this.expectIdent();
  }
  return item;
};

Parser_.prototype.parseTableRef_ = function () {
  var name = this.expectIdent();
  var alias = null;
  if (this.matchKeyword('AS')) alias = this.expectIdent();
  else if (this.peek().type === 'IDENT') alias = this.expectIdent();
  return { name: name, alias: alias || name };
};

Parser_.prototype.parseJoin_ = function () {
  var joinType = 'INNER';
  if (this.matchKeyword('INNER')) { joinType = 'INNER'; this.expectKeyword('JOIN'); }
  else if (this.matchKeyword('LEFT')) { joinType = 'LEFT'; this.matchKeyword('OUTER'); this.expectKeyword('JOIN'); }
  else { this.expectKeyword('JOIN'); }
  var table = this.parseTableRef_();
  this.expectKeyword('ON');
  var on = this.parseExpr_();
  return { joinType: joinType, table: table, on: on };
};

Parser_.prototype.parseOrderItem_ = function () {
  var expr = this.parseExpr_();
  var dir = 'ASC';
  if (this.matchKeyword('ASC')) dir = 'ASC';
  else if (this.matchKeyword('DESC')) dir = 'DESC';
  return { expr: expr, dir: dir };
};

Parser_.prototype.expectNonNegativeInt_ = function (clause) {
  var v = this.expectType('NUMBER').value;
  if (v % 1 !== 0) throw new SqlError('SYNTAX_ERROR', clause + ' には非負整数が必要: ' + v);
  return v;
};

Parser_.prototype.expectColumnRef_ = function () {
  var expr = this.parseOperand_();
  if (expr.type !== 'column') throw new SqlError('SYNTAX_ERROR', '列参照が必要');
  return expr;
};

// ---------- INSERT ----------

Parser_.prototype.parseInsert = function () {
  this.expectKeyword('INSERT');
  this.expectKeyword('INTO');
  var table = this.expectIdent();
  var columns = null;
  if (this.matchType('(')) {
    columns = [this.expectIdent()];
    while (this.matchType(',')) columns.push(this.expectIdent());
    this.expectType(')');
  }
  this.expectKeyword('VALUES');
  var valueRows = [this.parseValueRow_()];
  while (this.matchType(',')) valueRows.push(this.parseValueRow_());
  return { type: 'INSERT', table: table, columns: columns, valueRows: valueRows };
};

Parser_.prototype.parseValueRow_ = function () {
  this.expectType('(');
  var vals = [this.parseLiteral_()];
  while (this.matchType(',')) vals.push(this.parseLiteral_());
  this.expectType(')');
  return vals;
};

// 符号付き数値リテラル(-5 / +5)。符号でなければ null を返し呼び出し元の解析を続行する。
Parser_.prototype.parseSignedNumber_ = function () {
  var t = this.peek();
  if (t.type === 'OP' && (t.value === '-' || t.value === '+')) {
    this.pos++;
    var num = this.expectType('NUMBER');
    return { type: 'literal', value: t.value === '-' ? -num.value : num.value };
  }
  return null;
};

Parser_.prototype.parseLiteral_ = function () {
  var signed = this.parseSignedNumber_();
  if (signed) return signed;
  var t = this.peek();
  if (t.type === 'STRING') { this.pos++; return { type: 'literal', value: t.value }; }
  if (t.type === 'NUMBER') { this.pos++; return { type: 'literal', value: t.value }; }
  if (this.matchKeyword('TRUE')) return { type: 'literal', value: true };
  if (this.matchKeyword('FALSE')) return { type: 'literal', value: false };
  if (this.matchKeyword('NULL')) return { type: 'literal', value: null };
  throw new SqlError('SYNTAX_ERROR', 'リテラルが必要 (実際: ' + JSON.stringify(t) + ')');
};

// ---------- UPDATE ----------

Parser_.prototype.parseUpdate = function () {
  this.expectKeyword('UPDATE');
  var table = this.expectIdent();
  this.expectKeyword('SET');
  var assignments = [this.parseAssignment_()];
  while (this.matchType(',')) assignments.push(this.parseAssignment_());
  var where = null;
  if (this.matchKeyword('WHERE')) where = this.parseExpr_();
  return { type: 'UPDATE', table: table, assignments: assignments, where: where };
};

Parser_.prototype.parseAssignment_ = function () {
  var col = this.expectIdent();
  this.expectType('OP', '=');
  // リテラルに限らず式を許可する(例: SET stock = stock - 1)
  var value = this.parseExpr_();
  return { column: col, value: value };
};

// ---------- DELETE ----------

Parser_.prototype.parseDelete = function () {
  this.expectKeyword('DELETE');
  this.expectKeyword('FROM');
  var table = this.expectIdent();
  var where = null;
  if (this.matchKeyword('WHERE')) where = this.parseExpr_();
  return { type: 'DELETE', table: table, where: where };
};

// ---------- CREATE TABLE / DROP TABLE ----------

Parser_.prototype.parseCreateTable = function () {
  this.expectKeyword('CREATE');
  this.expectKeyword('TABLE');
  var ifNotExists = false;
  if (this.matchKeyword('IF')) { this.expectKeyword('NOT'); this.expectKeyword('EXISTS'); ifNotExists = true; }
  var table = this.expectIdent();
  this.expectType('(');
  var columns = [this.parseColumnDef_()];
  while (this.matchType(',')) columns.push(this.parseColumnDef_());
  this.expectType(')');
  return { type: 'CREATE_TABLE', table: table, columns: columns, ifNotExists: ifNotExists };
};

Parser_.prototype.parseColumnDef_ = function () {
  var name = this.expectIdent();
  var typeTok = this.peek();
  var typeName;
  if (typeTok.type === 'IDENT' || (typeTok.type === 'KEYWORD')) {
    this.pos++;
    typeName = typeTok.value;
  } else {
    throw new SqlError('SYNTAX_ERROR', '列型が必要');
  }
  var def = { name: name, type: normalizeType_(typeName), primaryKey: false };
  // 列制約: PRIMARY KEY / NOT NULL / DEFAULT <リテラル> (順不同・複数可)
  for (;;) {
    if (this.matchKeyword('PRIMARY')) { this.expectKeyword('KEY'); def.primaryKey = true; continue; }
    if (this.matchKeyword('NOT')) { this.expectKeyword('NULL'); def.notNull = true; continue; }
    if (this.matchKeyword('DEFAULT')) {
      def.hasDefault = true;
      def.defaultValue = this.parseLiteral_().value;
      continue;
    }
    break;
  }
  return def;
};

Parser_.prototype.parseDropTable = function () {
  this.expectKeyword('DROP');
  this.expectKeyword('TABLE');
  var ifExists = false;
  if (this.matchKeyword('IF')) { this.expectKeyword('EXISTS'); ifExists = true; }
  var table = this.expectIdent();
  return { type: 'DROP_TABLE', table: table, ifExists: ifExists };
};

// ---------- Expression ----------

Parser_.prototype.parseExpr_ = function () { return this.parseOr_(); };

Parser_.prototype.parseOr_ = function () {
  var left = this.parseAnd_();
  while (this.matchKeyword('OR')) {
    var right = this.parseAnd_();
    left = { type: 'logical', op: 'OR', left: left, right: right };
  }
  return left;
};

Parser_.prototype.parseAnd_ = function () {
  var left = this.parseNot_();
  while (this.matchKeyword('AND')) {
    var right = this.parseNot_();
    left = { type: 'logical', op: 'AND', left: left, right: right };
  }
  return left;
};

Parser_.prototype.parseNot_ = function () {
  if (this.matchKeyword('NOT')) {
    return { type: 'not', expr: this.parseNot_() };
  }
  return this.parseComparison_();
};

Parser_.prototype.parseComparison_ = function () {
  var left = this.parseAdditive_();

  if (this.matchKeyword('IS')) {
    var negate = this.matchKeyword('NOT');
    this.expectKeyword('NULL');
    return { type: 'isnull', left: left, negate: negate };
  }

  var negateNext = this.matchKeyword('NOT');

  if (this.matchKeyword('LIKE')) {
    var pattern = this.parseAdditive_();
    var node = { type: 'like', left: left, pattern: pattern };
    return negateNext ? { type: 'not', expr: node } : node;
  }

  if (this.matchKeyword('IN')) {
    this.expectType('(');
    if (this.isKeyword('SELECT')) {
      var sub = this.parseSelect();
      this.expectType(')');
      return { type: 'in', left: left, subquery: sub, negate: negateNext };
    }
    var list = [this.parseAdditive_()];
    while (this.matchType(',')) list.push(this.parseAdditive_());
    this.expectType(')');
    return { type: 'in', left: left, list: list, negate: negateNext };
  }

  if (this.matchKeyword('BETWEEN')) {
    var low = this.parseAdditive_();
    this.expectKeyword('AND');
    var high = this.parseAdditive_();
    return { type: 'between', left: left, low: low, high: high, negate: negateNext };
  }

  if (negateNext) throw new SqlError('SYNTAX_ERROR', 'NOT の後に LIKE/IN/BETWEEN が必要');

  var t = this.peek();
  if (t.type === 'OP' && ['=', '!=', '<', '<=', '>', '>='].indexOf(t.value) !== -1) {
    this.pos++;
    var right = this.parseAdditive_();
    return { type: 'binary', op: t.value, left: left, right: right };
  }

  return left; // 単項(ブール列など)
};

// ---------- 算術式(優先順位: 単項符号 > * / > + -) ----------

Parser_.prototype.parseAdditive_ = function () {
  var left = this.parseMultiplicative_();
  for (;;) {
    var t = this.peek();
    if (t.type === 'OP' && (t.value === '+' || t.value === '-')) {
      this.pos++;
      left = { type: 'arith', op: t.value, left: left, right: this.parseMultiplicative_() };
    } else {
      return left;
    }
  }
};

Parser_.prototype.parseMultiplicative_ = function () {
  var left = this.parseUnary_();
  for (;;) {
    var t = this.peek();
    if (t.type === 'OP' && (t.value === '*' || t.value === '/')) {
      this.pos++;
      left = { type: 'arith', op: t.value, left: left, right: this.parseUnary_() };
    } else {
      return left;
    }
  }
};

Parser_.prototype.parseUnary_ = function () {
  var t = this.peek();
  if (t.type === 'OP' && (t.value === '-' || t.value === '+')) {
    this.pos++;
    var operand = this.parseUnary_();
    if (t.value === '+') return operand;
    // 数値リテラルへの単項マイナスは畳み込んで負数リテラルにする
    if (operand.type === 'literal' && typeof operand.value === 'number') {
      return { type: 'literal', value: -operand.value };
    }
    return { type: 'unary', op: '-', expr: operand };
  }
  return this.parseOperand_();
};

Parser_.prototype.parseOperand_ = function () {
  var t = this.peek();

  // COUNT/SUM/AVG/MIN/MAXは非予約語。列名/エイリアス名との衝突を避けるため、
  // 「IDENTかつ直後のトークンが '(' 」の場合のみ集計関数呼び出しとして解釈する。
  if (t.type === 'IDENT' && AGG_FUNCS_.indexOf(t.value.toUpperCase()) !== -1 &&
      this.tokens[this.pos + 1] && this.tokens[this.pos + 1].type === '(') {
    var func = t.value.toUpperCase();
    this.pos++;
    this.expectType('(');
    var argStar = false, arg = null, distinctArg = false;
    if (this.matchType('OP', '*')) { argStar = true; }
    else {
      distinctArg = this.matchKeyword('DISTINCT');
      arg = this.parseExpr_();
    }
    this.expectType(')');
    return { type: 'agg', func: func, argStar: argStar, arg: arg, distinctArg: distinctArg };
  }

  if (t.type === 'STRING') { this.pos++; return { type: 'literal', value: t.value }; }
  if (t.type === 'NUMBER') { this.pos++; return { type: 'literal', value: t.value }; }
  if (this.matchKeyword('TRUE')) return { type: 'literal', value: true };
  if (this.matchKeyword('FALSE')) return { type: 'literal', value: false };
  if (this.matchKeyword('NULL')) return { type: 'literal', value: null };

  if (this.matchType('(')) {
    // スカラーサブクエリ (SELECT ...) — 1列1行(0行はNULL)を値として返す
    if (this.isKeyword('SELECT')) {
      var sub = this.parseSelect();
      this.expectType(')');
      return { type: 'subquery', select: sub };
    }
    var expr = this.parseExpr_();
    this.expectType(')');
    return expr;
  }

  if (t.type === 'IDENT') {
    this.pos++;
    var first = t.value;
    if (this.matchType('OP', '.')) {
      var second = this.expectIdent();
      return { type: 'column', table: first, name: second };
    }
    return { type: 'column', table: null, name: first };
  }

  throw new SqlError('SYNTAX_ERROR', '式の解析に失敗 (実際: ' + JSON.stringify(t) + ')');
};
