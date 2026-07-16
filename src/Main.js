/**
 * Web App エンドポイント。外部Webアプリからは基本 doPost() でJSONを送ってSQLを実行する。
 *
 * リクエスト例(POST body, JSON):
 *   { "apiKey": "xxxx", "sql": "SELECT * FROM customers WHERE pref = '東京都'" }
 * ? プレースホルダ使用時(値はリテラルとしてバインドされ、SQLインジェクション不能):
 *   { "apiKey": "xxxx", "sql": "SELECT * FROM customers WHERE pref = ? AND rank > ?", "params": ["東京都", 3] }
 * 複数文をまとめて実行する場合(要素は文字列または { sql, params }):
 *   { "apiKey": "xxxx", "sqls": ["INSERT ...", { "sql": "INSERT INTO t (a) VALUES (?)", "params": [1] }] }
 *
 * レスポンス例:
 *   { "success": true, "client": "clientName", "result": { "columns": [...], "rows": [...] } }
 *   { "success": false, "code": "AUTH_FAILED", "message": "APIキー不正" }
 */

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var apiKey = body.apiKey || (e && e.parameter && e.parameter.apiKey);
    var clientName = validateApiKey_(apiKey);

    if (Array.isArray(body.sqls)) {
      // バッチはアトミック実行(全体ロック+失敗時は全文ロールバック)
      var results = executeSqlBatch_(body.sqls);
      return jsonOutput_({ success: true, client: clientName, results: results });
    }

    if (!body.sql) throw new SqlError('BAD_REQUEST', 'sql (または sqls) が未指定');
    var result = executeSql_(body.sql, body.params);
    return jsonOutput_({ success: true, client: clientName, result: result });
  } catch (err) {
    return jsonOutput_(errorResponse_(err));
  }
}

/**
 * 動作確認・単純なSELECT専用の簡易GETエンドポイント。
 * 例: ?apiKey=xxxx&sql=SELECT+*+FROM+customers+LIMIT+10
 * 更新系文はGET経由では拒否する(URLがログ等に残るリスクを避けるため)。
 */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.ping) return jsonOutput_({ success: true, message: 'pong' });

    var clientName = validateApiKey_(p.apiKey);
    if (!p.sql) throw new SqlError('BAD_REQUEST', 'sql が未指定');
    // ?params=["東京都",3] のようにJSON配列で ? プレースホルダへバインド可能
    var params;
    if (p.params) {
      try {
        params = JSON.parse(p.params);
      } catch (parseErr) {
        throw new SqlError('BAD_REQUEST', 'params がJSONとして不正: ' + parseErr.message);
      }
    }
    // 文字列前方一致ではなくASTの文種別で判定する(先頭コメント付きSELECTを許容しつつ、
    // 偽装プレフィックス等での更新系すり抜けを構文レベルで遮断)。
    var ast = parseSql_(p.sql, params);
    if (ast.type !== 'SELECT' && ast.type !== 'UNION') {
      throw new SqlError('METHOD_NOT_ALLOWED', 'GET経由はSELECTのみ許可');
    }
    var result = executeSql_(p.sql, params);
    return jsonOutput_({ success: true, client: clientName, result: result });
  } catch (err) {
    return jsonOutput_(errorResponse_(err));
  }
}

function errorResponse_(err) {
  var res;
  if (err instanceof SqlError) {
    res = { success: false, code: err.code, message: err.message };
  } else {
    res = { success: false, code: 'INTERNAL_ERROR', message: String((err && err.message) || err) };
  }
  // バッチ実行の失敗情報(失敗した文の0始まりインデックスとロールバック実施済みフラグ)
  if (err && err.statementIndex !== undefined) {
    res.statementIndex = err.statementIndex;
    res.rolledBack = err.rolledBack === true;
  }
  return res;
}
