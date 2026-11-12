#!/usr/bin/env node
'use strict';
// Port of csvkit 2.2.0 csvkit/utilities/in2csv.py (MIT): converts CSV, DBF, fixed-width, GeoJSON, JSON,
// NDJSON, XLS and XLSX input to CSV.

const fs = require('node:fs');
const { Utility, readBytes } = require('../lib/cli');
const { pyError } = require('../lib/pyerrors');
const { LineWriter, agateReader, Table, TypeTester } = require('../lib/table');
const { loads } = require('../lib/jsonparse');
const { pyRepr } = require('../lib/pystr');
const { isDigit, strToInt } = require('../lib/pyunicode');
const { guessFormat, fixed2csv, geojson2csv } = require('../lib/convert');
const T = require('../lib/types');
const { SITE_PACKAGES } = require('../lib/warnings');

const SUPPORTED_FORMATS = ['csv', 'dbf', 'fixed', 'geojson', 'json', 'ndjson', 'xls', 'xlsx'];

// Where agate builds the table, for the location of its "Column names not specified" warning.
const TABLE_CALLS = {
  json: [`${SITE_PACKAGES}/agate/table/from_object.py`, 93,
    '  return Table(rows, column_names, row_names=row_names, column_types=column_types)'],
  xls: [`${SITE_PACKAGES}/agateexcel/table_xls.py`, 135,
    '  tables[sheet.name] = agate.Table(rows, column_names, column_types, **kwargs)'],
  xlsx: [`${SITE_PACKAGES}/agateexcel/table_xlsx.py`, 122, '  tables[sheet.title] = agate.Table(rows, column_names, **kwargs)'],
  dbf: [`${SITE_PACKAGES}/agatedbf/table.py`, 22, '  table = agate.Table(dbf.records, column_names=dbf.field_names)'],
};

// agate-excel's own column types, used for the sheets after the first one read in a single call.
const AGATE_TYPES = {
  Boolean: T.BooleanType, Number: T.NumberType, Text: T.TextType, Date: T.DateType, DateTime: T.DateTimeType,
  TimeDelta: T.TimeDeltaType,
};

/** os.path.splitext(p)[0] */
function splitext(p) {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  if (dot <= slash + 1 || /^\.+$/.test(p.slice(slash + 1, dot))) return p;
  return p.slice(0, dot);
}

/** agate.utils.parse_object: nested objects and arrays flattened into "a/b/0" keys. */
function parseObject(obj, path = '') {
  let entries;
  if (obj instanceof Map) entries = [...obj.entries()];
  else if (Array.isArray(obj)) entries = obj.map((v, i) => [String(i), v]);
  else return new Map([[path.replace(/^\/+|\/+$/g, ''), obj]]);
  const d = new Map();
  for (const [k, v] of entries) for (const [kk, vv] of parseObject(v, `${path}${k}/`)) d.set(kk, vv);
  return d;
}

const OPEN_ERRORS = {
  ENOENT: ['FileNotFoundError', 2, 'No such file or directory'],
  EACCES: ['PermissionError', 13, 'Permission denied'],
  EISDIR: ['IsADirectoryError', 21, 'Is a directory'],
  ENOTDIR: ['NotADirectoryError', 20, 'Not a directory'],
};

/**
 * open(filename, 'w') and write.
 * @param {string} filename
 * @param {string} data
 * @returns {void}
 * @throws {Error} pyName the OSError subclass Python's open() raises (FileNotFoundError, PermissionError ...)
 */
function writeTextFile(filename, data) {
  try {
    fs.writeFileSync(filename, data);
  } catch (e) {
    const known = OPEN_ERRORS[e.code];
    if (!known) throw e;
    throw pyError(known[0], `[Errno ${known[1]}] ${known[2]}: ${pyRepr(filename)}`);
  }
}

/** A text sink collecting what a CSV writer writes. */
class StringOut {
  /** Starts empty. */
  constructor() { this.data = ''; }

  /**
   * @param {string} s
   * @returns {void}
   */
  write(s) { this.data += s; }
}

/** in2csv: converts CSV, DBF, fixed-width, GeoJSON, JSON, NDJSON, XLS and XLSX input to CSV. */
class In2CSV extends Utility {
  constructor() {
    super('in2csv', 'Convert common, but less awesome, tabular data formats to CSV.',
      'Some command-line flags only pertain to specific input formats.', ['f']);
  }

  /**
   * In2CSV.add_arguments: FILE, -f, -s, -k, -n, --sheet, --write-sheets, --use-sheet-names, --reset-dimensions,
   * --encoding-xls, -y and -I.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['FILE'], {
      metavar: 'FILE', nargs: '?', dest: 'input_path',
      help: 'The CSV file to operate on. If omitted, will accept input as piped data via STDIN.',
    });
    p.addArgument(['-f', '--format'], {
      dest: 'filetype', choices: SUPPORTED_FORMATS,
      help: 'The format of the input file. If not specified will be inferred from the file type.',
    });
    p.addArgument(['-s', '--schema'], {
      dest: 'schema',
      help: 'Specify a CSV-formatted schema file for converting fixed-width files. See web documentation.',
    });
    p.addArgument(['-k', '--key'], {
      dest: 'key',
      help: 'Specify a top-level key to look within for a list of objects to be converted when processing JSON.',
    });
    p.addArgument(['-n', '--names'], {
      dest: 'names_only', action: 'store_true', help: 'Display sheet names from the input Excel file.',
    });
    p.addArgument(['--sheet'], { dest: 'sheet', help: 'The name of the Excel sheet to operate on.' });
    p.addArgument(['--write-sheets'], {
      dest: 'write_sheets',
      help: 'The names of the Excel sheets to write to files, or "-" to write all sheets.',
    });
    p.addArgument(['--use-sheet-names'], {
      dest: 'use_sheet_names', action: 'store_true',
      help: 'Use the sheet names as file names when --write-sheets is set.',
    });
    p.addArgument(['--reset-dimensions'], {
      dest: 'reset_dimensions', action: 'store_true', default: null,
      help: 'Ignore the sheet dimensions provided by the XLSX file.',
    });
    p.addArgument(['--encoding-xls'], { dest: 'encoding_xls', help: 'Specify the encoding of the input XLS file.' });
    p.addArgument(['-y', '--snifflimit'], {
      dest: 'sniff_limit', type: 'int', default: 1024,
      help: 'Limit CSV dialect sniffing to the specified number of bytes. '
        + 'Specify "0" to disable sniffing entirely, or "-1" to sniff the entire file.',
    });
    p.addArgument(['-I', '--no-inference'], {
      dest: 'no_inference', action: 'store_true',
      help: 'Disable type inference (and --locale, --date-format, --datetime-format, --no-leading-zeroes) '
        + 'when parsing CSV input.',
    });
  }

  /**
   * open_excel_input_file: the Excel input as bytes; standard input is read once and reused.
   * @param {string|null} p the path, or null or '-' for standard input
   * @returns {Buffer}
   * @throws {Error} the OSError readBytes() raises
   */
  excelBytes(p) {
    if (!p || p === '-') {
      if (this.stdinBytes === undefined) this.stdinBytes = readBytes(null);
      return this.stdinBytes;
    }
    return readBytes(p);
  }

  /** @returns {function(string): void} xlrd's log file, which is standard output */
  xlrdLog() {
    return (message) => this.out.write(message);
  }

  /**
   * The sheet names of an Excel input (in2csv -n and --write-sheets -).
   * @param {string|null} p the path, or null or '-' for standard input
   * @param {'xls'|'xlsx'} filetype
   * @returns {string[]}
   * @throws {Error} the errors xlsSheetNames() and xlsxSheetNames() raise
   */
  sheetNames(p, filetype) {
    const buf = this.excelBytes(p);
    if (filetype === 'xls') return require('../lib/xls').xlsSheetNames(buf, this.xlrdLog());
    return require('../lib/xlsx').xlsxSheetNames(buf);
  }

  /**
   * agate.Table.from_xls / from_xlsx for a list of sheets.
   * @param {string|null} p the path, or null or '-' for standard input
   * @param {'xls'|'xlsx'} filetype
   * @param {Array<string|number|null>} sheets sheet names or indices; null for the first (xls) or active (xlsx) sheet
   * @param {TypeTester|null} columnTypes the types for the first sheet read
   * @returns {Map<string, Table>} the tables by sheet name
   * @throws {Error} the errors readXls() and readXlsx() raise, and the casts' CastError
   */
  excelTables(p, filetype, sheets, columnTypes) {
    const a = this.args;
    const opts = { sheets, skipLines: a.skip_lines, header: !a.no_header_row };
    let parts;
    if (filetype === 'xls') {
      parts = require('../lib/xls').readXls(this.excelBytes(p), {
        ...opts, encodingOverride: a.encoding_xls || null, log: this.xlrdLog(),
      });
    } else {
      parts = require('../lib/xlsx').readXlsx(this.excelBytes(p), { ...opts, resetDimensions: a.reset_dimensions });
    }
    const tables = new Map();
    for (const part of parts) {
      const types = part.columnTypes ? part.columnTypes.map((n) => new AGATE_TYPES[n]({})) : columnTypes;
      tables.set(part.title, new Table(part.rows, part.columnNames, types, { caller: TABLE_CALLS[filetype] }));
    }
    return tables;
  }

  /**
   * The --sheet sheet (or the default one) as CSV.
   * @param {string|null} p the path, or null or '-' for standard input
   * @param {'xls'|'xlsx'} filetype
   * @param {TypeTester} columnTypes
   * @returns {void}
   * @throws {Error} as excelTables()
   */
  convertExcel(p, filetype, columnTypes) {
    const a = this.args;
    const [table] = this.excelTables(p, filetype, [a.sheet == null ? null : a.sheet], columnTypes).values();
    table.toCsv(this.out, this.writer_kwargs);
  }

  /**
   * --write-sheets: each selected sheet to its own CSV file. As in csvkit, only Excel input defines the tables to
   * write; any other format fails on the unbound name.
   * @param {string|null} p the path, or null or '-' for standard input
   * @param {string} filetype
   * @param {TypeTester|null} columnTypes
   * @returns {void}
   * @throws {Error} pyName UnboundLocalError for input that is not Excel, the OSError of a file that cannot be
   *   written, and excelTables()'s errors
   */
  writeSheets(p, filetype, columnTypes) {
    const a = this.args;
    let sheets;
    if (a.write_sheets === '-') sheets = this.sheetNames(p, filetype);
    else sheets = a.write_sheets.split(',').map((s) => (isDigit(s) ? strToInt(s) : s));
    if (filetype !== 'xls' && filetype !== 'xlsx') {
      throw pyError('UnboundLocalError', "cannot access local variable 'tables' where it is not associated with a value");
    }
    const tables = this.excelTables(p, filetype, sheets, columnTypes);
    const base = !p || p === '-' ? 'stdin' : splitext(p);
    let i = 0;
    for (const [name, table] of tables) {
      const filename = a.use_sheet_names ? `${base}_${name}.csv` : `${base}_${i}.csv`;
      const out = new StringOut();
      writeTextFile(filename, '');
      table.toCsv(out, this.writer_kwargs);
      writeTextFile(filename, out.data);
      i++;
    }
  }

  /**
   * agate.Table.from_dbf, with agate's default type inference.
   * @param {string|null} p the path; standard input is looked up as the file "<stdin>", as dbfread does
   * @returns {void}
   * @throws {Error} the errors readDbf() raises, and the casts' CastError
   */
  convertDbf(p) {
    const d = require('../lib/dbf').readDbf(!p || p === '-' ? '<stdin>' : p);
    const o = {};
    const types = new TypeTester([new T.BooleanType(o), new T.NumberType(o), new T.TimeDeltaType(o),
      new T.DateType(o), new T.DateTimeType(o), new T.TextType(o)]);
    new Table(d.rows, d.fields, types, { caller: TABLE_CALLS.dbf }).toCsv(this.out, this.writer_kwargs);
  }

  /**
   * agate.Table.from_json (newline=True for NDJSON) through Table.from_object.
   * @param {InputFile} f
   * @param {boolean} newline whether the input is NDJSON
   * @param {TypeTester} columnTypes
   * @returns {Table}
   * @throws {Error} pyName ValueError for -k with NDJSON, TypeError for a top-level object without -k, KeyError
   *   for a -k key the object does not have, json.decoder.JSONDecodeError for invalid JSON
   */
  jsonTable(f, newline, columnTypes) {
    const key = this.args.key;
    if (key != null && newline) throw pyError('ValueError', 'key and newline may not be specified together.');
    let js = newline ? [...f.lines()].map((line) => loads(line)) : loads(f.read());
    if (js instanceof Map) {
      if (!key) {
        throw pyError('TypeError',
          'When converting a JSON document with a top-level dictionary element, a key must be specified.');
      }
      if (!js.has(key)) throw pyError('KeyError', pyRepr(key));
      js = js.get(key);
    }
    const columnNames = [];
    const objects = [];
    for (const sub of js) {
      const parsed = parseObject(sub);
      for (const k of parsed.keys()) if (!columnNames.includes(k)) columnNames.push(k);
      objects.push(parsed);
    }
    const rows = objects.map((o) => columnNames.map((n) => (o.has(n) ? o.get(n) : null)));
    return new Table(rows, columnNames, columnTypes, { caller: TABLE_CALLS.json });
  }

  /**
   * In2CSV.main: picks the format (from -f, -s, -k or the file extension) and converts.
   * @returns {void}
   * @throws {ExitError} with status 2 when the format cannot be determined, or for -n with a non-Excel format
   * @throws {Error} pyName ValueError for fixed-width input without -s, and the errors of the converter used
   */
  main() {
    const a = this.args;
    const p = a.input_path;
    let filetype;
    if (a.filetype) filetype = a.filetype;
    else if (a.schema) filetype = 'fixed';
    else if (a.key) filetype = 'json';
    else {
      if (!p || p === '-') this.argparser.error('You must specify a format when providing input as piped data via STDIN.');
      filetype = guessFormat(p);
      if (!filetype) {
        this.argparser.error('Unable to automatically determine the format of the input file. '
          + 'Try specifying a format with --format.');
      }
    }

    if (a.names_only) {
      if (filetype !== 'xls' && filetype !== 'xlsx') {
        this.argparser.error('You cannot use the -n or --names options with non-Excel files.');
      }
      for (const sheet of this.sheetNames(p, filetype)) this.out.write(`${sheet}\n`);
      return;
    }

    const excel = filetype === 'xls' || filetype === 'xlsx';
    if (excel) this.excelBytes(p);
    else this.input_file = this.openInputFile(p);
    let schema = null;
    if (a.schema) schema = this.openInputFile(a.schema);
    else if (filetype === 'fixed') throw pyError('ValueError', 'schema must not be null when format is "fixed"');
    if (filetype === 'dbf') {
      // hasattr(self.input_file, 'name') opens the lazy input file.
      if (p && p !== '-') readBytes(p);
      this.convertDbf(p);
      if (a.write_sheets) this.writeSheets(p, filetype, null);
      return;
    }
    const columnTypes = this.getColumnTypes();
    if (excel) {
      this.convertExcel(p, filetype, columnTypes);
      if (a.write_sheets) this.writeSheets(p, filetype, columnTypes);
      return;
    }

    const sniffLimit = a.sniff_limit !== -1 ? a.sniff_limit : null;
    const f = this.input_file;
    if (filetype === 'csv' && a.no_inference && !a.no_header_row && !a.skip_lines && sniffLimit === 0) {
      const writer = new LineWriter(this.out, this.writer_kwargs);
      for (const row of agateReader(f.lines(), this.reader_kwargs)) writer.writerow(row);
    } else if (filetype === 'fixed') {
      fixed2csv(f, schema, this.out, a.skip_lines);
    } else if (filetype === 'geojson') {
      geojson2csv(f.read(), this.out);
    } else {
      let table;
      if (filetype === 'csv') {
        table = this.tableFromCsv(f, { skipLines: a.skip_lines, sniffLimit, columnTypes, kwargs: this.reader_kwargs });
      } else {
        table = this.jsonTable(f, filetype === 'ndjson', columnTypes);
      }
      table.toCsv(this.out, this.writer_kwargs);
    }
    if (a.write_sheets) this.writeSheets(p, filetype, columnTypes);
  }
}

new In2CSV().launch();
