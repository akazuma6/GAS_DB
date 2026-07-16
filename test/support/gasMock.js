'use strict';
/**
 * GASサービス(SpreadsheetApp / PropertiesService / LockService / ContentService /
 * Utilities / Logger)をNode.js上でモックし、src/*.js を独立したVMコンテキストへロードする。
 * テストごとに createSandbox() で完全に独立した状態(スプレッドシート・カタログ・APIキー)を得られる。
 *
 * vm.createContext(sandbox) により sandbox オブジェクト自身がそのコンテキストのグローバルオブジェクトになるため、
 * src内の関数宣言(executeSql_ 等)は sandbox.executeSql_ としてホスト側から直接呼び出せる。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const SRC_FILES = [
  'Constants.js', 'Utils.js', 'SchemaManager.js', 'ShardStore.js',
  'SqlLexer.js', 'SqlParser.js', 'SqlExecutor.js', 'Auth.js', 'Main.js', 'Setup.js',
  'Diagnostics.js', 'Backup.js'
];

// 実GASの新規シート既定グリッド(1,000行×26列)。グリッド外アクセスは実GAS同様に例外を投げる。
const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_MAX_COLS = 26;

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.data = [];
    this.frozen = 0;
    this.maxRows = DEFAULT_MAX_ROWS;
    this.maxCols = DEFAULT_MAX_COLS;
    this.columnFormats = {};
  }
  getName() { return this.name; }
  // 実GAS仕様: 「内容がある最終行」を返す(clearContentされた行は数えない)
  getLastRow() {
    for (let r = this.data.length - 1; r >= 0; r--) {
      const row = this.data[r];
      if (row && row.some((c) => c !== '' && c !== null && c !== undefined)) return r + 1;
    }
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(afterPosition, howMany) { this.maxRows += howMany; return this; }
  insertColumnsAfter(afterPosition, howMany) { this.maxCols += howMany; return this; }
  setFrozenRows(n) { this.frozen = n; }
  appendRow(arr) {
    this.data.push(arr.slice());
    // 実GASのappendRowはグリッドを自動拡張する
    if (this.data.length > this.maxRows) this.maxRows = this.data.length;
  }
  deleteRow(rowPosition) { this.data.splice(rowPosition - 1, 1); }
  getRange(row, col, numRows, numCols) {
    const self = this;
    numRows = numRows || 1; numCols = numCols || 1;
    // 実GAS仕様: グリッド(maxRows×maxCols)外の範囲指定は out of bounds 例外
    if (row < 1 || col < 1 || row + numRows - 1 > this.maxRows || col + numCols - 1 > this.maxCols) {
      throw new Error(
        'The coordinates or dimensions of the range are invalid. (sheet=' + this.name +
        ', range=' + row + ',' + col + ',' + numRows + ',' + numCols +
        ', grid=' + this.maxRows + 'x' + this.maxCols + ')'
      );
    }
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const rowData = self.data[row - 1 + r] || [];
          const rowOut = [];
          for (let c = 0; c < numCols; c++) {
            const v = rowData[col - 1 + c];
            // 実GASの getValues() は空セル(null書き込み含む)を '' で返す仕様に合わせる
            rowOut.push(v === undefined || v === null ? '' : v);
          }
          out.push(rowOut);
        }
        return out;
      },
      setValues(vals) {
        // 実GAS仕様: データの次元が範囲と一致しないと例外
        if (vals.length !== numRows) {
          throw new Error('The number of rows in the data does not match the number of rows in the range. (' + vals.length + ' vs ' + numRows + ')');
        }
        for (let r = 0; r < vals.length; r++) {
          if (vals[r].length !== numCols) {
            throw new Error('The number of columns in the data does not match the number of columns in the range. (' + vals[r].length + ' vs ' + numCols + ')');
          }
          const rowIdx = row - 1 + r;
          while (self.data.length <= rowIdx) self.data.push([]);
          const rowArr = self.data[rowIdx];
          for (let c = 0; c < vals[r].length; c++) rowArr[col - 1 + c] = vals[r][c];
        }
      },
      clearContent() {
        for (let r = 0; r < numRows; r++) {
          const rowIdx = row - 1 + r;
          if (self.data[rowIdx]) {
            for (let c = 0; c < numCols; c++) self.data[rowIdx][col - 1 + c] = '';
          }
        }
      },
      setValue(v) {
        const rowIdx = row - 1;
        while (self.data.length <= rowIdx) self.data.push([]);
        self.data[rowIdx][col - 1] = v;
      },
      setNumberFormat(fmt) {
        // 列単位の書式設定を記録する(実GASではTEXT列の '@'(書式なしテキスト)指定により
        // '0123'→123 や '2026-01-01'→Date のような自動型変換を抑止する)
        for (let c = 0; c < numCols; c++) self.columnFormats[col + c] = fmt;
        return this;
      }
    };
  }
}

class FakeSpreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = {}; this.order = []; this.trashed = false; }
  getId() { return this.id; }
  getUrl() { return 'https://fake/' + this.id; }
  getName() { return this.name; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets[name] = s; this.order.push(name); return s; }
  getSheetByName(name) { return this.sheets[name] || null; }
  deleteSheet(sheet) { delete this.sheets[sheet.getName()]; this.order = this.order.filter((n) => n !== sheet.getName()); }
  getSheets() { return this.order.map((n) => this.sheets[n]); }
}

// FakeSpreadsheet.copy はレジストリ(store)への登録が必要なため createSandbox 内で束縛する。
function deepCopySpreadsheet(src, id, name) {
  const copy = new FakeSpreadsheet(id, name);
  src.order.forEach((sheetName) => {
    const s = src.sheets[sheetName];
    const ns = copy.insertSheet(sheetName);
    ns.data = s.data.map((row) => row.slice());
    ns.frozen = s.frozen;
    ns.maxRows = s.maxRows;
    ns.maxCols = s.maxCols;
    ns.columnFormats = Object.assign({}, s.columnFormats);
  });
  return copy;
}

function createSandbox() {
  const store = {};
  let counter = 0;
  const propStore = {};

  const triggers = [];

  // 実GASのSpreadsheet.copy: 全シート・データを新ファイルへ複製する(複製もさらにcopy可能)
  function attachCopy(ss) {
    ss.copy = (copyName) => {
      const id2 = 'ss' + (++counter);
      const copied = deepCopySpreadsheet(ss, id2, copyName);
      attachCopy(copied);
      store[id2] = copied;
      return copied;
    };
    return ss;
  }

  function newSpreadsheet(name) {
    const id = 'ss' + (++counter);
    const ss = attachCopy(new FakeSpreadsheet(id, name));
    store[id] = ss;
    return ss;
  }

  const sandbox = {
    console,
    SpreadsheetApp: {
      create(name) { return newSpreadsheet(name); },
      openById(id) {
        if (!store[id] || store[id].trashed) throw new Error('no such spreadsheet ' + id);
        return store[id];
      },
      flush() {}
    },
    DriveApp: {
      getFileById(id) {
        if (!store[id]) throw new Error('no such file ' + id);
        return {
          setTrashed(flag) { store[id].trashed = flag; },
          isTrashed() { return store[id].trashed; },
          getName() { return store[id].getName(); }
        };
      }
    },
    ScriptApp: {
      getProjectTriggers() { return triggers.slice(); },
      deleteTrigger(t) { const i = triggers.indexOf(t); if (i !== -1) triggers.splice(i, 1); },
      newTrigger(handler) {
        const trigger = {
          getHandlerFunction() { return handler; },
          _config: { handler }
        };
        const builder = {
          timeBased() { return builder; },
          everyDays(n) { trigger._config.everyDays = n; return builder; },
          atHour(h) { trigger._config.atHour = h; return builder; },
          create() { triggers.push(trigger); return trigger; }
        };
        return builder;
      }
    },
    Session: { getScriptTimeZone() { return 'Asia/Tokyo'; } },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(k) { return Object.prototype.hasOwnProperty.call(propStore, k) ? propStore[k] : null; },
          setProperty(k, v) { propStore[k] = v; }
        };
      }
    },
    LockService: { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) { return { _text: text, setMimeType(m) { this._mime = m; return this; } }; }
    },
    Utilities: {
      getUuid() { return 'uuid-' + Math.random().toString(36).slice(2) + Date.now().toString(36); },
      formatDate(date, tz, fmt) {
        // テスト用の簡易実装: yyyyMMdd-HHmmss 形式のみサポート(Backup.jsが使用)
        const p = (n, w) => String(n).padStart(w || 2, '0');
        return fmt
          .replace('yyyy', String(date.getFullYear()))
          .replace('MM', p(date.getMonth() + 1))
          .replace('dd', p(date.getDate()))
          .replace('HH', p(date.getHours()))
          .replace('mm', p(date.getMinutes()))
          .replace('ss', p(date.getSeconds()));
      }
    },
    Logger: { log() {} }
  };
  // テストからトリガー登録状況を検査できるように公開する
  sandbox.__triggers = triggers;

  vm.createContext(sandbox);

  for (const f of SRC_FILES) {
    const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }

  return sandbox;
}

/**
 * DB初期化済みのサンドボックスを返す(多くのテストの共通前提)。
 */
function createInitializedSandbox() {
  const sandbox = createSandbox();
  sandbox.initializeDatabase();
  return sandbox;
}

module.exports = { createSandbox, createInitializedSandbox };
