/**
 * 実環境(GAS)用の診断・検査関数群。Apps Scriptエディタから手動で選択実行する。
 * Web公開はされない(doGet/doPost以外はHTTP経由で呼び出し不可)。
 *
 *   diagnoseDatabase()  環境・カタログ・シャード整合性の診断レポート
 *   runSelfTest()       実環境E2Eセルフテスト(一時テーブルで実行、終了時に自動削除)
 *   runDebugQuery()     DEBUG_SQL に書いたSQLを計測付きで実行しログ出力
 */

// runDebugQuery() で実行するSQL。デバッグ時にここを書き換えてから実行する。
var DEBUG_SQL = 'SELECT 1 + 1 AS answer FROM _dummy_'; // 例: 'SELECT * FROM 顧客マスタ LIMIT 10'

/**
 * DB環境と全テーブルの整合性を診断し、レポートをログ出力して返す。
 * 破壊的操作は一切行わない(読み取りのみ)。
 *
 * 検査項目:
 *  - ScriptProperties / スプレッドシート到達性
 *  - _schema カタログの妥当性(JSON破損検出)
 *  - シャードシートの実在・ヘッダー整合
 *  - __id の重複・nextId の整合(nextId <= max(__id) なら採番衝突の危険)
 *  - カタログ未登録の孤立シャードシート
 *  - セル使用量(スプレッドシート上限1,000万セルに対する使用率)
 */
function diagnoseDatabase() {
  var report = { ok: true, problems: [], tables: [], orphanSheets: [], cellUsage: null, clients: [] };

  function problem(msg) {
    report.ok = false;
    report.problems.push(msg);
    Logger.log('[NG] %s', msg);
  }

  // --- 環境 ---
  var props = PropertiesService.getScriptProperties();
  var dbId = props.getProperty(PROP_DB_SPREADSHEET_ID);
  if (!dbId) {
    problem('DBスプレッドシート未設定(initializeDatabase() 未実行)');
    return report;
  }
  var db;
  try {
    db = getDb_();
    Logger.log('[OK] DB到達性: %s (%s)', db.getId(), db.getUrl());
  } catch (e) {
    problem('スプレッドシートを開けない: ' + e.message);
    return report;
  }

  var rawKeys = props.getProperty(PROP_API_KEYS);
  try {
    report.clients = rawKeys ? Object.keys(JSON.parse(rawKeys)) : [];
    Logger.log('[OK] APIキー発行済みクライアント: %s', report.clients.length ? report.clients.join(', ') : '(なし)');
  } catch (e) {
    problem('APIキー設定(' + PROP_API_KEYS + ')のJSONが破損: ' + e.message + ' — issueApiKeyForClient() の再実行で復旧可');
  }

  // --- カタログ ---
  var schemaSheet = db.getSheetByName(SCHEMA_SHEET_NAME);
  if (!schemaSheet) {
    problem('_schema シートが存在しない');
    return report;
  }
  var tables;
  try {
    invalidateSchemaCache_();
    tables = readSchemaTable_();
  } catch (e) {
    problem('_schema の読み取り/JSON解析に失敗: ' + e.message);
    return report;
  }

  var referencedShards = {};

  // --- テーブルごとの整合性 ---
  tables.forEach(function (schema) {
    var t = { name: schema.tableName, shards: [], rowCount: 0, nextId: schema.nextId, maxId: 0, problems: [] };
    var header = tableHeader_(schema);

    schema.shards.forEach(function (shardName) {
      referencedShards[shardName] = true;
      var sheet = db.getSheetByName(shardName);
      if (!sheet) {
        t.problems.push('シャードシート欠損: ' + shardName);
        return;
      }
      // ヘッダー整合
      var actualHeader = sheet.getRange(1, 1, 1, header.length).getValues()[0];
      for (var i = 0; i < header.length; i++) {
        if (actualHeader[i] !== header[i]) {
          t.problems.push(shardName + ' のヘッダー不一致: 列' + (i + 1) + ' 期待=' + header[i] + ' 実際=' + actualHeader[i]);
          break;
        }
      }
      var dataRows = Math.max(0, sheet.getLastRow() - 1);
      t.shards.push({ name: shardName, rows: dataRows });
      t.rowCount += dataRows;
    });

    // __id 重複・nextId 整合(全行スキャン。行数が多いテーブルでは時間がかかる)
    try {
      var seen = {};
      readTableRows_(schema.tableName).rows.forEach(function (row) {
        var id = row[SYS_COL_ID];
        if (seen['#' + id]) t.problems.push('__id 重複: ' + id);
        seen['#' + id] = true;
        if (id > t.maxId) t.maxId = id;
      });
      if (schema.nextId <= t.maxId) {
        t.problems.push('nextId(' + schema.nextId + ') <= max(__id)(' + t.maxId + '): 次のINSERTでID衝突の危険');
      }
    } catch (e) {
      t.problems.push('行スキャン失敗: ' + e.message);
    }

    if (t.problems.length) {
      t.problems.forEach(function (p) { problem('[' + t.name + '] ' + p); });
    } else {
      Logger.log('[OK] %s: %s行 / シャード%s / nextId=%s', t.name, t.rowCount, JSON.stringify(schema.shards), schema.nextId);
    }
    report.tables.push(t);
  });

  // --- 孤立シャードシート(カタログ未登録の {name}__{n} 形式シート) ---
  db.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name === SCHEMA_SHEET_NAME) return;
    if (/__\d+$/.test(name) && !referencedShards[name]) {
      report.orphanSheets.push(name);
      problem('孤立シャードシート(カタログ未登録): ' + name + ' — 過去のロールバック失敗や手動操作の残骸の可能性。内容確認のうえ手動削除を推奨');
    }
  });

  // --- セル使用量 ---
  var totalCells = 0;
  db.getSheets().forEach(function (sheet) {
    totalCells += sheet.getMaxRows() * sheet.getMaxColumns();
  });
  report.cellUsage = { cells: totalCells, limit: 10000000, ratio: totalCells / 10000000 };
  Logger.log('[%s] セル使用量: %s / 10,000,000 (%s%%)',
    report.cellUsage.ratio > 0.8 ? 'NG' : 'OK', totalCells, (report.cellUsage.ratio * 100).toFixed(1));
  if (report.cellUsage.ratio > 0.8) {
    problem('セル使用量が上限の80%超。スプレッドシート分割の検討が必要');
  }

  Logger.log(report.ok ? '=== 診断完了: 異常なし ===' : '=== 診断完了: 異常 ' + report.problems.length + '件 ===');
  return report;
}

/**
 * 実環境E2Eセルフテスト。一時テーブル(__selftest_ プレフィックス)を作成して
 * SQL機能一式(算術式・JOIN・集計・サブクエリ・UNION・トランザクション・
 * TEXT自動型変換防止・グリッド拡張・シャード分割)を実際のSheets上で検証し、
 * 終了時に一時テーブルを必ず削除する。
 *
 * 実行時間の目安: 1〜3分(Sheets API呼び出しに依存)。6分制限内に収まる構成。
 */
function runSelfTest() {
  var ts = Date.now();
  var A = '__selftest_a_' + ts;
  var B = '__selftest_b_' + ts;
  var results = [];

  function run(name, fn) {
    try {
      fn();
      results.push({ name: name, ok: true });
      Logger.log('[PASS] %s', name);
    } catch (e) {
      results.push({ name: name, ok: false, error: String(e && e.message || e) });
      Logger.log('[FAIL] %s: %s', name, e && e.message);
    }
  }

  function assertEq(actual, expected, label) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error((label || '検証失敗') + ': 期待=' + b + ' 実際=' + a);
  }

  try {
    run('CREATE TABLE', function () {
      executeSql_('CREATE TABLE ' + A + ' (code TEXT, name TEXT, price INTEGER, qty INTEGER, due DATE)');
      executeSql_('CREATE TABLE ' + B + ' (code TEXT, pref TEXT)');
    });

    run('INSERT(負数・NULL含む)', function () {
      var r = executeSql_(
        'INSERT INTO ' + A + " (code, name, price, qty, due) VALUES " +
        "('0123','りんご',100,3,'2026-01-15'), ('C2','みかん',-50,2,NULL), ('C3','ぶどう',200,1,'2026-06-30')"
      );
      assertEq(r.insertedCount, 3, 'insertedCount');
      executeSql_('INSERT INTO ' + B + " (code, pref) VALUES ('0123','東京都'), ('C2','大阪府')");
    });

    run('TEXT自動型変換の防止(先頭ゼロ保持)', function () {
      // 実Sheetsは書式なしテキスト設定が無いと '0123' を数値123へ変換する
      var r = executeSql_('SELECT code FROM ' + A + " WHERE code = '0123'");
      assertEq(r.rowCount, 1, "code='0123' の一致(数値化されていれば0行になる)");
    });

    run('WHERE 算術式・負数比較', function () {
      assertEq(executeSql_('SELECT name FROM ' + A + ' WHERE price * qty > 150').rowCount, 2);
      assertEq(executeSql_('SELECT name FROM ' + A + ' WHERE price < -10').rowCount, 1);
    });

    run('NULLセマンティクス(IS NULL / 比較不成立)', function () {
      assertEq(executeSql_('SELECT name FROM ' + A + ' WHERE due IS NULL').rowCount, 1);
      assertEq(executeSql_('SELECT name FROM ' + A + " WHERE due != '2026-01-15'").rowCount, 1); // NULL行は不一致扱い
    });

    run('DATE型のBETWEEN比較', function () {
      var r = executeSql_('SELECT name FROM ' + A + " WHERE due BETWEEN '2026-01-01' AND '2026-03-31'");
      assertEq(r.rows.map(function (x) { return x.name; }), ['りんご']);
    });

    run('JOIN(ハッシュ結合パス)+ LEFT JOIN', function () {
      var r = executeSql_('SELECT a.name, b.pref FROM ' + A + ' a JOIN ' + B + ' b ON a.code = b.code ORDER BY a.name');
      assertEq(r.rowCount, 2);
      var l = executeSql_('SELECT a.name FROM ' + A + ' a LEFT JOIN ' + B + ' b ON a.code = b.code WHERE b.code IS NULL');
      assertEq(l.rows.map(function (x) { return x.name; }), ['ぶどう']);
    });

    run('GROUP BY + HAVING + 集計ORDER BY', function () {
      var r = executeSql_(
        'SELECT qty, COUNT(*) AS n, SUM(price * qty) AS total FROM ' + A +
        ' GROUP BY qty HAVING COUNT(*) >= 1 ORDER BY COUNT(*) DESC, qty'
      );
      assertEq(r.rowCount, 3);
    });

    run('サブクエリ(IN・スカラー)', function () {
      var r = executeSql_('SELECT name FROM ' + A + ' WHERE code IN (SELECT code FROM ' + B + ') ORDER BY name');
      assertEq(r.rowCount, 2);
      var s = executeSql_('SELECT name FROM ' + A + ' WHERE price = (SELECT MAX(price) FROM ' + A + ')');
      assertEq(s.rows.map(function (x) { return x.name; }), ['ぶどう']);
    });

    run('UNION / UNION ALL', function () {
      var u = executeSql_('SELECT code FROM ' + A + ' UNION SELECT code FROM ' + B + ' ORDER BY code');
      assertEq(u.rowCount, 3); // 0123, C2, C3
      var ua = executeSql_('SELECT code FROM ' + A + ' UNION ALL SELECT code FROM ' + B);
      assertEq(ua.rowCount, 5);
    });

    run('UPDATE(式)/ DELETE', function () {
      executeSql_('UPDATE ' + A + " SET qty = qty + 10 WHERE code = '0123'");
      assertEq(executeSql_('SELECT qty FROM ' + A + " WHERE code = '0123'").rows[0].qty, 13);
      executeSql_('DELETE FROM ' + A + " WHERE code = 'C3'");
      assertEq(executeSql_('SELECT COUNT(*) AS n FROM ' + A).rows[0].n, 2);
    });

    run('バッチトランザクション(失敗時ロールバック)', function () {
      var before = executeSql_('SELECT COUNT(*) AS n FROM ' + A).rows[0].n;
      var thrown = null;
      try {
        executeSqlBatch_([
          'INSERT INTO ' + A + " (code, name, price, qty, due) VALUES ('TX','一時',1,1,NULL)",
          'SELECT * FROM __no_such_table_' + ts
        ]);
      } catch (e) {
        thrown = e;
      }
      if (!thrown) throw new Error('バッチが失敗しなかった');
      if (thrown.rolledBack !== true) throw new Error('rolledBack フラグが立っていない');
      assertEq(executeSql_('SELECT COUNT(*) AS n FROM ' + A).rows[0].n, before, 'ロールバック後の行数');
    });

    run('グリッド自動拡張(1,000行超のINSERT)', function () {
      // 実Sheetsの新規シートは1,000行グリッド。拡張が無いと out of bounds
      var tuples = [];
      for (var i = 1; i <= 1100; i++) tuples.push("('G" + i + "','行" + i + "'," + i + ',1,NULL)');
      executeSql_('INSERT INTO ' + A + ' (code, name, price, qty, due) VALUES ' + tuples.join(','));
      assertEq(executeSql_('SELECT COUNT(*) AS n FROM ' + A + " WHERE code LIKE 'G%'").rows[0].n, 1100);
    });

    run('シャード自動分割', function () {
      createTable_('__selftest_shard_' + ts, [{ name: 'v', type: 'INTEGER' }], 3);
      var objs = [];
      for (var i = 1; i <= 8; i++) objs.push({ v: i });
      appendRows_('__selftest_shard_' + ts, objs);
      var schema = getTableSchema_('__selftest_shard_' + ts);
      if (schema.shards.length < 3) throw new Error('シャード分割されていない: ' + JSON.stringify(schema.shards));
      assertEq(executeSql_('SELECT SUM(v) AS s FROM __selftest_shard_' + ts).rows[0].s, 36);
    });
  } finally {
    // 一時テーブルの後始末(失敗しても他の削除は続行)
    [A, B, '__selftest_shard_' + ts].forEach(function (t) {
      try { executeSql_('DROP TABLE IF EXISTS ' + t); } catch (e) {
        Logger.log('[WARN] 一時テーブル削除失敗: %s (%s) — diagnoseDatabase() で孤立シートを確認のこと', t, e && e.message);
      }
    });
  }

  var failed = results.filter(function (r) { return !r.ok; });
  Logger.log('=== セルフテスト完了: %s/%s 成功 ===', results.length - failed.length, results.length);
  if (failed.length) {
    failed.forEach(function (f) { Logger.log('  FAIL: %s — %s', f.name, f.error); });
  }
  return { total: results.length, passed: results.length - failed.length, failed: failed.length, results: results };
}

/**
 * DEBUG_SQL に書いたSQLを実行し、所要時間・件数・結果先頭5行をログ出力する。
 * エディタ上の簡易デバッガ。ファイル冒頭の DEBUG_SQL を書き換えてから実行する。
 */
function runDebugQuery() {
  return debugSql_(DEBUG_SQL);
}

/**
 * 任意のSQLを計測付きで実行する(他の関数・自作スクリプトから呼び出し用)。
 * 更新系も実行されるため注意。
 */
function debugSql_(sql) {
  Logger.log('SQL: %s', sql);
  var t0 = Date.now();
  try {
    var result = executeSql_(sql);
    var ms = Date.now() - t0;
    Logger.log('実行時間: %sms', ms);
    if (result.columns) {
      Logger.log('列: %s / %s行', JSON.stringify(result.columns), result.rowCount);
      result.rows.slice(0, 5).forEach(function (row, i) { Logger.log('  [%s] %s', i, JSON.stringify(row)); });
      if (result.rowCount > 5) Logger.log('  ...(残り %s 行省略)', result.rowCount - 5);
    } else {
      Logger.log('結果: %s', JSON.stringify(result));
    }
    return { ok: true, ms: ms, result: result };
  } catch (e) {
    var ms2 = Date.now() - t0;
    Logger.log('エラー(%sms): [%s] %s', ms2, e.code || e.name, e.message);
    return { ok: false, ms: ms2, code: e.code, message: e.message };
  }
}
