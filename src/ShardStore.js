/**
 * シャード(実データシート)への物理読み書き層。
 * 1テーブル = 複数シート(シャード)。読み取りは全シャード横断で行う。
 */

/**
 * テーブル全行を全シャードから読み込み、行オブジェクト配列で返す。
 * 各行オブジェクトには物理位置情報 __shard / __rowIndex を付与する(内部利用専用、SELECT結果には含めない)。
 */
function readTableRows_(tableName) {
  var schema = getTableSchema_(tableName);
  if (!schema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + tableName);
  var db = getDb_();
  var header = tableHeader_(schema);
  var rows = [];

  schema.shards.forEach(function (shardName) {
    var sheet = db.getSheetByName(shardName);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var numCols = header.length;
    var values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
    for (var i = 0; i < values.length; i++) {
      var raw = values[i];
      if (raw[0] === '' || raw[0] === null) continue; // 空行スキップ
      var obj = { __shard: shardName, __rowIndex: i + 2 };
      for (var c = 0; c < header.length; c++) {
        // GASのgetValues()は空セルを '' で返すため、SQLのNULLセマンティクス
        // (NULLとの比較は常に不成立、IS NULLのみ真)を保つようnullへ正規化する。
        obj[header[c]] = raw[c] === '' ? null : raw[c];
      }
      rows.push(obj);
    }
  });

  return { schema: schema, header: header, rows: rows };
}

/**
 * ヘッダー列順序 ( __id, userCol1, userCol2, ..., __created_at, __updated_at )。
 */
function tableHeader_(schema) {
  return [SYS_COL_ID].concat(schema.columns.map(function (c) { return c.name; })).concat([SYS_COL_CREATED_AT, SYS_COL_UPDATED_AT]);
}

/**
 * シートのグリッドが必要行数・列数を満たすよう拡張する。
 * 実GASでは新規シートのグリッドは1,000行×26列で、グリッド外への getRange は
 * 例外になるため、書き込み前に必ず確保する。
 */
function ensureSheetCapacity_(sheet, neededRows, neededCols) {
  var maxR = sheet.getMaxRows();
  if (neededRows > maxR) sheet.insertRowsAfter(maxR, neededRows - maxR);
  var maxC = sheet.getMaxColumns();
  if (neededCols > maxC) sheet.insertColumnsAfter(maxC, neededCols - maxC);
}

/**
 * シャードシートの初期化(ヘッダー行・固定行・列書式)。
 * TEXT列には '@'(書式なしテキスト)を設定し、実GAS(Sheets)の自動型変換
 * ('0123'→123、'2026-01-01'→Date 等)による値の破壊を防ぐ。
 */
function setupShardSheet_(sheet, schemaColumns, header) {
  ensureSheetCapacity_(sheet, 2, header.length);
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.setFrozenRows(1);
  schemaColumns.forEach(function (c, i) {
    if (normalizeType_(c.type) === 'TEXT') {
      sheet.getRange(1, i + 2, sheet.getMaxRows(), 1).setNumberFormat('@'); // i+2 = __id の次から
    }
  });
}

/**
 * 行オブジェクト配列をテーブルへ追加する。閾値超過時は自動でシャードを追加する。
 * @param {string} tableName
 * @param {Array<Object>} valueObjects  ユーザー列名をキーとする値オブジェクトの配列
 * @return {Array<number>} 採番されたID配列
 */
function appendRows_(tableName, valueObjects) {
  return withScriptLock_(function () {
    // 他実行がロック解放直前に書いた最新状態(nextId等)を必ず読み直す
    invalidateSchemaCache_();
    txSnapshotTable_(tableName);
    var schema = getTableSchema_(tableName);
    if (!schema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + tableName);
    var db = getDb_();
    var header = tableHeader_(schema);
    var startId = allocateIds_(tableName, valueObjects.length);
    var now = new Date();
    var ids = [];

    var builtRows = valueObjects.map(function (vals, i) {
      var id = startId + i;
      ids.push(id);
      return header.map(function (colName) {
        if (colName === SYS_COL_ID) return id;
        if (colName === SYS_COL_CREATED_AT) return now;
        if (colName === SYS_COL_UPDATED_AT) return now;
        var col = findColumnDef_(schema, colName);
        var v = Object.prototype.hasOwnProperty.call(vals, colName) ? vals[colName] : null;
        return v === null || v === undefined ? null : coerceValue_(v, col.type);
      });
    });

    var shards = schema.shards.slice();
    var lastShardName = shards[shards.length - 1];
    var lastSheet = db.getSheetByName(lastShardName);
    var used = Math.max(0, lastSheet.getLastRow() - 1);
    var threshold = schema.shardThreshold;
    var cursor = 0;

    while (cursor < builtRows.length) {
      var capacity = threshold - used;
      if (capacity <= 0) {
        // 新規シャード作成
        var newIndex = shards.length + 1;
        var newName = shardSheetName_(tableName, newIndex);
        var newSheet = db.insertSheet(newName);
        setupShardSheet_(newSheet, schema.columns, header);
        shards.push(newName);
        lastSheet = newSheet;
        used = 0;
        capacity = threshold;
      }
      var chunk = builtRows.slice(cursor, cursor + capacity);
      ensureSheetCapacity_(lastSheet, used + 1 + chunk.length, header.length);
      lastSheet.getRange(used + 2, 1, chunk.length, header.length).setValues(chunk);
      used += chunk.length;
      cursor += chunk.length;
    }

    updateTableShards_(tableName, shards);
    return ids;
  });
}

/**
 * 指定シャードのデータ領域を新しい行データで完全に置き換える(UPDATE/DELETE用)。
 * @param {string} shardName
 * @param {Array<Array>} newDataRows  ヘッダー順の値配列(データ行のみ、ヘッダー含まず)
 * @param {number} numCols
 */
function replaceShardData_(shardName, newDataRows, numCols) {
  var db = getDb_();
  var sheet = db.getSheetByName(shardName);
  var oldLastRow = sheet.getLastRow();
  if (oldLastRow >= 2) {
    sheet.getRange(2, 1, oldLastRow - 1, numCols).clearContent();
  }
  if (newDataRows.length > 0) {
    ensureSheetCapacity_(sheet, newDataRows.length + 1, numCols);
    sheet.getRange(2, 1, newDataRows.length, numCols).setValues(newDataRows);
  }
}

function findColumnDef_(schema, colName) {
  for (var i = 0; i < schema.columns.length; i++) {
    if (schema.columns[i].name === colName) return schema.columns[i];
  }
  throw new SqlError('NO_SUCH_COLUMN', '列未検出: ' + colName);
}
