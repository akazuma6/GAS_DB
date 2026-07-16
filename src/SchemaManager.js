/**
 * テーブルカタログ(_schema シート)の管理。
 * _schema 列: tableName | columnsJson | shardsJson | shardThreshold | nextId | createdAt
 */

var SCHEMA_HEADERS_ = ['tableName', 'columnsJson', 'shardsJson', 'shardThreshold', 'nextId', 'createdAt'];

function getSchemaSheet_() {
  var db = getDb_();
  var sheet = db.getSheetByName(SCHEMA_SHEET_NAME);
  if (!sheet) {
    sheet = db.insertSheet(SCHEMA_SHEET_NAME);
    sheet.getRange(1, 1, 1, SCHEMA_HEADERS_.length).setValues([SCHEMA_HEADERS_]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readSchemaTable_() {
  if (RUNTIME_CACHE_.schemaRows) return RUNTIME_CACHE_.schemaRows;
  var sheet = getSchemaSheet_();
  var lastRow = sheet.getLastRow();
  var rows = [];
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, SCHEMA_HEADERS_.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      if (!r[0]) continue;
      rows.push({
        rowIndex: i + 2,
        tableName: r[0],
        columns: JSON.parse(r[1]),
        shards: JSON.parse(r[2]),
        shardThreshold: r[3],
        nextId: r[4],
        createdAt: r[5]
      });
    }
  }
  RUNTIME_CACHE_.schemaRows = rows;
  return rows;
}

/**
 * テーブル定義を取得する。存在しなければ null。
 */
function getTableSchema_(tableName) {
  var rows = readSchemaTable_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].tableName === tableName) return rows[i];
  }
  return null;
}

function listTables_() {
  return readSchemaTable_().map(function (r) { return r.tableName; });
}

/**
 * CREATE TABLE 実行。最初のシャードシートを作成する。
 */
function createTable_(tableName, columns, shardThreshold) {
  if (getTableSchema_(tableName)) {
    throw new SqlError('TABLE_EXISTS', 'テーブル既存: ' + tableName);
  }
  columns.forEach(function (c) {
    if (isReservedColumn_(c.name)) {
      throw new SqlError('RESERVED_COLUMN', '予約列名使用不可: ' + c.name);
    }
  });

  var db = getDb_();
  var firstShard = shardSheetName_(tableName, 1);
  var sheet = db.insertSheet(firstShard);
  var header = [SYS_COL_ID].concat(columns.map(function (c) { return c.name; })).concat([SYS_COL_CREATED_AT, SYS_COL_UPDATED_AT]);
  setupShardSheet_(sheet, columns, header);

  var schemaSheet = getSchemaSheet_();
  var now = new Date();
  schemaSheet.appendRow([
    tableName,
    JSON.stringify(columns),
    JSON.stringify([firstShard]),
    shardThreshold || DEFAULT_SHARD_THRESHOLD,
    1, // nextId
    now
  ]);
  invalidateSchemaCache_();

  return getTableSchema_(tableName);
}

function dropTable_(tableName) {
  var schema = getTableSchema_(tableName);
  if (!schema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + tableName);
  var db = getDb_();
  schema.shards.forEach(function (shardName) {
    var sh = db.getSheetByName(shardName);
    if (sh) db.deleteSheet(sh);
  });
  var schemaSheet = getSchemaSheet_();
  schemaSheet.deleteRow(schema.rowIndex);
  invalidateSchemaCache_();
}

function updateTableShards_(tableName, shardsArray) {
  var schema = getTableSchema_(tableName);
  var schemaSheet = getSchemaSheet_();
  schemaSheet.getRange(schema.rowIndex, 3).setValue(JSON.stringify(shardsArray));
  invalidateSchemaCache_();
}

/**
 * id採番。LockService配下で呼び出すこと。
 */
function allocateIds_(tableName, count) {
  var schema = getTableSchema_(tableName);
  if (!schema) throw new SqlError('NO_SUCH_TABLE', 'テーブル未検出: ' + tableName);
  var start = schema.nextId;
  var schemaSheet = getSchemaSheet_();
  schemaSheet.getRange(schema.rowIndex, 5).setValue(start + count);
  invalidateSchemaCache_();
  return start;
}
