/**
 * 初回セットアップ用関数群。Apps Scriptエディタから手動で選択実行する(Web公開はしない)。
 */

/**
 * DB用スプレッドシートを新規作成し、ScriptPropertiesへIDを保存する。
 * 既存スプレッドシートを使いたい場合は代わりに setDatabaseSpreadsheetId_('xxxx') を実行すること。
 */
function initializeDatabase() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty(PROP_DB_SPREADSHEET_ID);
  if (existing) {
    Logger.log('既に初期化済み: spreadsheetId=%s', existing);
    return existing;
  }
  var ss = SpreadsheetApp.create('GAS-DB');
  props.setProperty(PROP_DB_SPREADSHEET_ID, ss.getId());
  invalidateDbCache_();
  getSchemaSheet_(); // _schema シート作成

  ss.getSheets().forEach(function (s) {
    if (s.getName() === 'シート1' || s.getName() === 'Sheet1') ss.deleteSheet(s);
  });

  Logger.log('DB初期化完了: spreadsheetId=%s url=%s', ss.getId(), ss.getUrl());
  return ss.getId();
}

/**
 * 既存スプレッドシートをDB本体として紐付ける。
 */
function setDatabaseSpreadsheetId_(spreadsheetId) {
  PropertiesService.getScriptProperties().setProperty(PROP_DB_SPREADSHEET_ID, spreadsheetId);
  invalidateDbCache_();
  getSchemaSheet_();
  Logger.log('DB紐付け完了: spreadsheetId=%s', spreadsheetId);
}

/**
 * バックオフィス業務向けサンプルテーブルを作成する(任意)。
 * 進捗管理 / 勤怠 / 顧客マスタ の3テーブル。列は必要に応じて調整すること。
 */
function setupSampleTables_() {
  executeSql_(
    "CREATE TABLE IF NOT EXISTS 顧客マスタ (" +
    "customer_code TEXT, name TEXT, kana TEXT, tel TEXT, email TEXT, " +
    "address TEXT, fiscal_year_end TEXT, contract_type TEXT, status TEXT)"
  );
  executeSql_(
    "CREATE TABLE IF NOT EXISTS 進捗管理 (" +
    "customer_code TEXT, task_name TEXT, category TEXT, due_date DATE, " +
    "status TEXT, assignee TEXT, note TEXT)"
  );
  executeSql_(
    "CREATE TABLE IF NOT EXISTS 勤怠 (" +
    "staff_code TEXT, staff_name TEXT, work_date DATE, clock_in DATETIME, " +
    "clock_out DATETIME, break_minutes INTEGER, status TEXT)"
  );
  Logger.log('サンプルテーブル作成完了: 顧客マスタ / 進捗管理 / 勤怠');
}

/**
 * クライアント用APIキーを新規発行する。実行後、ログ出力されたキーを外部アプリ側へ設定すること。
 * 例: issueApiKey_('顧客管理アプリ')
 */
function issueApiKeyForClient(clientName) {
  var key = issueApiKey_(clientName);
  Logger.log('client=%s apiKey=%s', clientName, key);
  return key;
}
