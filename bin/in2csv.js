#!/usr/bin/env node
'use strict';
// Port of csvkit 2.2.0 csvkit/utilities/in2csv.py (MIT): converts CSV, DBF, fixed-width, GeoJSON, JSON,
// NDJSON, XLS and XLSX input to CSV.

const { Utility, readBytes } = require('../lib/cli');
const { pyError } = require('../lib/pyerrors');
const { LineWriter, agateReader } = require('../lib/table');
const { isDigit, strToInt } = require('../lib/pyunicode');
const { guessFormat, fixed2csv, geojson2csv } = require('../lib/convert');
const { fromJson } = require('../lib/from-json');
const { excelSheetNames, fromExcel, fromDbf } = require('../lib/agate-ext');
const { splitext } = require('../lib/pypath');
const { writeTextFile, StringOut } = require('../lib/textfile');

const SUPPORTED_FORMATS = ['csv', 'dbf', 'fixed', 'geojson', 'json', 'ndjson', 'xls', 'xlsx'];

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
   * @throws {Error} the errors excelSheetNames() raises
   */
  sheetNames(p, filetype) {
    return excelSheetNames(this.excelBytes(p), filetype, this.xlrdLog());
  }

  /**
   * agate.Table.from_xls / from_xlsx for a list of sheets.
   * @param {string|null} p the path, or null or '-' for standard input
   * @param {'xls'|'xlsx'} filetype
   * @param {Array<string|number|null>} sheets sheet names or indices; null for the first (xls) or active (xlsx) sheet
   * @param {TypeTester|null} columnTypes the types for the first sheet read
   * @returns {Map<string, Table>} the tables by sheet name
   * @throws {Error} the errors fromExcel() raises
   */
  excelTables(p, filetype, sheets, columnTypes) {
    const a = this.args;
    return fromExcel(this.excelBytes(p), filetype, {
      sheets, skipLines: a.skip_lines, header: !a.no_header_row, columnTypes,
      encodingOverride: a.encoding_xls || null, log: this.xlrdLog(), resetDimensions: a.reset_dimensions,
    });
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
    const base = !p || p === '-' ? 'stdin' : splitext(p)[0];
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
   * The DBF input as CSV, through agate.Table.from_dbf.
   * @param {string|null} p the path; standard input is looked up as the file "<stdin>", as dbfread does
   * @returns {void}
   * @throws {Error} the errors readDbf() raises, and the casts' CastError
   */
  convertDbf(p) {
    fromDbf(!p || p === '-' ? '<stdin>' : p).toCsv(this.out, this.writer_kwargs);
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
        table = fromJson(f, { key: a.key, newline: filetype === 'ndjson', columnTypes });
      }
      table.toCsv(this.out, this.writer_kwargs);
    }
    if (a.write_sheets) this.writeSheets(p, filetype, columnTypes);
  }
}

new In2CSV().launch();
