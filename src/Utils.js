/**
 * 汎用ユーティリティ。
 */

/**
 * 実行(リクエスト)単位のキャッシュ。GASではグローバル変数は1実行ごとに初期化されるため
 * リクエストを跨いで状態が残ることはない。SpreadsheetApp.openById() や _schema シートの
 * 全読みは高コストのため、同一実行内での重複呼び出しを避ける。
 * 整合性: 書き込み系はLockService取得直後に invalidateSchemaCache_() で必ず再読込するため、
 * 採番(nextId)等が他実行の更新を取りこぼすことはない。
 */
var RUNTIME_CACHE_ = { db: null, schemaRows: null };

function invalidateSchemaCache_() {
  RUNTIME_CACHE_.schemaRows = null;
}

function invalidateDbCache_() {
  RUNTIME_CACHE_.db = null;
  RUNTIME_CACHE_.schemaRows = null;
}

/**
 * DB本体のSpreadsheetを取得する。未初期化ならエラー。
 * @return {Spreadsheet}
 */
function getDb_() {
  if (RUNTIME_CACHE_.db) return RUNTIME_CACHE_.db;
  var id = PropertiesService.getScriptProperties().getProperty(PROP_DB_SPREADSHEET_ID);
  if (!id) {
    throw new SqlError('DATABASE_NOT_INITIALIZED', 'DBスプレッドシート未設定。initializeDatabase() を先に実行すること。');
  }
  RUNTIME_CACHE_.db = SpreadsheetApp.openById(id);
  return RUNTIME_CACHE_.db;
}

/**
 * スクリプトロック配下で fn を実行する(再入可能)。
 * GASのLockServiceは同一実行内での再取得挙動が保証されないため、
 * 実行内の深度カウンタで再入を検出し、最外殻のみ実ロックを取得・解放する。
 * (GASは1実行=1スレッドのためカウンタ方式で健全)
 */
var LOCK_DEPTH_ = 0;

function withScriptLock_(fn) {
  if (LOCK_DEPTH_ > 0) {
    LOCK_DEPTH_++;
    try { return fn(); } finally { LOCK_DEPTH_--; }
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  LOCK_DEPTH_++;
  try {
    return fn();
  } finally {
    LOCK_DEPTH_--;
    lock.releaseLock();
  }
}

/**
 * SQLエラー用カスタムエラークラス。
 */
function SqlError(code, message) {
  this.name = 'SqlError';
  this.code = code;
  this.message = message;
  this.stack = (new Error()).stack;
}
SqlError.prototype = Object.create(Error.prototype);
SqlError.prototype.constructor = SqlError;

/**
 * 列型名を正規化する。
 */
function normalizeType_(type) {
  var t = String(type).toUpperCase();
  if (t === 'INT') return 'INTEGER';
  if (t === 'VARCHAR') return 'TEXT';
  if (t === 'FLOAT') return 'REAL';
  return t;
}

/**
 * SQLリテラル/セル値を列型に応じてJS値へ変換する。
 */
function coerceValue_(value, type) {
  if (value === null || value === undefined || value === '') return null;
  var t = normalizeType_(type);
  switch (t) {
    case 'INTEGER':
      return Math.trunc(Number(value));
    case 'REAL':
      return Number(value);
    case 'BOOLEAN':
      if (typeof value === 'boolean') return value;
      var s = String(value).toUpperCase();
      return s === 'TRUE' || s === '1';
    case 'DATE':
    case 'DATETIME':
      if (value instanceof Date) return value;
      return new Date(value);
    default: // TEXT
      return String(value);
  }
}

/**
 * 一意なシャードシート名を生成する ({table}__1, {table}__2, ...)。
 */
function shardSheetName_(tableName, index) {
  return tableName + '__' + index;
}

/**
 * オブジェクトをJSONレスポンスとして返す。
 */
function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 予約語(システム列名)チェック。
 */
function isReservedColumn_(name) {
  return SYS_COLUMNS.indexOf(name) !== -1;
}
