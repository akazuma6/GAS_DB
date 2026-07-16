/**
 * SQL実行エンジン。SqlParser.js が生成したASTを受け取り、ShardStore.js経由でデータ操作する。
 * WHEREは全シャード横断でロード後にJSメモリ上でフィルタする(要件: 全ページ横断検索)。
 */

/**
 * SQL文字列を実行し、結果オブジェクトを返す唯一の公開エントリポイント。
 * @param {string} sql
 * @param {Array=} params `?` プレースホルダへバインドする値の配列(string/number/boolean/null)
 */
function executeSql_(sql, params) {
  var ast = parseSql_(sql, params);
  switch (ast.type) {
    case 'SELECT': return execSelect_(ast);
    case 'UNION': return execUnion_(ast);
    case 'INSERT': return execInsert_(ast);
    case 'UPDATE': return execUpdate_(ast);
    case 'DELETE': return execDelete_(ast);
    case 'CREATE_TABLE': return execCreateTable_(ast);
    case 'DROP_TABLE': return execDropTable_(ast);
    default: throw new SqlError('SYNTAX_ERROR', '未対応の文種別: ' + ast.type);
  }
}

/**
 * SELECT系AST(単一SELECT / UNION)を実行する。サブクエリ実行用の共通入口。
 */
function execSelectAny_(ast) {
  return ast.type === 'UNION' ? execUnion_(ast) : execSelect_(ast);
}

// ---------- バッチトランザクション ----------

/**
 * 実行中のトランザクションコンテキスト。executeSqlBatch_ 実行中のみ非null。
 * 書き込み系の各実行パスが変更前に txSnapshotTable_ を呼び、
 * 失敗時に全テーブルをバッチ開始時点の状態へ復元する。
 */
var CURRENT_TX_ = null;

/**
 * 複数SQL文をアトミックに実行する(all-or-nothing)。
 * バッチ全体を単一のスクリプトロック配下で実行し、途中で失敗した場合は
 * 変更された全テーブルをバッチ開始時点のスナップショットへロールバックする。
 * 失敗時のエラーには statementIndex(0始まりの失敗文番号)と rolledBack を付与する。
 * 各要素は SQL文字列、または { sql: string, params: Array } オブジェクト。
 */
function executeSqlBatch_(sqls) {
  return withScriptLock_(function () {
    invalidateSchemaCache_();
    var tx = { snapshots: {} };
    CURRENT_TX_ = tx;
    var results = [];
    try {
      for (var i = 0; i < sqls.length; i++) {
        try {
          var item = sqls[i];
          if (typeof item === 'string') {
            results.push(executeSql_(item));
          } else if (item && typeof item.sql === 'string') {
            results.push(executeSql_(item.sql, item.params));
          } else {
            throw new SqlError('BAD_REQUEST', 'sqls[' + i + '] はSQL文字列または { sql, params } オブジェクトで指定すること');
          }
        } catch (err) {
          CURRENT_TX_ = null; // ロールバック処理が再スナップショットしないように先に解除
          // 1テーブルの復元失敗で残りの復元を中断しない(可能な限り多くを復元する)。
          // 復元失敗があった場合は rolledBack=false とし、失敗内容を rollbackErrors で返す。
          var rollbackErrors = [];
          Object.keys(tx.snapshots).forEach(function (tableName) {
            try {
              restoreTableSnapshot_(tableName, tx.snapshots[tableName]);
            } catch (restoreErr) {
              rollbackErrors.push(tableName + ': ' + String((restoreErr && restoreErr.message) || restoreErr));
            }
          });
          err.statementIndex = i;
          err.rolledBack = rollbackErrors.length === 0;
          if (rollbackErrors.length > 0) err.rollbackErrors = rollbackErrors;
          throw err;
        }
      }
      return results;
    } finally {
      CURRENT_TX_ = null;
    }
  });
}

/**
 * トランザクション中なら対象テーブルの変更前状態を記録する(テーブルごとに初回のみ)。
 * 書き込み系の実行パス(appendRows_/execUpdate_/execDelete_/execCreateTable_/execDropTable_)
 * がロック取得後・変更前に呼び出す。
 */
function txSnapshotTable_(tableName) {
  if (!CURRENT_TX_) return;
  if (Object.prototype.hasOwnProperty.call(CURRENT_TX_.snapshots, tableName)) return;
  CURRENT_TX_.snapshots[tableName] = captureTableSnapshot_(tableName);
}

function captureTableSnapshot_(tableName) {
  var schema = getTableSchema_(tableName);
  if (!schema) return { existed: false };
  var db = getDb_();
  var header = tableHeader_(schema);
  var shardData = {};
  schema.shards.forEach(function (shardName) {
    var sheet = db.getSheetByName(shardName);
    var lastRow = sheet ? sheet.getLastRow() : 0;
    shardData[shardName] = lastRow >= 2
      ? sheet.getRange(2, 1, lastRow - 1, header.length).getValues()
      : [];
  });
  return {
    existed: true,
    columns: schema.columns,
    shards: schema.shards.slice(),
    shardThreshold: schema.shardThreshold,
    nextId: schema.nextId,
    createdAt: schema.createdAt,
    shardData: shardData
  };
}

function restoreTableSnapshot_(tableName, snap) {
  var db = getDb_();
  // 現在の状態(シャードシート・カタログ行)を破棄
  var current = getTableSchema_(tableName);
  if (current) {
    current.shards.forEach(function (shardName) {
      var sh = db.getSheetByName(shardName);
      if (sh) db.deleteSheet(sh);
    });
    getSchemaSheet_().deleteRow(current.rowIndex);
    invalidateSchemaCache_();
  }
  if (!snap.existed) return; // バッチ内でCREATEされたテーブル → 削除のみで復元完了

  var header = [SYS_COL_ID]
    .concat(snap.columns.map(function (c) { return c.name; }))
    .concat([SYS_COL_CREATED_AT, SYS_COL_UPDATED_AT]);
  snap.shards.forEach(function (shardName) {
    var sheet = db.insertSheet(shardName);
    setupShardSheet_(sheet, snap.columns, header);
    var data = snap.shardData[shardName];
    if (data && data.length > 0) {
      ensureSheetCapacity_(sheet, data.length + 1, header.length);
      sheet.getRange(2, 1, data.length, header.length).setValues(data);
    }
  });
  getSchemaSheet_().appendRow([
    tableName,
    JSON.stringify(snap.columns),
    JSON.stringify(snap.shards),
    snap.shardThreshold,
    snap.nextId,
    snap.createdAt
  ]);
  invalidateSchemaCache_();
}

// ---------- 式評価 ----------

function toBool_(v) { return v === true; }

function compareOp_(op, a, b) {
  var av = a, bv = b;
  if (a instanceof Date || b instanceof Date) {
    av = (a instanceof Date ? a : new Date(a)).getTime();
    bv = (b instanceof Date ? b : new Date(b)).getTime();
  }
  switch (op) {
    case '=': return av === bv;
    case '!=': return av !== bv;
    case '<': return av < bv;
    case '<=': return av <= bv;
    case '>': return av > bv;
    case '>=': return av >= bv;
    default: throw new SqlError('SYNTAX_ERROR', '不明な演算子: ' + op);
  }
}

function likeMatch_(str, pattern) {
  var escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  escaped = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp('^' + escaped + '$', 'i').test(str);
}

function getColumnValue_(ctx, colRef) {
  if (colRef.table) {
    var row = ctx[colRef.table];
    if (!row) throw new SqlError('NO_SUCH_TABLE', 'テーブル/エイリアス未検出: ' + colRef.table);
    if (!(colRef.name in row)) throw new SqlError('NO_SUCH_COLUMN', '列未検出: ' + colRef.table + '.' + colRef.name);
    return row[colRef.name];
  }
  var matches = [];
  Object.keys(ctx).forEach(function (alias) {
    if (ctx[alias] && Object.prototype.hasOwnProperty.call(ctx[alias], colRef.name)) matches.push(alias);
  });
  if (matches.length === 0) throw new SqlError('NO_SUCH_COLUMN', '列未検出: ' + colRef.name);
  if (matches.length > 1) throw new SqlError('AMBIGUOUS_COLUMN', '列名が曖昧(複数テーブルに存在): ' + colRef.name);
  return ctx[matches[0]][colRef.name];
}

/**
 * 列参照をスキーマ定義(実データではなく)に基づき検証する。
 * 対象行が0件のテーブルに対しても列名の誤りを検出できるようにするため、
 * SELECT実行前の静的チェックとして使用する。
 */
function checkColumnRef_(colRef, schemasByAlias) {
  if (colRef.table) {
    var schema = schemasByAlias[colRef.table];
    if (!schema) throw new SqlError('NO_SUCH_TABLE', 'テーブル/エイリアス未検出: ' + colRef.table);
    if (tableHeader_(schema).indexOf(colRef.name) === -1) {
      throw new SqlError('NO_SUCH_COLUMN', '列未検出: ' + colRef.table + '.' + colRef.name);
    }
    return;
  }
  var matches = Object.keys(schemasByAlias).filter(function (alias) {
    return tableHeader_(schemasByAlias[alias]).indexOf(colRef.name) !== -1;
  });
  if (matches.length === 0) throw new SqlError('NO_SUCH_COLUMN', '列未検出: ' + colRef.name);
  if (matches.length > 1) throw new SqlError('AMBIGUOUS_COLUMN', '列名が曖昧(複数テーブルに存在): ' + colRef.name);
}

function validateExprColumns_(node, schemasByAlias) {
  if (!node) return;
  if (node.type === 'column') { checkColumnRef_(node, schemasByAlias); return; }
  ['left', 'right', 'expr', 'pattern', 'low', 'high', 'arg'].forEach(function (k) {
    if (node[k]) validateExprColumns_(node[k], schemasByAlias);
  });
  if (node.list) node.list.forEach(function (n) { validateExprColumns_(n, schemasByAlias); });
}

function containsAgg_(node) {
  if (!node) return false;
  if (node.type === 'agg') return true;
  var keys = ['left', 'right', 'expr', 'pattern', 'low', 'high'];
  for (var i = 0; i < keys.length; i++) {
    if (node[keys[i]] && containsAgg_(node[keys[i]])) return true;
  }
  if (node.list) {
    for (var j = 0; j < node.list.length; j++) if (containsAgg_(node.list[j])) return true;
  }
  return false;
}

function computeAgg_(func, argStar, argExpr, distinctArg, groupCtxs) {
  var values;
  if (argStar) {
    values = groupCtxs.map(function () { return 1; });
  } else {
    values = groupCtxs.map(function (ctx) { return evalExpr_(argExpr, ctx, null); });
    values = values.filter(function (v) { return v !== null && v !== undefined; });
  }
  if (distinctArg) {
    var seen = {};
    values = values.filter(function (v) {
      var k = JSON.stringify(v);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }
  switch (func) {
    case 'COUNT': return values.length;
    case 'SUM': return values.reduce(function (a, b) { return a + Number(b); }, 0);
    case 'AVG': return values.length ? values.reduce(function (a, b) { return a + Number(b); }, 0) / values.length : null;
    case 'MIN': return values.length ? values.reduce(function (a, b) { return b < a ? b : a; }) : null;
    case 'MAX': return values.length ? values.reduce(function (a, b) { return b > a ? b : a; }) : null;
    default: throw new SqlError('SYNTAX_ERROR', '不明な集計関数: ' + func);
  }
}

// ---------- サブクエリ ----------

/**
 * サブクエリを実行し単一列の値配列を返す(IN (SELECT ...) 用)。
 */
function execSubqueryColumn_(selectAst) {
  var result = execSelectAny_(selectAst);
  if (result.columns.length !== 1) {
    throw new SqlError('SUBQUERY_ERROR', 'IN のサブクエリは1列のみ返すこと(実際: ' + result.columns.length + '列)');
  }
  var col = result.columns[0];
  return result.rows.map(function (r) { return r[col]; });
}

/**
 * スカラーサブクエリを実行し単一値を返す。0行はNULL、2行以上はエラー。
 */
function execScalarSubquery_(selectAst) {
  var result = execSelectAny_(selectAst);
  if (result.columns.length !== 1) {
    throw new SqlError('SUBQUERY_ERROR', 'スカラーサブクエリは1列のみ返すこと(実際: ' + result.columns.length + '列)');
  }
  if (result.rowCount === 0) return null;
  if (result.rowCount > 1) {
    throw new SqlError('SUBQUERY_ERROR', 'スカラーサブクエリが複数行を返した(' + result.rowCount + '行)');
  }
  return result.rows[0][result.columns[0]];
}

/**
 * 式を評価する。groupCtxs が渡された場合のみ集計関数(agg)ノードを許可する。
 * サブクエリは非相関のみ対応(外側の行を参照できない)。ASTノード上にメモ化し、
 * 1文の実行内で1回だけ評価する(ASTは文ごとに新規生成されるため実行間で漏れない)。
 */
function evalExpr_(node, ctx, groupCtxs) {
  switch (node.type) {
    case 'literal': return node.value;
    case 'column': return getColumnValue_(ctx, node);
    case 'subquery': {
      if (!node.__evaluated) {
        node.__value = execScalarSubquery_(node.select);
        node.__evaluated = true;
      }
      return node.__value;
    }
    case 'agg':
      if (!groupCtxs) throw new SqlError('SYNTAX_ERROR', '集計関数はSELECT列またはHAVING句以外では使用不可');
      return computeAgg_(node.func, node.argStar, node.arg, node.distinctArg, groupCtxs);
    case 'logical': {
      var l = toBool_(evalExpr_(node.left, ctx, groupCtxs));
      if (node.op === 'AND') { if (!l) return false; return toBool_(evalExpr_(node.right, ctx, groupCtxs)); }
      if (l) return true;
      return toBool_(evalExpr_(node.right, ctx, groupCtxs));
    }
    case 'not': return !toBool_(evalExpr_(node.expr, ctx, groupCtxs));
    case 'unary': {
      var uv = evalExpr_(node.expr, ctx, groupCtxs);
      if (uv === null || uv === undefined) return null; // NULL伝播
      return -(uv instanceof Date ? uv.getTime() : Number(uv));
    }
    case 'arith': {
      var la = evalExpr_(node.left, ctx, groupCtxs), ra = evalExpr_(node.right, ctx, groupCtxs);
      if (la === null || la === undefined || ra === null || ra === undefined) return null; // NULL伝播
      var ln = la instanceof Date ? la.getTime() : Number(la);
      var rn = ra instanceof Date ? ra.getTime() : Number(ra);
      switch (node.op) {
        case '+': return ln + rn;
        case '-': return ln - rn;
        case '*': return ln * rn;
        case '/': return rn === 0 ? null : ln / rn; // 0除算はNULL(SQLite準拠)
        default: throw new SqlError('SYNTAX_ERROR', '不明な算術演算子: ' + node.op);
      }
    }
    case 'binary': {
      var lv = evalExpr_(node.left, ctx, groupCtxs), rv = evalExpr_(node.right, ctx, groupCtxs);
      if (lv === null || rv === null) return false;
      return compareOp_(node.op, lv, rv);
    }
    case 'like': {
      var lv2 = evalExpr_(node.left, ctx, groupCtxs), pv = evalExpr_(node.pattern, ctx, groupCtxs);
      if (lv2 === null || pv === null) return false;
      return likeMatch_(String(lv2), String(pv));
    }
    case 'in': {
      var lv3 = evalExpr_(node.left, ctx, groupCtxs);
      if (lv3 === null) return false;
      var found;
      if (node.subquery) {
        if (!node.__subValues) node.__subValues = execSubqueryColumn_(node.subquery);
        found = node.__subValues.some(function (v) {
          return v !== null && v !== undefined && compareOp_('=', lv3, v);
        });
      } else {
        found = node.list.some(function (it) { return compareOp_('=', lv3, evalExpr_(it, ctx, groupCtxs)); });
      }
      return node.negate ? !found : found;
    }
    case 'isnull': {
      var lv4 = evalExpr_(node.left, ctx, groupCtxs);
      var isNull = (lv4 === null || lv4 === undefined || lv4 === '');
      return node.negate ? !isNull : isNull;
    }
    case 'between': {
      var lv5 = evalExpr_(node.left, ctx, groupCtxs), lo = evalExpr_(node.low, ctx, groupCtxs), hi = evalExpr_(node.high, ctx, groupCtxs);
      if (lv5 === null) return false;
      var res = compareOp_('>=', lv5, lo) && compareOp_('<=', lv5, hi);
      return node.negate ? !res : res;
    }
    default: throw new SqlError('SYNTAX_ERROR', '不明な式ノード: ' + node.type);
  }
}

function deriveName_(node) {
  if (node.type === 'column') return node.name;
  if (node.type === 'agg') return (node.func + '_' + (node.argStar ? 'all' : deriveName_(node.arg))).toLowerCase();
  return 'value';
}

// ---------- SELECT ----------

function execSelect_(ast) {
  var schemasByAlias = {};
  var baseSchema = getTableSchema_(ast.from.name);
  if (!baseSchema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + ast.from.name);
  schemasByAlias[ast.from.alias] = baseSchema;

  ast.joins.forEach(function (join) {
    var joinSchema = getTableSchema_(join.table.name);
    if (!joinSchema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + join.table.name);
    schemasByAlias[join.table.alias] = joinSchema;
  });

  // 静的な列参照検証(WHERE/ON等の対象行が0件でも列名の誤りを検出できるように、
  // 実データ走査の前にスキーマ定義だけを見て検証する)。
  ast.columns.forEach(function (c) { if (c.expr) validateExprColumns_(c.expr, schemasByAlias); });
  ast.joins.forEach(function (join) { validateExprColumns_(join.on, schemasByAlias); });
  if (ast.where) validateExprColumns_(ast.where, schemasByAlias);
  ast.groupBy.forEach(function (g) { validateExprColumns_(g, schemasByAlias); });
  if (ast.having) validateExprColumns_(ast.having, schemasByAlias);
  ast.orderBy.forEach(function (o) {
    if (o.expr.type === 'column') {
      // 単純列参照はSELECTエイリアスの可能性があるため、スキーマに無くてもここではエラーにしない。
      if (!ast.columns.some(function (c) { return c.alias === o.expr.name; })) {
        try { validateExprColumns_(o.expr, schemasByAlias); } catch (e) { /* エイリアス参照は実行時評価に委ねる */ }
      }
    } else {
      validateExprColumns_(o.expr, schemasByAlias);
    }
  });

  var baseRows = readTableRows_(ast.from.name).rows;
  var combined = baseRows.map(function (r) {
    var ctx = {};
    ctx[ast.from.alias] = r;
    return ctx;
  });

  var priorAliases = [ast.from.alias];
  ast.joins.forEach(function (join) {
    var joinSchema = schemasByAlias[join.table.alias];
    var joinRows = readTableRows_(join.table.name).rows;
    var nullRow = {};
    tableHeader_(joinSchema).forEach(function (h) { nullRow[h] = null; });

    // ON が単一の等値条件(col = col)ならハッシュ結合(O(N+M))を試みる。
    // それ以外はネステッドループ(O(N*M))で全条件式を評価する。
    var plan = equiJoinPlan_(join.on, join.table.alias, priorAliases, schemasByAlias);
    var buckets = null;
    if (plan) {
      buckets = Object.create(null);
      for (var bi = 0; bi < joinRows.length; bi++) {
        var bv = joinRows[bi][plan.joinCol];
        if (bv instanceof Date) {
          // Dateはcompareop_の文字列⇔Date型変換を伴うためハッシュ照合では等価性を保証できない。
          // 結合側にDateが1つでもあればネステッドループへ全面フォールバック。
          buckets = null;
          break;
        }
        if (bv === null || bv === undefined || bv !== bv) continue; // NULL/NaNは等値マッチしない
        var bk = joinHashKey_(bv);
        if (!buckets[bk]) buckets[bk] = [];
        buckets[bk].push(joinRows[bi]);
      }
    }

    var next = [];
    combined.forEach(function (ctx) {
      var matched = false;
      if (buckets) {
        var probeVal = getColumnValue_(ctx, plan.probe);
        if (probeVal instanceof Date) {
          // プローブ側がDateの行のみ逐次評価(型変換セマンティクスを維持)
          matched = nestedLoopJoinRow_(ctx, join, joinRows, next);
        } else if (probeVal !== null && probeVal !== undefined) {
          var hits = buckets[joinHashKey_(probeVal)];
          if (hits) {
            for (var hi = 0; hi < hits.length; hi++) {
              var hitCtx = shallowCopy_(ctx);
              hitCtx[join.table.alias] = hits[hi];
              next.push(hitCtx);
              matched = true;
            }
          }
        }
      } else {
        matched = nestedLoopJoinRow_(ctx, join, joinRows, next);
      }
      if (!matched && join.joinType === 'LEFT') {
        var leftCtx = shallowCopy_(ctx);
        leftCtx[join.table.alias] = nullRow;
        next.push(leftCtx);
      }
    });
    combined = next;
    priorAliases.push(join.table.alias);
  });

  if (ast.where) {
    combined = combined.filter(function (ctx) { return evalExpr_(ast.where, ctx, null) === true; });
  }

  var hasAgg = ast.columns.some(function (c) { return c.expr && containsAgg_(c.expr); }) || containsAgg_(ast.having);
  var useGrouping = ast.groupBy.length > 0 || hasAgg;

  var units; // [{ctx, groupRows}]
  if (useGrouping) {
    var groupsMap = {};
    var groupOrder = [];
    if (ast.groupBy.length === 0) {
      groupsMap['__all__'] = combined;
      groupOrder.push('__all__');
    } else {
      combined.forEach(function (ctx) {
        var key = ast.groupBy.map(function (g) { return JSON.stringify(evalExpr_(g, ctx, null)); }).join('\u0001');
        if (!groupsMap[key]) { groupsMap[key] = []; groupOrder.push(key); }
        groupsMap[key].push(ctx);
      });
    }
    units = groupOrder.map(function (key) {
      var rows = groupsMap[key];
      return { ctx: rows[0] || {}, groupRows: rows };
    });
    if (ast.having) {
      units = units.filter(function (u) { return evalExpr_(ast.having, u.ctx, u.groupRows) === true; });
    }
  } else {
    units = combined.map(function (ctx) { return { ctx: ctx, groupRows: null }; });
  }

  // 列展開('*')
  var star = ast.columns.length === 1 && ast.columns[0].star;
  var projectSpecs; // [{name, evaluator(unit)}]
  if (star) {
    var aliases = Object.keys(schemasByAlias);
    projectSpecs = [];
    aliases.forEach(function (alias) {
      var header = tableHeader_(schemasByAlias[alias]);
      header.forEach(function (colName) {
        var outName = aliases.length > 1 ? alias + '.' + colName : colName;
        projectSpecs.push({ name: outName, evaluator: (function (a, c) { return function (u) { return u.ctx[a] ? u.ctx[a][c] : null; }; })(alias, colName) });
      });
    });
  } else {
    projectSpecs = ast.columns.map(function (item) {
      var name = item.alias || deriveName_(item.expr);
      return { name: name, evaluator: function (u) { return evalExpr_(item.expr, u.ctx, u.groupRows); } };
    });
  }

  var rows = units.map(function (u) {
    var row = {};
    projectSpecs.forEach(function (spec) { row[spec.name] = spec.evaluator(u); });
    return { row: row, unit: u };
  });

  if (ast.distinct) {
    var seenRows = {};
    rows = rows.filter(function (r) {
      var k = JSON.stringify(r.row);
      if (seenRows[k]) return false;
      seenRows[k] = true;
      return true;
    });
  }

  if (ast.orderBy.length > 0) {
    rows.sort(function (a, b) {
      for (var i = 0; i < ast.orderBy.length; i++) {
        var item = ast.orderBy[i];
        var av, bv;
        if (item.expr.type === 'column') {
          // 単純列参照: SELECT出力(エイリアス含む)を優先し、無ければ生列を評価
          var name = item.expr.name;
          av = Object.prototype.hasOwnProperty.call(a.row, name) ? a.row[name] : evalExpr_(item.expr, a.unit.ctx, a.unit.groupRows);
          bv = Object.prototype.hasOwnProperty.call(b.row, name) ? b.row[name] : evalExpr_(item.expr, b.unit.ctx, b.unit.groupRows);
        } else {
          // 算術式・集計関数(ORDER BY COUNT(*) DESC 等)
          av = evalExpr_(item.expr, a.unit.ctx, a.unit.groupRows);
          bv = evalExpr_(item.expr, b.unit.ctx, b.unit.groupRows);
        }
        var cmp = compareForSort_(av, bv);
        if (cmp !== 0) return item.dir === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });
  }

  var offset = ast.offset || 0;
  var sliced = ast.limit !== null ? rows.slice(offset, offset + ast.limit) : rows.slice(offset);

  return {
    columns: projectSpecs.map(function (s) { return s.name; }),
    rows: sliced.map(function (r) { return r.row; }),
    rowCount: sliced.length
  };
}

/**
 * ORDER BY用の比較。NULLは最小値扱い(ASCで先頭、DESCで末尾。SQLite準拠)。
 * 素の比較だと null vs 値 が常にfalseになり順序が非決定的になるため明示的に扱う。
 */
function compareForSort_(av, bv) {
  var avn = av instanceof Date ? av.getTime() : av;
  var bvn = bv instanceof Date ? bv.getTime() : bv;
  var aNull = avn === null || avn === undefined || avn === '';
  var bNull = bvn === null || bvn === undefined || bvn === '';
  if (aNull && bNull) return 0;
  if (aNull) return -1;
  if (bNull) return 1;
  return avn < bvn ? -1 : (avn > bvn ? 1 : 0);
}

// ---------- UNION ----------

/**
 * UNION / UNION ALL の実行。左結合で段階的に評価する
 * (A UNION B UNION ALL C は「(A∪B)を重複排除した後、Cを連結」)。
 * 出力列名は先頭SELECTのものを採用し、2番目以降は位置ベースで揃える(SQL標準準拠)。
 */
function execUnion_(ast) {
  var results = ast.selects.map(function (s) { return execSelect_(s); });
  var columns = results[0].columns;
  for (var i = 1; i < results.length; i++) {
    if (results[i].columns.length !== columns.length) {
      throw new SqlError('UNION_COLUMN_MISMATCH',
        'UNIONの列数が不一致: ' + columns.length + '列 vs ' + results[i].columns.length + '列');
    }
  }

  function remapRow(res, row) {
    var out = {};
    for (var c = 0; c < columns.length; c++) out[columns[c]] = row[res.columns[c]];
    return out;
  }

  var acc = results[0].rows.map(function (r) { return remapRow(results[0], r); });
  for (var u = 1; u < results.length; u++) {
    acc = acc.concat(results[u].rows.map(function (r) { return remapRow(results[u], r); }));
    if (!ast.alls[u - 1]) acc = dedupeUnionRows_(acc, columns);
  }

  if (ast.orderBy.length > 0) {
    ast.orderBy.forEach(function (o) {
      if (o.expr.type !== 'column' || o.expr.table || columns.indexOf(o.expr.name) === -1) {
        throw new SqlError('SYNTAX_ERROR', 'UNIONのORDER BYは出力列名のみ指定可');
      }
    });
    acc.sort(function (a, b) {
      for (var i = 0; i < ast.orderBy.length; i++) {
        var item = ast.orderBy[i];
        var cmp = compareForSort_(a[item.expr.name], b[item.expr.name]);
        if (cmp !== 0) return item.dir === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });
  }

  var offset = ast.offset || 0;
  var sliced = ast.limit !== null ? acc.slice(offset, offset + ast.limit) : acc.slice(offset);
  return { columns: columns, rows: sliced, rowCount: sliced.length };
}

function dedupeUnionRows_(rows, columns) {
  var seen = Object.create(null);
  return rows.filter(function (r) {
    var k = columns.map(function (c) {
      var v = r[c];
      return JSON.stringify(v instanceof Date ? 'D' + v.getTime() : v);
    }).join('\u0001');
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

function shallowCopy_(obj) {
  var out = {};
  Object.keys(obj).forEach(function (k) { out[k] = obj[k]; });
  return out;
}

// ---------- JOIN 最適化 ----------

/**
 * 1つのctxをネステッドループで結合する(ハッシュ結合が使えない場合のフォールバック)。
 * @return {boolean} 1件以上マッチしたか
 */
function nestedLoopJoinRow_(ctx, join, joinRows, next) {
  var matched = false;
  for (var i = 0; i < joinRows.length; i++) {
    var testCtx = shallowCopy_(ctx);
    testCtx[join.table.alias] = joinRows[i];
    if (evalExpr_(join.on, testCtx, null) === true) {
      next.push(testCtx);
      matched = true;
    }
  }
  return matched;
}

/**
 * 型付きハッシュキー。compareOp_ の厳密等価(1 !== '1')セマンティクスを保つため
 * typeofを含める。Date値はキー化せず呼び出し側でフォールバックする。
 */
function joinHashKey_(v) {
  return typeof v + ':' + String(v);
}

/**
 * ON式が「結合テーブルの列 = 既結合側の列」の単一等値条件ならハッシュ結合計画を返す。
 * 適用不可(複合条件・非等値・別名解決不能・曖昧)なら null。
 */
function equiJoinPlan_(on, joinAlias, priorAliases, schemasByAlias) {
  if (!on || on.type !== 'binary' || on.op !== '=') return null;
  if (on.left.type !== 'column' || on.right.type !== 'column') return null;
  var visibleAliases = priorAliases.concat([joinAlias]);
  var la = resolveColumnAlias_(on.left, visibleAliases, schemasByAlias);
  var ra = resolveColumnAlias_(on.right, visibleAliases, schemasByAlias);
  if (!la || !ra) return null;
  if (la === joinAlias && priorAliases.indexOf(ra) !== -1) {
    return { joinCol: on.left.name, probe: on.right };
  }
  if (ra === joinAlias && priorAliases.indexOf(la) !== -1) {
    return { joinCol: on.right.name, probe: on.left };
  }
  return null;
}

/**
 * 列参照がどのテーブル別名に属するかを解決する。実行時の getColumnValue_ と同じ規則
 * (修飾あり=その別名、無し=可視別名の中で一意)で判定し、解決できなければ null。
 */
function resolveColumnAlias_(colRef, visibleAliases, schemasByAlias) {
  if (colRef.table) {
    if (visibleAliases.indexOf(colRef.table) === -1) return null;
    return colRef.table;
  }
  var matches = visibleAliases.filter(function (alias) {
    var schema = schemasByAlias[alias];
    return schema && tableHeader_(schema).indexOf(colRef.name) !== -1;
  });
  return matches.length === 1 ? matches[0] : null;
}

// ---------- INSERT ----------

function execInsert_(ast) {
  var schema = getTableSchema_(ast.table);
  if (!schema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + ast.table);
  var columns = ast.columns || schema.columns.map(function (c) { return c.name; });

  var seenCols = Object.create(null);
  columns.forEach(function (c) {
    if (seenCols[c]) throw new SqlError('DUPLICATE_COLUMN', 'INSERT の列指定が重複: ' + c);
    seenCols[c] = true;
  });

  var valueObjects = ast.valueRows.map(function (valRow) {
    if (valRow.length !== columns.length) {
      throw new SqlError('COLUMN_COUNT_MISMATCH', 'VALUES の項目数が列数と不一致');
    }
    var obj = {};
    columns.forEach(function (colName, i) {
      findColumnDef_(schema, colName); // 存在検証
      obj[colName] = valRow[i].value;
    });
    // 未指定列へ DEFAULT を適用し、NOT NULL 制約を検証する
    // (明示的な NULL 指定は DEFAULT で上書きしない = SQL標準セマンティクス)
    schema.columns.forEach(function (col) {
      if (!Object.prototype.hasOwnProperty.call(obj, col.name) && col.hasDefault) {
        obj[col.name] = col.defaultValue;
      }
      if (col.notNull) {
        var v = Object.prototype.hasOwnProperty.call(obj, col.name) ? obj[col.name] : null;
        if (v === null || v === undefined) {
          throw new SqlError('NOT_NULL_VIOLATION', 'NOT NULL 制約違反: ' + col.name);
        }
      }
    });
    return obj;
  });

  var ids = appendRows_(ast.table, valueObjects);
  return { insertedCount: ids.length, ids: ids };
}

// ---------- UPDATE ----------

function execUpdate_(ast) {
  return withScriptLock_(function () {
    invalidateSchemaCache_();
    txSnapshotTable_(ast.table);
    var schema = getTableSchema_(ast.table);
    if (!schema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + ast.table);
    var header = tableHeader_(schema);
    var schemasByAliasU = {};
    schemasByAliasU[ast.table] = schema;
    if (ast.where) validateExprColumns_(ast.where, schemasByAliasU);
    ast.assignments.forEach(function (a) {
      findColumnDef_(schema, a.column); // 代入先の存在検証
      validateExprColumns_(a.value, schemasByAliasU);
    });
    var loaded = readTableRows_(ast.table);
    var now = new Date();
    var updatedCount = 0;
    var touchedShards = {};
    var rowsByShard = {};

    loaded.rows.forEach(function (row) {
      if (!rowsByShard[row.__shard]) rowsByShard[row.__shard] = [];
      rowsByShard[row.__shard].push(row);
      var ctx = {};
      ctx[ast.table] = row;
      var matches = ast.where ? evalExpr_(ast.where, ctx, null) === true : true;
      if (matches) {
        // SQLセマンティクス: 全代入式を更新前の行値で評価してから適用する
        // (SET a = b, b = a のような相互参照でも旧値を参照)
        var newValues = ast.assignments.map(function (a) {
          var col = findColumnDef_(schema, a.column);
          var nv = coerceValue_(evalExpr_(a.value, ctx, null), col.type);
          if (col.notNull && (nv === null || nv === undefined)) {
            throw new SqlError('NOT_NULL_VIOLATION', 'NOT NULL 制約違反: ' + a.column);
          }
          return nv;
        });
        ast.assignments.forEach(function (a, i) {
          row[a.column] = newValues[i];
        });
        row[SYS_COL_UPDATED_AT] = now;
        touchedShards[row.__shard] = true;
        updatedCount++;
      }
    });

    Object.keys(touchedShards).forEach(function (shardName) {
      var matrix = rowsByShard[shardName].map(function (r) { return header.map(function (h) { return r[h]; }); });
      replaceShardData_(shardName, matrix, header.length);
    });

    return { updatedCount: updatedCount };
  });
}

// ---------- DELETE ----------

function execDelete_(ast) {
  return withScriptLock_(function () {
    invalidateSchemaCache_();
    txSnapshotTable_(ast.table);
    var schema = getTableSchema_(ast.table);
    if (!schema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + ast.table);
    var header = tableHeader_(schema);
    var schemasByAliasD = {};
    schemasByAliasD[ast.table] = schema;
    if (ast.where) validateExprColumns_(ast.where, schemasByAliasD);
    var loaded = readTableRows_(ast.table);
    var deletedCount = 0;
    var rowsByShard = {};
    var touchedShards = {};

    loaded.rows.forEach(function (row) {
      if (!rowsByShard[row.__shard]) rowsByShard[row.__shard] = [];
      var ctx = {};
      ctx[ast.table] = row;
      var matches = ast.where ? evalExpr_(ast.where, ctx, null) === true : true;
      if (matches) {
        deletedCount++;
        touchedShards[row.__shard] = true;
      } else {
        rowsByShard[row.__shard].push(row);
      }
    });

    Object.keys(touchedShards).forEach(function (shardName) {
      var remaining = rowsByShard[shardName] || [];
      var matrix = remaining.map(function (r) { return header.map(function (h) { return r[h]; }); });
      replaceShardData_(shardName, matrix, header.length);
    });

    return { deletedCount: deletedCount };
  });
}

// ---------- CREATE TABLE / DROP TABLE ----------

function execCreateTable_(ast) {
  ast.columns.forEach(function (c) {
    if (COLUMN_TYPES.indexOf(c.type) === -1) {
      throw new SqlError('UNKNOWN_TYPE', '未対応の列型: ' + c.type);
    }
  });
  // IF NOT EXISTS 判定はロック取得・キャッシュ無効化後に行う
  // (他実行がロック解放直前に同名テーブルを作成したケースを取りこぼさない)
  return withScriptLock_(function () {
    invalidateSchemaCache_();
    if (ast.ifNotExists && getTableSchema_(ast.table)) {
      return { table: ast.table, created: false, alreadyExists: true };
    }
    txSnapshotTable_(ast.table);
    // 制約(notNull/hasDefault/defaultValue)は columnsJson へ保存され INSERT/UPDATE 時に適用される
    createTable_(ast.table, ast.columns.map(function (c) {
      var col = { name: c.name, type: c.type };
      if (c.primaryKey) col.primaryKey = true;
      if (c.notNull) col.notNull = true;
      if (c.hasDefault) { col.hasDefault = true; col.defaultValue = c.defaultValue; }
      return col;
    }), DEFAULT_SHARD_THRESHOLD);
    return { table: ast.table, created: true, columns: ast.columns };
  });
}

function execDropTable_(ast) {
  return withScriptLock_(function () {
    invalidateSchemaCache_();
    if (ast.ifExists && !getTableSchema_(ast.table)) {
      return { table: ast.table, dropped: false };
    }
    txSnapshotTable_(ast.table);
    dropTable_(ast.table);
    return { table: ast.table, dropped: true };
  });
}
