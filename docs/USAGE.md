# GAS-DB API contract (dense ref, see README.md for full spec)

endpoint: POST|GET $API_URL(=script.google.com/macros/s/xxxx/exec). 302redirect必須追従、curl→`-L`のみ`-X POST`禁止(強制POST化しredirect先で失敗)。Go/fetch等は自動追従で無関係。

req: POST body {apiKey,sql,params?} | {apiKey,sqls:[str|{sql,params}]}。GET ?apiKey=&sql=&params=(JSON配列urlencode)、SELECT/UNION以外→METHOD_NOT_ALLOWED。認証はbody/queryのみ(header不可)。

res: {success:true,client,result}|{success:false,code,message,statementIndex?,rolledBack?,rollbackErrors?}。HTTP常に200、`success`で分岐必須。
result形状: SELECT{columns,rows,rowCount} / INSERT{insertedCount,ids} / UPDATE{updatedCount} / DELETE{deletedCount} / CREATE{table,created,alreadyExists?} / DROP{table,dropped}。sqlsは{results:[...]}。

schema: 1spreadsheet=1DB,1table=Nsheet(shard, 40000行/枚, 自動split, SELECT全shard横断=意識不要)。sys列 __id(PK自動採番)/__created_at/__updated_at 自動付与、指定不要。

SQL: SELECT[DISTINCT]col,COUNT/SUM/AVG/MIN/MAX(expr)FROM t[alias][[INNER|LEFT]JOIN t2 ON cond]*[WHERE][GROUP BY][HAVING][ORDER BY][LIMIT n[OFFSET m]] / INSERT INTO t[(col,..)]VALUES(..),.. / UPDATE t SET col=expr,..[WHERE](自列参照可) / DELETE FROM t[WHERE] / CREATE TABLE[IF NOT EXISTS]t(col TYPE[PRIMARY KEY][NOT NULL][DEFAULT lit],..) / DROP TABLE[IF EXISTS]t
型: INTEGER/INT,REAL/FLOAT,TEXT/VARCHAR,BOOLEAN,DATE,DATETIME
制約: NOT NULL違反→NOT_NULL_VIOLATION,0行書込。DEFAULTは列省略時のみ適用(明示NULL優先)。PRIMARY KEYはメタのみ(PKは常に__id)。UNIQUE/FK/CHECK非対応。
式/演算子: + - * /、括弧、単項符号、NULL伝播、0除算→NULL、= != < <= > >= AND OR NOT LIKE(%_)IN(..)IS[NOT]NULL BETWEEN a AND b。非相関サブクエリ(IN/スカラー)。UNION[ALL]。識別子は日本語可。

params: `?`にバインド、値はstring|number|boolean|nullのみ、個数不一致→BAD_REQUEST。文字列結合禁止・トークンバインドなのでinjection不可。

batch(sqls): 単一ロックでall-or-nothing、失敗時は全変更テーブルをbatch開始時点へ自動rollback。失敗res: statementIndex(0始)+rolledBack。rolledBack:false時rollbackErrors付与→要diagnoseDatabase()。単文(sql)はrollback対象外。

code一覧: AUTH_REQUIRED/AUTH_FAILED/BAD_REQUEST/SYNTAX_ERROR/NO_SUCH_TABLE/NO_SUCH_COLUMN/NOT_NULL_VIOLATION/TABLE_EXISTS/METHOD_NOT_ALLOWED/COLUMN_COUNT_MISMATCH/DUPLICATE_COLUMN/INTERNAL_ERROR

setup(editor-only,HTTP非公開): initializeDatabase()→setupSampleTables_()[任意]→issueApiKeyForClient('name')[name省略/undefined禁止、渡すとres.client="undefined"化]

backup(editor-only,HTTP非公開): createBackup(label?)/setupDailyBackupTrigger(hour=3)/listBackups()/restoreFromBackup(id)[backup・旧DBとも無傷]/deleteBackup(id)

sample tables: 顧客マスタ(customer_code,name,kana,tel,email,address,fiscal_year_end,contract_type,status) / 進捗管理(customer_code,task_name,category,due_date,status,assignee,note) / 勤怠(staff_code,staff_name,work_date,clock_in,clock_out,break_minutes,status)
