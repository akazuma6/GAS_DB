/**
 * SQL字句解析器。
 */

var SQL_KEYWORDS_ = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'ORDER', 'BY', 'ASC', 'DESC',
  'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'DROP', 'PRIMARY', 'KEY', 'JOIN', 'INNER', 'LEFT', 'OUTER',
  'ON', 'GROUP', 'HAVING', 'AS', 'LIKE', 'IN', 'IS', 'NULL', 'BETWEEN',
  'DISTINCT', 'TRUE', 'FALSE', 'IF', 'EXISTS', 'UNION', 'ALL', 'DEFAULT'
  // COUNT/SUM/AVG/MIN/MAX は非予約(IDENTのまま)。列名/エイリアス名として使えるようにするため、
  // 集計関数としての認識はパーサー側で「IDENT かつ直後が '(' 」の場合のみ行う(SqlParser.js parseOperand_)。
];

function tokenize_(sql) {
  var tokens = [];
  var i = 0;
  var n = sql.length;

  function isDigit(ch) { return ch >= '0' && ch <= '9'; }
  // \p{L} で日本語(かな/カナ/漢字含む)識別子を許可する(顧客マスタ 等のテーブル名対応)。
  function isAlpha(ch) { return /^[\p{L}_]$/u.test(ch); }
  function isAlphaNum(ch) { return /^[\p{L}\p{N}_]$/u.test(ch); }

  while (i < n) {
    var ch = sql[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

    // コメント -- ...
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // 文字列リテラル 'xxx' (''でエスケープ)
    if (ch === "'") {
      var j = i + 1;
      var buf = '';
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { buf += "'"; j += 2; continue; }
        if (sql[j] === "'") break;
        buf += sql[j];
        j++;
      }
      if (j >= n) throw new SqlError('SYNTAX_ERROR', '未終端の文字列リテラル');
      tokens.push({ type: 'STRING', value: buf });
      i = j + 1;
      continue;
    }

    // ダブルクォート識別子 "col name"
    if (ch === '"') {
      var j2 = i + 1;
      var buf2 = '';
      while (j2 < n && sql[j2] !== '"') { buf2 += sql[j2]; j2++; }
      if (j2 >= n) throw new SqlError('SYNTAX_ERROR', '未終端の識別子');
      tokens.push({ type: 'IDENT', value: buf2 });
      i = j2 + 1;
      continue;
    }

    // 数値
    if (isDigit(ch) || (ch === '.' && isDigit(sql[i + 1]))) {
      var j3 = i;
      var hasDot = false;
      while (j3 < n && (isDigit(sql[j3]) || (sql[j3] === '.' && !hasDot))) {
        if (sql[j3] === '.') hasDot = true;
        j3++;
      }
      tokens.push({ type: 'NUMBER', value: Number(sql.slice(i, j3)) });
      i = j3;
      continue;
    }

    // 識別子 / キーワード
    if (isAlpha(ch)) {
      var j4 = i;
      while (j4 < n && isAlphaNum(sql[j4])) j4++;
      var word = sql.slice(i, j4);
      var upper = word.toUpperCase();
      if (SQL_KEYWORDS_.indexOf(upper) !== -1) {
        tokens.push({ type: 'KEYWORD', value: upper });
      } else {
        tokens.push({ type: 'IDENT', value: word });
      }
      i = j4;
      continue;
    }

    // パラメータプレースホルダ。parseSql_ が params 配列の値でリテラルへ置換する。
    if (ch === '?') { tokens.push({ type: 'PARAM', value: null }); i++; continue; }

    // 符号(単項プラス/マイナス)。"--" は上のコメント処理で先に消費されるため、ここへ来る '-' は演算子。
    if (ch === '-' || ch === '+') { tokens.push({ type: 'OP', value: ch }); i++; continue; }

    // 複合演算子
    if (ch === '!' && sql[i + 1] === '=') { tokens.push({ type: 'OP', value: '!=' }); i += 2; continue; }
    if (ch === '<' && sql[i + 1] === '>') { tokens.push({ type: 'OP', value: '!=' }); i += 2; continue; }
    if (ch === '<' && sql[i + 1] === '=') { tokens.push({ type: 'OP', value: '<=' }); i += 2; continue; }
    if (ch === '>' && sql[i + 1] === '=') { tokens.push({ type: 'OP', value: '>=' }); i += 2; continue; }

    if ('=<>(),.;*/'.indexOf(ch) !== -1) {
      tokens.push({ type: ch === '(' || ch === ')' || ch === ',' || ch === ';' ? ch : 'OP', value: ch });
      i++;
      continue;
    }

    throw new SqlError('SYNTAX_ERROR', '不正な文字: ' + ch + ' (位置 ' + i + ')');
  }

  tokens.push({ type: 'EOF', value: null });
  return tokens;
}
