/**
 * システム全体の定数定義。
 */

// カタログ(システム管理)シート名。ユーザーテーブル名との衝突を避けるため "_" 始まり固定。
var SCHEMA_SHEET_NAME = '_schema';

// 1シャード(1シート)あたりのデータ行数閾値。超過時に新規シートへ自動分割する。
var DEFAULT_SHARD_THRESHOLD = 40000;

// スクリプトプロパティキー。
var PROP_DB_SPREADSHEET_ID = 'DB_SPREADSHEET_ID';
var PROP_API_KEYS = 'API_KEYS'; // JSON: { clientName: apiKey, ... }
var PROP_BACKUPS = 'BACKUPS'; // JSON: [{ id, name, createdAt, label }, ...] 新しい順
var PROP_BACKUP_RETENTION = 'BACKUP_RETENTION'; // 保持世代数の上書き(未設定時は既定値)

// バックアップの既定保持世代数。超過分は古い順にゴミ箱へ移動される。
var DEFAULT_BACKUP_RETENTION = 14;

// システム管理列(ユーザーが定義する列名として使用不可)。
var SYS_COL_ID = '__id';
var SYS_COL_CREATED_AT = '__created_at';
var SYS_COL_UPDATED_AT = '__updated_at';
var SYS_COLUMNS = [SYS_COL_ID, SYS_COL_CREATED_AT, SYS_COL_UPDATED_AT];

// サポート列型。
var COLUMN_TYPES = ['INTEGER', 'INT', 'REAL', 'FLOAT', 'TEXT', 'VARCHAR', 'BOOLEAN', 'DATE', 'DATETIME'];
