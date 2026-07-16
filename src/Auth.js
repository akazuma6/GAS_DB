/**
 * APIキー認証。
 * GAS Web AppはカスタムHTTPヘッダーを読み取れないため、APIキーはリクエストボディ(JSON)
 * または クエリパラメータ ?apiKey=... で渡す運用とする。
 */

function validateApiKey_(key) {
  if (!key) throw new SqlError('AUTH_REQUIRED', 'APIキー未指定');
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_API_KEYS);
  var map = raw ? JSON.parse(raw) : {};
  var found = null;
  Object.keys(map).forEach(function (name) {
    if (map[name] === key) found = name;
  });
  if (!found) throw new SqlError('AUTH_FAILED', 'APIキー不正');
  return found;
}

/**
 * 新規クライアント用APIキーを発行しScriptPropertiesへ保存する。
 * Apps Scriptエディタから手動実行して使用する(Webからは呼び出し不可)。
 */
function issueApiKey_(clientName) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(PROP_API_KEYS);
  var map = raw ? JSON.parse(raw) : {};
  var key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  map[clientName] = key;
  props.setProperty(PROP_API_KEYS, JSON.stringify(map));
  Logger.log('client=%s apiKey=%s', clientName, key);
  return key;
}

function revokeApiKey_(clientName) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(PROP_API_KEYS);
  var map = raw ? JSON.parse(raw) : {};
  delete map[clientName];
  props.setProperty(PROP_API_KEYS, JSON.stringify(map));
}
