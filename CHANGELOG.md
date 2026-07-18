# Changelog

## 2026-07-09 (5回目: 実環境診断ツール)

### Added

- **`src/Diagnostics.js`**: Apps Scriptエディタから手動実行する実環境検査関数群。
  - `diagnoseDatabase()` — 読み取りのみの整合性診断(DB到達性、`_schema`のJSON破損、シャードシートの実在・ヘッダー整合、`__id`重複、nextId巻き戻りによるID衝突リスク、孤立シャードシート、セル使用量80%警告)
  - `runSelfTest()` — 実Sheets上のE2Eセルフテスト13ケース(CRUD・算術式・NULLセマンティクス・DATE比較・JOIN/LEFT JOIN・集計・サブクエリ・UNION・バッチロールバック・TEXT自動型変換防止・グリッド拡張1,100行・シャード分割)。一時テーブルは終了時に自動削除
  - `runDebugQuery()` / `debugSql_(sql)` — 任意SQLの計測付き実行(所要時間・件数・先頭5行をログ出力)

### Tests

- `test/diagnostics.test.js` を新設(7テスト): モック上での`runSelfTest`全通過と後始末、`diagnoseDatabase`の異常検出(孤立シート・nextId巻き戻り・シャード欠損・未初期化)。計143テスト全パス。

## 2026-07-09 (4回目: テスト増強・実GAS忠実性)

### Fixed

- **実GASのグリッド上限で書き込みが失敗する潜在バグ**: 新規シートのグリッドは1,000行×26列で、グリッド外への `getRange()` は実GASでは例外になる。1,000行超のINSERTで確実に発生する不具合だったが、旧モックがグリッド制限を再現していなかったため検出不能だった。書き込み前に `ensureSheetCapacity_()` で行・列を自動拡張するよう修正。
- **実GASのSheets自動型変換によるTEXT値の破壊を防止**: `'0123'`→`123`(先頭ゼロ喪失)や `'2026-01-01'`→Date のような自動変換を防ぐため、シャードシート作成時にTEXT列へ `setNumberFormat('@')`(書式なしテキスト)を設定。

### Changed

- **モックの実GAS忠実化**([test/support/gasMock.js](test/support/gasMock.js)): `getLastRow()` を「内容がある最終行」ベースへ(clearContent後に縮む実GAS仕様)、`setValues()` の次元不一致例外、グリッド(1,000行×26列)外アクセス例外、`getMaxRows`/`insertRowsAfter`/`setNumberFormat` を追加。

### Tests

- `test/complex.test.js` を新設(13テスト): 複合クエリ(JOIN+サブクエリ+GROUP BY+HAVING+集計ORDER BY+LIMIT、アンチジョイン、COUNT(DISTINCT)、UNION+JOIN、3テーブルJOINページング、1,500行INSERT)とロールバック境界(シャード分割跨ぎの物理シート復元、6シャード300行の完全一致復元、先頭文失敗、DROP→再CREATE→失敗からの完全復帰、連続バッチ独立性、読み書き混在)。計136テスト全パス。

## 2026-07-09 (3回目: サブクエリ・UNION・トランザクション)

### Added

- **サブクエリ(非相関)**: `WHERE x IN (SELECT col FROM ...)` / `NOT IN`、スカラーサブクエリ(`WHERE x = (SELECT MAX(...) ...)`、SELECT列 `(SELECT COUNT(*) ...) AS n`)。スカラーは0行→NULL、複数行→`SUBQUERY_ERROR`。1文の実行内でメモ化され1回のみ評価。UNIONを含むサブクエリも可。
- **UNION / UNION ALL**: 左結合の段階評価(SQL標準準拠)。列数一致必須(`UNION_COLUMN_MISMATCH`)、列名は先頭SELECTを採用し位置ベースで揃える。`ORDER BY`(出力列名のみ)/`LIMIT`/`OFFSET` は複合結果全体へ適用。doGetでも読み取り系として許可。
- **sqlsバッチのトランザクション化**: バッチ全体を単一スクリプトロックで実行し、途中失敗時は変更された全テーブル(シャードデータ・スキーマ定義・nextId採番)をバッチ開始時点のスナップショットへロールバック。CREATE/DROPのロールバック(作成取消・データごと復元)にも対応。エラーレスポンスに `statementIndex` / `rolledBack` を付与。
- **ロック再入機構 `withScriptLock_`**: GAS LockService の同一実行内再取得が未保証のため、実行内深度カウンタで再入を検出し最外殻のみ実ロックを取得。全書き込み経路(INSERT/UPDATE/DELETE/CREATE/DROP/バッチ)を統一。

### Tests

- `test/advanced.test.js` を新設(16テスト)。計123テスト全パス。

## 2026-07-09 (2回目: 機能拡張・性能改善)

### Added

- **算術式サポート**: `+ - * /`、括弧、単項符号を式として解釈(優先順位: 単項符号 > `* /` > `+ -`)。SELECT列・WHERE・HAVING・ORDER BY・集計関数の引数(`SUM(price * qty)`)で使用可。NULLを含む演算・0除算はNULLを返す(SQLite準拠)。
- **UPDATE SET 式対応**: `SET stock = stock - 1` のような自列参照式が使用可能に。複数代入は更新前の行値で評価される(`SET a = b, b = a` でスワップ成立)。
- **ORDER BY 式・集計対応**: `ORDER BY price * qty DESC` や `ORDER BY COUNT(*) DESC`(SELECTにエイリアスが無くても可)をサポート。既知の制限から削除。
- **等値JOINのハッシュ結合**: ONが単一の等値条件の場合、ネステッドループO(N*M)からハッシュ結合O(N+M)へ自動切替。実測3,000×3,000行で5,822ms→5ms(約1,164倍)。Date値混在時・複合条件時は従来のネステッドループへフォールバックし等価性セマンティクスを完全維持。
- **実行内キャッシュ**: `SpreadsheetApp.openById()` と `_schema` カタログ全読みを同一実行内でキャッシュしSheets API呼び出しを大幅削減。書き込み系(INSERT/UPDATE/DELETE/CREATE/DROP)はロック取得直後にキャッシュ破棄して再読込するため、並行実行時のID採番整合性は不変。

### Changed

- **バリデーション強化**: `LIMIT`/`OFFSET` は非負整数のみ許可(`LIMIT 1.5` はSYNTAX_ERROR)。INSERTの列指定重複は `DUPLICATE_COLUMN` エラー。
- **doGet のSELECT判定をAST基準へ**: 文字列前方一致からパース結果の文種別判定に変更。先頭コメント付きSELECTを許容しつつ、更新系のすり抜けを構文レベルで遮断。

### Tests

- `test/enhancements.test.js` を新設(20テスト)。計107テスト全パス。

## 2026-07-09

### Fixed

- **負数リテラル未対応**: `-` / `+` がレクサで「不正な文字」エラーになり、`INSERT INTO t VALUES (-5)` や `WHERE v < -1` 等の符号付き数値を含むSQLが全て実行不能だった。レクサに `-`/`+` のOPトークンを追加し、パーサー(`parseLiteral_`/`parseOperand_`)で符号付き数値リテラルとして解釈するよう修正(`--` コメントは従来通り)。
- **NULL格納値の比較セマンティクス**: 実GASの `getValues()` は空セルを `''` で返すため、NULLを格納した列が読み出し後 `''` となり `WHERE v != 5` 等でNULL行がマッチしてしまう潜在バグがあった(テストモックがnullをそのまま返していたため検出されず)。`readTableRows_` で `''` → `null` へ正規化し、モックも実GAS仕様(`null` → `''`)に忠実化。
- **ORDER BYのNULL順序が非決定的**: NULL混在列のソートで比較が常にfalseとなり順序が入力順依存だった。NULLを最小値として扱う(ASCで先頭、DESCで末尾。SQLite準拠)よう修正。
- **GROUP BY複合キーの区切り文字**: グループキー結合の区切りにソース上不可視の生制御文字(`\x01`)が埋め込まれていた。動作は同一のまま明示的なエスケープ表記 `'\u0001'` へ置換(エディタ・diffでの欠落事故防止)。

### Tests

- `regression.test.js` に regression#5〜#8 を追加(負数リテラル、GROUP BY複合キー衝突、NULL比較セマンティクス、ORDER BY NULL順序)。計87テスト全パス。
