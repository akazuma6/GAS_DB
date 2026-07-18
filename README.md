# GAS-DB

[![test](https://github.com/akazuma6/GAS_DB/actions/workflows/test.yml/badge.svg)](https://github.com/akazuma6/GAS_DB/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Googleスプレッドシートを、SQLで操作できるデータベースサーバーに変える Google Apps Script (GAS) プロジェクト。**

デプロイするとHTTP(S)エンドポイントが手に入り、外部のWebアプリやスクリプトからJSONでSQLを投げられるようになります。サーバー代はゼロ。データの実体はただのスプレッドシートなので、ブラウザで開けばそのまま中身を確認・修正できます。

```bash
curl -L 'https://script.google.com/macros/s/xxxx/exec' \
  --data '{"apiKey":"xxxx","sql":"SELECT name, tel FROM 顧客マスタ WHERE pref = ? LIMIT 10","params":["東京都"]}' \
  -H 'Content-Type: application/json'
```

```json
{ "success": true, "client": "顧客管理アプリ", "result": { "columns": ["name", "tel"], "rows": [...], "rowCount": 10 } }
```

## 特徴

- **本格的なSQL対応** — SELECT / INSERT / UPDATE / DELETE / CREATE / DROP に加え、JOIN(ハッシュ結合による高速化つき)、GROUP BY + 集計関数、HAVING、サブクエリ、UNION、算術式、`?` プレースホルダによるパラメータバインドまでサポート
- **自動シャーディング** — 1テーブルが行数閾値(既定40,000行)を超えると自動で複数シートに分割。SELECTは全シャードを透過的に横断するので、利用側は分割を意識しなくてよい
- **アトミックなバッチ実行** — 複数文をまとめて送ると単一ロック下で all-or-nothing 実行。途中で失敗したら変更された全テーブルをバッチ開始時点へ自動ロールバック
- **SQLインジェクション不能** — `?` バインドは値をリテラルとしてトークン化するため、クライアント側のエスケープ処理が不要
- **APIキー認証・バックアップ世代管理・整合性診断ツール**を同梱
- **追加依存ゼロ** — GASの標準機能だけで動作。npmパッケージのインストールも外部サービスも不要
- **GAS環境なしでテスト可能** — GAS APIをNode.js上でモックし、デプロイするコードそのままを174件のテストで検証。GitHub ActionsでCI済み

## 想定用途

「RDBを立てるほどではないが、スプレッドシートの直編集は卒業したい」規模の小さな業務システムや個人開発に向いています(顧客管理・タスク管理・勤怠などのサンプルテーブル定義を同梱)。

> ⚠️ 本物のRDBMSの代替ではありません。全データをメモリにロードして処理するため、数十万行を超える規模や高頻度の同時書き込みが必要なら PostgreSQL 等を使ってください。

## 仕組み

```
外部アプリ ──JSON/SQL──▶ GAS Web App (doPost/doGet)
                            │  字句解析 → 構文解析(AST) → 実行エンジン
                            ▼
                      Googleスプレッドシート
                        ├─ _schema        ← カタログ(テーブル定義・シャード一覧・採番)
                        ├─ 顧客マスタ_1    ← シャード1(〜40,000行)
                        ├─ 顧客マスタ_2    ← シャード2(閾値超過で自動追加)
                        └─ ...
```

- **1テーブル = 複数シート(シャード)**。1シートあたりの行数閾値を超えると自動で新規シートを追加し、以降のINSERTはそこへ書き込む
- `_schema` シートがカタログ(テーブル名・列定義・所属シャード一覧・次の採番ID)を管理
- 各行には内部列 `__id`(連番PK)・`__created_at`・`__updated_at` を自動付与

```
src/
  appsscript.json   マニフェスト(Web App設定)
  Constants.js      定数
  Utils.js          共通ユーティリティ・SqlError
  SchemaManager.js  _schema カタログ管理
  ShardStore.js     シャード単位の物理読み書き・自動分割
  SqlLexer.js       字句解析
  SqlParser.js      構文解析(再帰下降パーサー)→ AST
  SqlExecutor.js    AST実行エンジン(WHERE/JOIN/GROUP BY/集計/ORDER BY/LIMIT)
  Auth.js           APIキー認証
  Main.js           doGet/doPost エンドポイント
  Setup.js          初回セットアップ用関数(手動実行)
  Diagnostics.js    実環境の診断・セルフテスト・SQLデバッグ(手動実行)
  Backup.js         バックアップ(作成・一覧・復元・世代管理・自動化)
```

## セットアップ

[clasp](https://github.com/google/clasp) を使ってデプロイします。

1. `clasp create --type standalone --title "GAS-DB"`(既存プロジェクトを使う場合は `.clasp.json` を作成し `scriptId` と `"rootDir": "src"` を設定)
2. `clasp push` でソース一式をアップロード
3. Apps Scriptエディタで `initializeDatabase()` を一度実行(DB用スプレッドシートを新規作成しScriptPropertiesへ登録)
   - 既存スプレッドシートを使う場合は代わりに `setDatabaseSpreadsheetId_('スプレッドシートID')` を実行
4. 必要なら `setupSampleTables_()` を実行(顧客マスタ / 進捗管理 / 勤怠のサンプルテーブル作成)
5. `issueApiKeyForClient('クライアント名')` を実行し、ログに出力されたAPIキーを控える(呼び出し元アプリに設定)
6. デプロイ → ウェブアプリとして導入
   - 実行ユーザー: **自分**
   - アクセスできるユーザー: **全員(匿名可)** ※認証はAPIキーで行う
   - 発行されたURLが外部からのエンドポイント

デプロイ直後は `runSelfTest()` → `diagnoseDatabase()` を実行して異常なしを確認し、`createBackup('初期')` と `setupDailyBackupTrigger()` でバックアップ体制を整えるのがおすすめです(後述)。

## API仕様

GAS Web AppはカスタムHTTPヘッダーを読み取れないため、APIキーは**リクエストボディまたはクエリパラメータ**で渡します。

### POST(推奨)

```
POST https://script.google.com/macros/s/xxxx/exec
Content-Type: application/json

{ "apiKey": "xxxx", "sql": "SELECT * FROM 顧客マスタ WHERE pref = '東京都'" }
```

`?` プレースホルダ + `params` でパラメータバインド(値は `string` / `number` / `boolean` / `null` のみ。個数不一致は `BAD_REQUEST`):

```json
{ "apiKey": "xxxx", "sql": "SELECT * FROM 顧客マスタ WHERE pref = ? AND rank > ?", "params": ["東京都", 3] }
```

複数文のアトミック実行(要素は文字列または `{ sql, params }`):

```json
{ "apiKey": "xxxx", "sqls": ["INSERT INTO ...", { "sql": "INSERT INTO 勤怠 (氏名) VALUES (?)", "params": ["山田"] }] }
```

レスポンス(HTTPステータスは常に200。`success` で判定する):

```json
{ "success": true, "client": "クライアント名", "result": { "columns": [...], "rows": [...], "rowCount": 2 } }
```
```json
{ "success": false, "code": "AUTH_FAILED", "message": "APIキー不正" }
```

バッチ失敗時は失敗した文の位置(0始まり)とロールバック実施が返ります:

```json
{ "success": false, "code": "NO_SUCH_COLUMN", "message": "...", "statementIndex": 2, "rolledBack": true }
```

### GET(簡易確認用、SELECTのみ許可)

```
GET https://script.google.com/macros/s/xxxx/exec?apiKey=xxxx&sql=SELECT+*+FROM+顧客マスタ+LIMIT+10
```

`?` バインドは `&params=["東京都",3]`(JSON配列をURLエンコード)で指定可。更新系文は `METHOD_NOT_ALLOWED` で拒否されます(判定は文字列前方一致ではなくASTの文種別で行うため、コメント付与等でのすり抜けは不可)。

### 接続時の注意(実機確認済み)

- GAS Web Appは**302リダイレクト**で応答を返すため、HTTPクライアントはリダイレクト追従が必要
- curlで試す場合は `-L` を付け、`-X POST` を**使わない**こと(`-X POST` はリダイレクト先にもPOSTを強制して失敗する。POSTは `--data` 指定で自動選択させる)
- LLM/AIエージェントにAPIの叩き方を教える場合は、トークン効率を優先した高密度リファレンス [docs/USAGE.md](docs/USAGE.md) をそのままコンテキストに貼れます

## サポートするSQL構文

| 分類 | 内容 |
|---|---|
| DDL | `CREATE TABLE [IF NOT EXISTS]`(型: `INTEGER`/`INT`, `REAL`/`FLOAT`, `TEXT`/`VARCHAR`, `BOOLEAN`, `DATE`, `DATETIME`。制約: `NOT NULL`, `DEFAULT`)、`DROP TABLE [IF EXISTS]` |
| DML | `INSERT`(複数VALUES可)、`UPDATE`(自列参照式可: `SET stock = stock - 1`)、`DELETE` |
| SELECT | `DISTINCT`、`COUNT/SUM/AVG/MIN/MAX`、`[INNER\|LEFT [OUTER]] JOIN`(複数可)、`WHERE`、`GROUP BY`、`HAVING`、`ORDER BY`(式・エイリアス・集計可)、`LIMIT n [OFFSET m]` |
| 条件演算子 | `= != < <= > >= AND OR NOT LIKE(% _) IN (...) IS [NOT] NULL BETWEEN a AND b` |
| サブクエリ | 非相関のみ: `WHERE x IN (SELECT ...)`、スカラー `WHERE x = (SELECT MAX(...) ...)`、SELECT列 `(SELECT COUNT(*) ...) AS n`(0行→NULL、複数行→エラー) |
| 集合演算 | `UNION [ALL]`(列数一致必須、列名は先頭SELECTを採用) |
| 算術式 | `+ - * /`、括弧、単項符号。SELECT列・WHERE・HAVING・ORDER BY・UPDATE SET・集計引数(`SUM(price * qty)`)で使用可 |
| その他 | テーブル名・列名に日本語使用可。`--` コメント対応 |

セマンティクスの要点:

- `DEFAULT` はINSERTで列未指定時に適用(明示的な `NULL` は上書きしない)。`NOT NULL` 違反時は `NOT_NULL_VIOLATION` で1行も書き込まない
- `PRIMARY KEY` はメタデータのみ(主キーは常に自動採番の `__id`)。`UNIQUE` / `FOREIGN KEY` / `CHECK` は未対応
- NULLとの比較(`=` / `!=` 含む)は常に不成立。判定は `IS [NOT] NULL` を使う。ORDER BYではNULLを最小値として扱う(SQLite準拠)
- NULLを含む算術演算・0除算はNULLを返す(SQLite準拠)

## パフォーマンス

- ONが単一の等値条件(`ON a.k = b.k`)のJOINは自動的に**ハッシュ結合 O(N+M)** になる(実測: 3,000行×3,000行で約1,000倍高速)。複合条件・非等値のONはネステッドループで評価
- スプレッドシートハンドル・`_schema` カタログは同一リクエスト内でキャッシュされ、Sheets API呼び出しを削減。書き込み系はロック取得直後にキャッシュを破棄して読み直すため、ID採番等の整合性は保たれる

## トランザクション

`sqls` バッチはアトミック実行されます。バッチ全体を単一のスクリプトロック配下で実行し、途中の文が失敗した場合は変更された全テーブル(データ・スキーマ・採番カウンタ)をバッチ開始時点のスナップショットへロールバックします。

- スナップショットは「バッチ内で最初に変更される時」にテーブル単位で取得(全シャードのメモリコピー)。巨大テーブルを更新するバッチはメモリ・実行時間に注意
- 単文実行(`sql`)はロールバック対象外(1文のみのため実質アトミック)
- ロールバック自体が一部失敗した場合(Sheets APIエラー等)は残りのテーブルの復元を継続したうえで `rolledBack: false` + `rollbackErrors` が返る。この場合は `diagnoseDatabase()` で整合性を確認し、必要なら直近バックアップから復元する

## 既知の制限

- 相関サブクエリ・`EXISTS` 未対応(サブクエリは外側の行を参照できない)
- UNIONの `ORDER BY` は出力列名のみ指定可
- GASの制約に従う: 1実行あたり最大6分、同時実行はスクリプトロックで直列化、1スプレッドシートのセル数上限1,000万(到達時のスプレッドシート分割は未実装。使用率は `diagnoseDatabase()` で監視できる)

## 実環境での検査・デバッグ

Apps Scriptエディタから選択実行します(HTTP経由では呼び出せません)。

| 関数 | 用途 |
|---|---|
| `diagnoseDatabase()` | 読み取りのみの整合性診断。DB到達性、`_schema` のJSON破損、シャードシートの実在・ヘッダー整合、`__id` 重複、nextId巻き戻り(ID衝突リスク)、孤立シャードシート、セル使用量を検査しレポートを返す |
| `runSelfTest()` | 実Sheets上のE2Eセルフテスト(13ケース)。一時テーブルでCRUD・JOIN・集計・サブクエリ・UNION・バッチロールバック・シャード分割等を検証し、終了時に自動削除。目安1〜3分 |
| `runDebugQuery()` | ファイル冒頭の `DEBUG_SQL` に書いたSQLを計測付きで実行し、所要時間・件数・先頭5行をログ出力 |

## バックアップ

DBスプレッドシート全体をDrive上の**別ファイル**として複製・世代管理します。DB本体のシートには一切手を加えません。Apps Scriptエディタから手動実行します。

| 関数 | 用途 |
|---|---|
| `createBackup(label?)` | 今すぐバックアップ作成。ロック取得+`flush()` 後にコピーするため書き込み途中の不整合スナップショットにならない。保持世代数(既定14)超過分は自動でゴミ箱へ |
| `setupDailyBackupTrigger(hour?)` | 毎日の自動バックアップトリガーを登録(既定は深夜3時台)。再実行すると置き換え |
| `listBackups()` | 世代一覧(新しい順) |
| `restoreFromBackup(backupId)` | 復元。バックアップの**複製**を新しいDB本体として紐付ける。バックアップ自体も復元前の旧DBも無傷で残る |
| `deleteBackup(backupId)` | 指定世代をゴミ箱へ移動しレジストリから除去 |

- 保持世代数の変更: ScriptPropertiesに `BACKUP_RETENTION` を設定(例: `30`)
- レジストリ(ScriptProperties)が破損しても `createBackup` は自己修復して続行。実ファイルはDriveで `GAS-DB-backup-` を検索すれば見つかる

## 開発・テスト

GAS依存部分(`SpreadsheetApp` / `PropertiesService` / `LockService` 等)をNode.jsの `vm` モジュール上でモックし([test/support/gasMock.js](test/support/gasMock.js))、**デプロイするコードそのまま**をGAS環境なしに単体テストできる構成です。テストごとに独立したサンドボックスを生成するため、テスト間の状態漏れはありません。

```bash
npm test   # Node 18+ 標準の node:test で全174テストを実行(追加依存なし)
```

モックは実GASの挙動(空セルが `''` で返る、グリッド外アクセス例外、TEXT列の自動型変換対策 等)を再現していますが、`LockService` の実競合・6分実行制限・quotaは再現できません。そこは実環境の `runSelfTest()` でカバーします。

CIは [GitHub Actions](.github/workflows/test.yml) でNode 18 / 20 / 22 に対し push / PR ごとに `npm test` を実行します。機能追加・バグ修正時は対応するテストを [test/](test/) に追加し、グリーンを確認してからコミットしてください。

## ライセンス

[MIT](LICENSE)
