/**
 * バックアップ機能。DBスプレッドシート全体をDrive上の別ファイルとして複製・世代管理する。
 *
 * 設計方針(データ保全最優先):
 *  - バックアップは「別スプレッドシートファイル」として保存する。DB本体のシートには一切手を加えない
 *    (シート内バックアップは孤立シート診断と衝突し、セル上限も圧迫するため不採用)。
 *  - 復元はバックアップファイル自体を有効化せず「バックアップの複製」を新しいDB本体として紐付ける。
 *    バックアップは復元後も無傷で残り、復元前のDB本体ファイルも削除しない(手動復旧の余地を残す)。
 *  - 作成・復元はスクリプトロック配下で行い、書き込み中のコピーによる不整合スナップショットを防ぐ。
 *
 * Apps Scriptエディタから手動実行、または setupDailyBackupTrigger() で毎日自動実行。
 */

/**
 * バックアップを作成する。DB全体(全テーブル・カタログ)を新しいスプレッドシートへ複製し、
 * 世代リストへ記録する。保持世代数(既定14、ScriptProperties の BACKUP_RETENTION で変更可)を
 * 超えた古いバックアップはゴミ箱へ移動する(Driveのゴミ箱保持期間中は手動復旧可能)。
 *
 * @param {string=} label 任意のラベル(例: 'daily', '移行前')。ファイル名に含まれる。
 * @return {Object} { id, name, url, createdAt, pruned: [削除したバックアップ名] }
 */
function createBackup(label) {
  return withScriptLock_(function () {
    var db = getDb_();
    SpreadsheetApp.flush(); // 保留中の書き込みを確定してからコピーする

    var now = new Date();
    var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
    var name = 'GAS-DB-backup-' + stamp + (label ? '-' + String(label) : '');
    var copy = db.copy(name);

    var backups = readBackupRegistry_();
    backups.unshift({ id: copy.getId(), name: name, createdAt: now.toISOString(), label: label || null });

    // 保持世代数を超えた古いバックアップをゴミ箱へ
    var retention = getBackupRetention_();
    var pruned = [];
    while (backups.length > retention) {
      var old = backups.pop();
      try {
        DriveApp.getFileById(old.id).setTrashed(true);
        pruned.push(old.name);
      } catch (e) {
        // 手動削除済み等でファイルが見つからない場合もレジストリからは除去する
        Logger.log('[WARN] 旧バックアップのゴミ箱移動に失敗(レジストリからは除去): %s (%s)', old.name, e.message);
        pruned.push(old.name + ' (ファイル削除失敗)');
      }
    }
    writeBackupRegistry_(backups);

    Logger.log('バックアップ作成完了: %s (%s)', name, copy.getId());
    if (pruned.length) Logger.log('保持世代数(%s)超過のため削除: %s', retention, pruned.join(', '));
    return { id: copy.getId(), name: name, url: copy.getUrl(), createdAt: now.toISOString(), pruned: pruned };
  });
}

/**
 * 毎日自動バックアップ用のトリガーハンドラ(setupDailyBackupTrigger が登録する)。
 */
function createDailyBackup() {
  try {
    return createBackup('daily');
  } catch (e) {
    // トリガー実行は失敗してもリトライされないため、ログに確実に残す
    Logger.log('[ERROR] 自動バックアップ失敗: %s', e && e.message);
    throw e;
  }
}

/**
 * 毎日の自動バックアップトリガーを設定する(既存の同ハンドラのトリガーは置き換え)。
 * @param {number=} hour 実行時刻(0-23、既定3 = 深夜3時台)
 */
function setupDailyBackupTrigger(hour) {
  var h = (hour === undefined || hour === null) ? 3 : hour;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'createDailyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('createDailyBackup').timeBased().everyDays(1).atHour(h).create();
  Logger.log('自動バックアップトリガー設定完了: 毎日%s時台に createDailyBackup を実行', h);
}

/**
 * バックアップ一覧を返す(新しい順)。ファイルが手動削除・ゴミ箱移動済みの場合は missing: true が付く。
 */
function listBackups() {
  var backups = readBackupRegistry_();
  var out = backups.map(function (b) {
    var entry = { id: b.id, name: b.name, createdAt: b.createdAt, label: b.label, missing: false };
    try {
      var file = DriveApp.getFileById(b.id);
      if (file.isTrashed()) entry.missing = true;
    } catch (e) {
      entry.missing = true;
    }
    return entry;
  });
  out.forEach(function (b) {
    Logger.log('%s %s (%s)%s', b.createdAt, b.name, b.id, b.missing ? ' [消失]' : '');
  });
  return out;
}

/**
 * バックアップから復元する。
 * バックアップファイルの「複製」を作成して新しいDB本体として紐付ける(バックアップ自体は変更しない)。
 * 復元前のDB本体ファイルは削除せずそのまま残る(IDはログと戻り値で確認可能)。
 *
 * @param {string} backupId listBackups() で確認したバックアップのスプレッドシートID
 * @return {Object} { restoredFrom, oldDbId, newDbId, newDbUrl }
 */
function restoreFromBackup(backupId) {
  if (!backupId) throw new SqlError('BAD_REQUEST', 'backupId が未指定。listBackups() でIDを確認すること');
  return withScriptLock_(function () {
    var registry = readBackupRegistry_();
    var known = registry.some(function (b) { return b.id === backupId; });
    if (!known) {
      Logger.log('[WARN] レジストリ未登録のID: %s — バックアップ以外のスプレッドシートを指定していないか確認', backupId);
    }

    var source;
    try {
      source = SpreadsheetApp.openById(backupId);
    } catch (e) {
      throw new SqlError('BACKUP_NOT_FOUND', 'バックアップを開けない: ' + backupId + ' (' + e.message + ')');
    }
    // 復元対象がGAS-DBのバックアップであることをカタログシートの存在で検証する
    if (!source.getSheetByName(SCHEMA_SHEET_NAME)) {
      throw new SqlError('BACKUP_INVALID', '指定ファイルに ' + SCHEMA_SHEET_NAME + ' シートが無い(GAS-DBのバックアップではない): ' + backupId);
    }

    var oldDbId = PropertiesService.getScriptProperties().getProperty(PROP_DB_SPREADSHEET_ID);
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
    var restored = source.copy('GAS-DB-restored-' + stamp);

    PropertiesService.getScriptProperties().setProperty(PROP_DB_SPREADSHEET_ID, restored.getId());
    invalidateDbCache_();

    Logger.log('復元完了: バックアップ %s → 新DB %s', backupId, restored.getId());
    Logger.log('旧DB(%s)は削除していない。動作確認後、不要なら手動でゴミ箱へ移動すること', oldDbId);
    return { restoredFrom: backupId, oldDbId: oldDbId, newDbId: restored.getId(), newDbUrl: restored.getUrl() };
  });
}

/**
 * 指定バックアップをゴミ箱へ移動しレジストリから除去する。
 */
function deleteBackup(backupId) {
  var backups = readBackupRegistry_();
  var idx = -1;
  for (var i = 0; i < backups.length; i++) {
    if (backups[i].id === backupId) { idx = i; break; }
  }
  if (idx === -1) throw new SqlError('BACKUP_NOT_FOUND', 'レジストリに存在しないバックアップID: ' + backupId);
  try {
    DriveApp.getFileById(backupId).setTrashed(true);
  } catch (e) {
    Logger.log('[WARN] ファイルのゴミ箱移動に失敗(レジストリからは除去): %s', e.message);
  }
  backups.splice(idx, 1);
  writeBackupRegistry_(backups);
  Logger.log('バックアップ削除完了: %s', backupId);
}

// ---------- 内部ヘルパー ----------

function readBackupRegistry_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_BACKUPS);
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // レジストリ破損時は空扱いで継続する(バックアップ作成自体を止めない)。
    // 実ファイルはDrive上に残っているため、必要ならDriveで "GAS-DB-backup-" を検索して手動復旧可能。
    Logger.log('[WARN] バックアップレジストリのJSONが破損しているため初期化する: %s', e.message);
    return [];
  }
}

function writeBackupRegistry_(backups) {
  PropertiesService.getScriptProperties().setProperty(PROP_BACKUPS, JSON.stringify(backups));
}

function getBackupRetention_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_BACKUP_RETENTION);
  var n = raw === null ? NaN : Number(raw);
  if (!isFinite(n) || n % 1 !== 0 || n < 1) return DEFAULT_BACKUP_RETENTION;
  return n;
}
