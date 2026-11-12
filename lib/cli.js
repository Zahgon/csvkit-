'use strict';
// The shared command line layer of csvkit (csvkit/cli.py).

const fs = require('node:fs');
const path = require('node:path');
const tty = require('node:tty');
const { pyError } = require('./pyerrors');
const { ArgumentParser, ExitError } = require('./argparse');
const { pyRepr } = require('./pystr');
const codecs = require('./codecs');
const { isDigit, strToInt } = require('./pyunicode');
const pycsv = require('./pycsv');
const T = require('./types');
const table = require('./table');
const warnings = require('./warnings');
const { version } = require('../package.json');

const QUOTING_CHOICES = [0, 1, 2, 3];
const STDIN_BUFFER_SIZE = 4096;

/**
 * csvkit.exceptions.ColumnIdentifierError: a column name or index that does not match the input.
 */
class ColumnIdentifierError extends Error {
  /** @param {string} m the message */
  constructor(m) { super(m); this.pyName = 'ColumnIdentifierError'; }
}
/**
 * csvkit.exceptions.RequiredHeaderError: a tool needs a header row the input does not have.
 */
class RequiredHeaderError extends Error {
  /** @param {string} m the message */
  constructor(m) { super(m); this.pyName = 'RequiredHeaderError'; }
}

/**
 * Whether standard input is a terminal. Asking fs-level isatty() leaves fd 0 alone: creating process.stdin would put
 * a pipe into non-blocking mode and make the synchronous read of standard input stop early.
 * @returns {boolean}
 */
function stdinIsTTY() {
  return tty.isatty(0);
}

/**
 * Reads standard input to its end. A pipe that its writer left in non-blocking mode answers EAGAIN until data
 * arrives, so the read waits briefly and tries again.
 * @returns {Buffer}
 */
function readStdin() {
  const chunks = [];
  const chunk = Buffer.alloc(65536);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, chunk, 0, chunk.length, null);
    } catch (e) {
      if (e.code !== 'EAGAIN') throw e;
      Atomics.wait(pause, 0, 0, 5);
      continue;
    }
    if (n === 0) return Buffer.concat(chunks);
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
}

/**
 * The contents of a file, or of standard input for null, raising the OSError subclass Python's open() raises.
 * @param {string|null} p the path
 * @returns {Buffer}
 * @throws {Error} pyName FileNotFoundError, IsADirectoryError or PermissionError for a path open() cannot read
 */
function readBytes(p) {
  if (p === null) return readStdin();
  try {
    return fs.readFileSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') throw pyError('FileNotFoundError', `[Errno 2] No such file or directory: ${pyRepr(p)}`);
    if (e.code === 'EISDIR') throw pyError('IsADirectoryError', `[Errno 21] Is a directory: ${pyRepr(p)}`);
    if (e.code === 'EACCES') throw pyError('PermissionError', `[Errno 13] Permission denied: ${pyRepr(p)}`);
    throw e;
  }
}

/**
 * The bytes gzip.open, bz2.open or lzma.open deliver for a path, and the error they raise once those are read.
 * @param {Buffer} buf the file contents
 * @param {string} ext the lower-case extension, e.g. ".gz"
 * @returns {{data: Buffer, error: Error|null}}
 */
function decompress(buf, ext) {
  if (ext === '.gz') return require('./gzip').gunzip(buf);
  if (ext === '.bz2') return require('./bz2').decompress(buf);
  if (ext === '.xz') return require('./xz').decompress(buf);
  return { data: buf, error: null };
}

/**
 * Splits text into lines that keep their "\n", as iterating over a file opened with newline='' does.
 * @param {string} s
 * @returns {string[]}
 */
function splitLines(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const j = s.indexOf('\n', i);
    if (j < 0) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/**
 * csvkit's LazyFile over open(path, 'rt', encoding=...) (or sys.stdin): opened, read and decoded on first use.
 */
class InputFile {
  /**
   * @param {string|null} p the path (null for standard input)
   * @param {string} encoding the codec name given with -e
   * @param {boolean} isStdin whether this is sys.stdin rather than a named file
   * @throws {Error} pyName LookupError for an unknown encoding on standard input (a named file checks it on first
   *   use, as LazyFile opens it then)
   */
  constructor(p, encoding, isStdin) {
    this.path = p;
    this.name = isStdin ? '<stdin>' : p;
    this.encoding = encoding;
    this.isStdin = isStdin;
    this.lazy = !isStdin;
    this.reader = null;
    this.pos = 0;
    if (isStdin) codecs.lookup(encoding);
  }
  /**
   * Opens, decompresses (.gz, .bz2, .xz) and starts decoding the file on first use.
   * @returns {codecs.TextReader} the decoding reader
   * @throws {Error} pyName LookupError for an unknown encoding, or the OSError readBytes raises
   */
  load() {
    if (this.reader === null) {
      if (!this.isStdin) codecs.lookup(this.encoding);
      const raw = readBytes(this.isStdin ? null : this.path);
      const { data, error } = this.isStdin ? { data: raw, error: null } : decompress(raw, path.extname(this.path));
      this.rawBytes = data;
      this.reader = new codecs.TextReader(data, this.encoding, error);
    }
    return this.reader;
  }
  /**
   * @returns {string} the next line with its "\n", or '' at end of file
   * @throws {Error} pyName UnicodeDecodeError (or the decompressor's error) when the next bytes cannot be decoded
   */
  readline() {
    const line = this.load().readline();
    if (line) this.pos++;
    return line;
  }
  /**
   * @param {number} [n] how many characters; all the rest when omitted
   * @returns {string}
   * @throws {Error} pyName UnicodeDecodeError, as readline()
   */
  read(n) {
    return this.load().read(n);
  }
  /** @returns {object} the reader's opaque position, for seek() */
  tell() {
    return this.load().tell();
  }
  /**
   * @param {object} pos a position tell() returned
   * @returns {void}
   */
  seek(pos) {
    this.load().seek(pos);
  }
  /**
   * The remaining lines, as iterating a LazyFile does (null bytes dropped for a named file).
   * @returns {Generator<string>}
   */
  * lines() {
    for (;;) {
      const line = this.readline();
      if (!line) return;
      yield this.lazy ? line.replace(/\0/g, '') : line;
    }
  }
  /** A no-op: the whole file was read on first use. */
  close() {}
}

/**
 * csvkit.cli.CSVKitUtility: the common arguments, input opening, reader and writer settings and the error
 * handling every tool shares. A tool subclasses it with addArguments() and main(), then calls launch().
 */
class Utility {
  /**
   * @param {string} prog the program name usage shows
   * @param {string} description the help description
   * @param {string} [epilog] the help epilog
   * @param {string[]} [overrideFlags] common flags this tool leaves out (CSVKitUtility.override_flags), e.g. ['f']
   */
  constructor(prog, description, epilog = '', overrideFlags = []) {
    this.prog = prog;
    this.description = description;
    this.epilog = epilog;
    this.overrideFlags = overrideFlags;
    this.out = new BufferedOut();
  }

  /**
   * @param {string} f a common flag letter such as 'd', or 'add-bom' / 'zero'
   * @returns {boolean} whether the tool offers it
   */
  has(f) { return !this.overrideFlags.includes(f); }

  /**
   * CSVKitUtility._init_common_parser: the argument parser with the common input options this tool keeps.
   * @returns {void}
   */
  initCommonParser() {
    const p = new ArgumentParser({ prog: this.prog, description: this.description, epilog: this.epilog });
    this.argparser = p;
    if (this.has('f')) {
      p.addArgument(['FILE'], { metavar: 'FILE', nargs: '?', dest: 'input_path',
        help: 'The CSV file to operate on. If omitted, will accept input as piped data via STDIN.' });
    }
    if (this.has('d')) p.addArgument(['-d', '--delimiter'], { dest: 'delimiter', help: 'Delimiting character of the input CSV file.' });
    if (this.has('t')) p.addArgument(['-t', '--tabs'], { dest: 'tabs', action: 'store_true', help: 'Specify that the input CSV file is delimited with tabs. Overrides "-d".' });
    if (this.has('q')) p.addArgument(['-q', '--quotechar'], { dest: 'quotechar', help: 'Character used to quote strings in the input CSV file.' });
    if (this.has('u')) {
      p.addArgument(['-u', '--quoting'], { dest: 'quoting', type: 'int', choices: QUOTING_CHOICES,
        help: 'Quoting style used in the input CSV file: 0 quote minimal, 1 quote all, 2 quote non-numeric, 3 quote none.' });
    }
    if (this.has('b')) p.addArgument(['-b', '--no-doublequote'], { dest: 'doublequote', action: 'store_false', help: 'Whether or not double quotes are doubled in the input CSV file.' });
    if (this.has('p')) {
      p.addArgument(['-p', '--escapechar'], { dest: 'escapechar',
        help: 'Character used to escape the delimiter if --quoting 3 ("quote none") is specified and to escape the QUOTECHAR if --no-doublequote is specified.' });
    }
    if (this.has('z')) p.addArgument(['-z', '--maxfieldsize'], { dest: 'field_size_limit', type: 'int', help: 'Maximum length of a single field in the input CSV file.' });
    if (this.has('e')) {
      p.addArgument(['-e', '--encoding'], { dest: 'encoding', default: process.env.PYTHONIOENCODING || 'utf-8-sig',
        help: 'Specify the encoding of the input CSV file.' });
    }
    if (this.has('L')) p.addArgument(['-L', '--locale'], { dest: 'locale', default: 'en_US', help: 'Specify the locale (en_US) of any formatted numbers.' });
    if (this.has('S')) p.addArgument(['-S', '--skipinitialspace'], { dest: 'skipinitialspace', action: 'store_true', help: 'Ignore whitespace immediately following the delimiter.' });
    if (this.has('I')) {
      p.addArgument(['--blanks'], { dest: 'blanks', action: 'store_true', help: 'Do not convert "", "na", "n/a", "none", "null", "." to NULL.' });
      p.addArgument(['--null-value'], { dest: 'null_values', nargs: '+', default: [], help: 'Convert this value to NULL. --null-value can be specified multiple times.' });
      p.addArgument(['--date-format'], { dest: 'date_format', help: 'Specify a strptime date format string like "%%m/%%d/%%Y".' });
      p.addArgument(['--datetime-format'], { dest: 'datetime_format', help: 'Specify a strptime datetime format string like "%%m/%%d/%%Y %%I:%%M %%p".' });
      p.addArgument(['--no-leading-zeroes'], { dest: 'no_leading_zeroes', action: 'store_true', help: 'Do not convert a numeric value with leading zeroes to a number.' });
    }
    if (this.has('H')) p.addArgument(['-H', '--no-header-row'], { dest: 'no_header_row', action: 'store_true', help: 'Specify that the input CSV file has no header row. Will create default headers (a,b,c,...).' });
    if (this.has('K')) {
      p.addArgument(['-K', '--skip-lines'], { dest: 'skip_lines', type: 'int', default: 0,
        help: 'Specify the number of initial lines to skip before the header row (e.g. comments, copyright notices, empty rows).' });
    }
    if (this.has('v')) p.addArgument(['-v', '--verbose'], { dest: 'verbose', action: 'store_true', help: 'Print detailed tracebacks when errors occur.' });
    if (this.has('l')) {
      p.addArgument(['-l', '--linenumbers'], { dest: 'line_numbers', action: 'store_true',
        help: 'Insert a column of line numbers at the front of the output. Useful when piping to grep or as a simple primary key.' });
    }
    if (this.has('add-bom')) p.addArgument(['--add-bom'], { dest: 'add_bom', action: 'store_true', help: 'Add the UTF-8 byte-order mark (BOM) to the output, for Excel compatibility' });
    if (this.has('zero')) {
      p.addArgument(['--zero'], { dest: 'zero_based', action: 'store_true',
        help: 'When interpreting or displaying column numbers, use zero-based numbering instead of the default 1-based numbering.' });
    }
    p.addArgument(['-V', '--version'], { action: 'version', version: `%(prog)s ${version}`, help: 'Display version information and exit.' });
  }

  /**
   * Adds the tool's own arguments to this.argparser; tools override it.
   * @returns {void}
   */
  addArguments() {}

  /**
   * CSVKitUtility._extract_csv_reader_kwargs; also applies -z through csv.field_size_limit.
   * @returns {object} the csv.reader keywords the common options give
   */
  readerKwargs() {
    const a = this.args;
    const k = {};
    if (a.field_size_limit !== null && a.field_size_limit !== undefined) pycsv.fieldSizeLimit(a.field_size_limit);
    if (a.tabs) k.delimiter = '\t';
    else if (a.delimiter) k.delimiter = a.delimiter;
    for (const arg of ['quotechar', 'quoting', 'doublequote', 'escapechar', 'skipinitialspace']) {
      if (a[arg] !== null && a[arg] !== undefined) k[arg] = a[arg];
    }
    if (a.no_header_row) k.header = !a.no_header_row;
    return k;
  }

  /**
   * CSVKitUtility._extract_csv_writer_kwargs.
   * @returns {{lineNumbers?: boolean}}
   */
  writerKwargs() {
    const k = {};
    if (this.args.line_numbers) k.lineNumbers = true;
    return k;
  }

  /**
   * CSVKitUtility._open_input_file.
   * @param {string|null} p the path, or null or '-' for standard input
   * @returns {InputFile}
   * @throws {Error} pyName LookupError for an unknown encoding on standard input
   */
  openInputFile(p) {
    if (!p || p === '-') return new InputFile(null, this.args.encoding, true);
    return new InputFile(p, this.args.encoding, false);
  }

  /**
   * CSVKitUtility.__init__ and run(): parses the arguments, runs the tool and exits with its status. Errors are
   * reported the way csvkit's excepthook reports them (see handleError()).
   * @param {string[]} [argv] the arguments after the program name
   * @returns {void}
   */
  launch(argv = process.argv.slice(2)) {
    let code = 0;
    try {
      this.initCommonParser();
      this.addArguments();
      this.args = this.argparser.parseArgs(argv);
      this.reader_kwargs = this.readerKwargs();
      this.writer_kwargs = this.writerKwargs();
      this.run();
    } catch (e) {
      this.out.flush();
      code = this.handleError(e);
    }
    this.out.flush();
    flushAndExit(code);
  }

  /**
   * Reports an error that ended the run: SystemExit gives its code, a Python exception prints "Name: message" (or a
   * traceback's last line with -v, or csvkit's encoding hint for UnicodeDecodeError), anything else its stack.
   * @param {Error} e
   * @returns {number} the exit status
   */
  handleError(e) {
    if (e instanceof ExitError) return e.exitCode;
    if (e && e.pyName && this.args && this.args.verbose) {
      const qual = {
        ColumnIdentifierError: 'csvkit.exceptions.ColumnIdentifierError',
        RequiredHeaderError: 'csvkit.exceptions.RequiredHeaderError',
        Error: '_csv.Error',
        CastError: 'agate.exceptions.CastError',
      }[e.pyName] || e.pyName;
      process.stderr.write(`Traceback (most recent call last):\n${qual}: ${e.message}\n`);
      return 1;
    }
    if (e && e.pyName) {
      if (e.pyName === 'UnicodeDecodeError') {
        process.stderr.write(`Your file is not "${this.args.encoding}" encoded. Please specify the correct encoding with the --encoding flag. Use the -v flag to see the complete error.\n`);
      } else {
        process.stderr.write(`${e.pyName.split('.').pop()}: ${e.message}\n`);
      }
      return 1;
    }
    process.stderr.write(`${e && e.stack}\n`);
    return 1;
  }

  /**
   * CSVKitUtility.run: opens the input file, writes the BOM for --add-bom, silences agate's "Column names not
   * specified" warning for -H, then calls main().
   * @returns {void}
   * @throws {Error} whatever main() raises
   */
  run() {
    if (this.has('f')) this.input_file = this.openInputFile(this.args.input_path);
    if (this.args.add_bom) this.out.write('﻿');
    if (this.args.no_header_row) warnings.ignore('Column names not specified');
    this.main();
  }

  /**
   * CSVKitUtility.get_column_types: the TypeTester for -I, --blanks, --null-value, --date-format, --datetime-format,
   * --no-leading-zeroes and -L.
   * @returns {table.TypeTester}
   */
  getColumnTypes() {
    const a = this.args;
    const nullValues = a.blanks ? [] : [...T.DEFAULT_NULL_VALUES];
    for (const v of a.null_values || []) nullValues.push(v);
    const o = { nullValues };
    const text = new T.TextType(o);
    let types;
    if (a.no_inference) types = [text];
    else {
      const number = new T.NumberType({ ...o, locale: a.locale, noLeadingZeroes: a.no_leading_zeroes });
      if (a.out_quoting === 2) types = [number, text];
      else {
        types = [new T.BooleanType(o), new T.TimeDeltaType(o), new T.DateType({ ...o, dateFormat: a.date_format }),
          new T.DateTimeType({ ...o, datetimeFormat: a.datetime_format }), text];
        if (a.datetime_format) types.splice(types.length - 1, 0, number);
        else if (a.date_format) types.splice(types.length - 2, 0, number);
        else types.splice(1, 0, number);
      }
    }
    return new table.TypeTester(types);
  }

  /** @returns {number} 0 with --zero, else 1 */
  columnOffset() { return this.args.zero_based ? 0 : 1; }

  /**
   * CSVKitUtility.skip_lines: reads past the -K lines.
   * @param {InputFile} [f]
   * @returns {InputFile} the same file
   */
  skipLines(f = this.input_file) {
    while (this.args.skip_lines > 0) {
      f.readline();
      this.args.skip_lines -= 1;
    }
    return f;
  }

  /**
   * CSVKitUtility.get_rows_and_column_names_and_column_ids.
   * @param {object} kwargs the reader keywords
   * @returns {Array} [row iterator, column names, selected zero-based column ids]
   * @throws {ColumnIdentifierError} for a -c or -C entry that names no column
   */
  getRowsAndColumnNamesAndColumnIds(kwargs) {
    const rows = table.agateReader(this.skipLines().lines(), kwargs);
    const first = rows.next();
    if (first.done) return [[][Symbol.iterator](), [], []];
    let columnNames;
    let it = rows;
    if (this.args.no_header_row) {
      const row = first.value;
      it = (function* chain() { yield row; yield* rows; }());
      columnNames = makeDefaultHeaders(row.length);
    } else columnNames = first.value;
    let offset = this.columnOffset();
    if (kwargs.lineNumbers) offset -= 1;
    const ids = parseColumnIdentifiers(this.args.columns, columnNames, offset, this.args.not_columns);
    return [it, columnNames, ids];
  }

  /**
   * CSVKitUtility.print_column_names: the -n listing.
   * @returns {void}
   * @throws {RequiredHeaderError} with -H
   * @throws {Error} pyName StopIteration for an empty input
   */
  printColumnNames() {
    if (this.args.no_header_row) throw new RequiredHeaderError('You cannot use --no-header-row with the -n or --names options.');
    const start = this.args.zero_based ? 0 : 1;
    const rows = table.agateReader(this.skipLines().lines(), this.reader_kwargs);
    const r = rows.next();
    if (r.done) throw pyError('StopIteration', '');
    r.value.forEach((c, i) => this.out.write(`${String(i + start).padStart(3)}: ${c}\n`));
  }

  /** @returns {boolean} whether the tool will wait on a terminal for standard input */
  additionalInputExpected() {
    return stdinIsTTY() && !this.args.input_path;
  }

  /**
   * agate.Table.from_csv over an open input.
   * @param {InputFile} f
   * @param {{skipLines?: number, sniffLimit?: number|null, kwargs?: object, rowLimit?: number|null,
   *   columnTypes?: table.TypeTester|Array|null}} [opts] from_csv's keywords; sniffLimit null sniffs the whole
   *   file and 0 does not sniff
   * @returns {table.Table}
   * @throws {Error} pyName ValueError for a negative rowLimit, CastError from the column types, and the reader's
   *   csv Error
   */
  tableFromCsv(f, opts = {}) {
    let skip = opts.skipLines || 0;
    while (skip > 0) { f.readline(); skip--; }
    let lines;
    const sniffLimit = opts.sniffLimit === undefined ? 0 : opts.sniffLimit;
    const kwargs = { ...(opts.kwargs || {}) };
    let sample;
    if (sniffLimit === null) {
      const all = f.read();
      sample = all;
      lines = splitLines(all)[Symbol.iterator]();
    } else {
      if (sniffLimit > 0) {
        if (f.isStdin) {
          if (f.pos > 0) sample = '';
          else {
            // f.buffer.peek(sniff_limit).decode(encoding, 'ignore')[:sniff_limit]: one raw read of stdin's
            // 4096-byte buffer, decoded with from_csv's default encoding (csvkit does not pass -e to it)
            f.load();
            const peeked = codecs.decodeIgnoringErrors(f.rawBytes.subarray(0, STDIN_BUFFER_SIZE), 'utf-8');
            sample = Array.from(peeked).slice(0, sniffLimit).join('');
          }
        } else {
          const offset = f.tell();
          sample = f.read(sniffLimit);
          f.seek(offset);
        }
      }
      lines = f.lines();
    }
    if (sniffLimit === null || sniffLimit > 0) {
      try {
        kwargs.dialect = pycsv.sniff(sample, [',', '\t', ';', ' ', ':', '|']);
      } catch (e) {
        if (!(e instanceof pycsv.CsvError)) throw e;
        warnings.warn(`${warnings.SITE_PACKAGES}/agate/table/from_csv.py`, 83, 'RuntimeWarning',
          `Error sniffing CSV dialect: ${e.message}`, "  kwargs['dialect'] = csv.Sniffer().sniff(sample)");
      }
    }
    if (opts.rowLimit != null && opts.rowLimit < 0) {
      throw pyError('ValueError', 'Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.');
    }
    const header = kwargs.header === undefined ? true : kwargs.header;
    const reader = table.agateReader(lines, kwargs);
    let columnNames = null;
    if (header) {
      const r = reader.next();
      columnNames = r.done ? [] : r.value;
    }
    let rows = [];
    for (const r of reader) {
      if (opts.rowLimit != null && rows.length >= opts.rowLimit) break;
      rows.push(r);
    }
    const t = new table.Table(rows, columnNames, opts.columnTypes, { caller: [
      `${warnings.SITE_PACKAGES}/agate/table/from_csv.py`, 104,
      '  return Table(rows, column_names, column_types, row_names=row_names)'] });
    pyTuple(t.columnNames);
    return t;
  }
}

// Marks an array as a Python tuple, whose repr ends a single element with ",".
function pyTuple(arr) {
  Object.defineProperty(arr, 'pyTuple', { value: true });
  return arr;
}

/**
 * csvkit.cli.make_default_headers: the column names "a", "b", ... "aa" agate gives n unnamed columns.
 * @param {number} n
 * @returns {string[]} a tuple-marked array
 */
function makeDefaultHeaders(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(table.letterName(i));
  return pyTuple(out);
}

function pyIntOrThrow(s) {
  return typeof s === 'number' ? s : strToInt(s);
}

// repr(column_names)[1:-1]: a one-element tuple's repr ends with a comma.
function reprList(names) {
  const body = names.map((n) => pyRepr(n)).join(', ');
  return names.pyTuple && names.length === 1 ? `${body},` : body;
}

/**
 * csvkit.cli.match_column_identifier: the zero-based index of a column given by name or by index.
 * @param {string[]} columnNames
 * @param {string|number} c a column name, or an index counted from `offset`
 * @param {number} [offset] 1 for one-based indices, 0 for zero-based
 * @returns {number}
 * @throws {ColumnIdentifierError} for a name that is not a column and not an integer, or an index out of range
 * @throws {Error} pyName IndexError for an index into an empty header
 */
function matchColumnIdentifier(columnNames, c, offset = 1) {
  if (typeof c === 'string' && !isDigit(c) && columnNames.includes(c)) return columnNames.indexOf(c);
  let v;
  try {
    v = pyIntOrThrow(c) - offset;
  } catch (e) {
    if (e.pyName !== 'ValueError') throw e;
    throw new ColumnIdentifierError(`Column '${c}' is invalid. It is neither an integer nor a column name. Column names are: ${reprList(columnNames)}`);
  }
  if (v < 0) throw new ColumnIdentifierError(`Column ${v + offset} is invalid. Columns are 1-based.`);
  if (v >= columnNames.length) {
    // the message reads column_names[-1], which fails on an empty sequence
    if (!columnNames.length) throw pyError('IndexError', `${columnNames.pyTuple ? 'tuple' : 'list'} index out of range`);
    throw new ColumnIdentifierError(`Column ${v + offset} is invalid. The last column is '${columnNames[columnNames.length - 1]}' at index ${columnNames.length - 1 + offset}.`);
  }
  return v;
}

function parseRange(c, n, excl) {
  let a;
  let b;
  if (c.includes(':')) [a, b] = [c.slice(0, c.indexOf(':')), c.slice(c.indexOf(':') + 1)];
  else if (c.includes('-')) [a, b] = [c.slice(0, c.indexOf('-')), c.slice(c.indexOf('-') + 1)];
  else return null;
  try {
    a = a ? pyIntOrThrow(a) : 1;
    b = b ? pyIntOrThrow(b) + 1 : (excl ? n : n + 1);
  } catch (e) {
    if (e.pyName !== 'ValueError') throw e;
    throw new ColumnIdentifierError('Invalid range %s. Ranges must be two integers separated by a - or : character.');
  }
  return [a, b];
}

/**
 * csvkit.cli.parse_column_identifiers: the zero-based indices selected by comma-separated names, indices and
 * ranges ("1-3", "2:"), less the excluded ones.
 * @param {string|null} ids the -c value
 * @param {string[]} columnNames
 * @param {number} [offset] 1 for one-based indices, 0 for zero-based
 * @param {string|null} [excluded] the -C value
 * @returns {number[]}
 * @throws {ColumnIdentifierError} for an entry that is neither a column nor a valid range
 */
function parseColumnIdentifiers(ids, columnNames, offset = 1, excluded = null) {
  if (!columnNames.length) return [];
  if (!ids && !excluded) return columnNames.map((_, i) => i);
  let columns = [];
  if (ids) {
    for (const c of ids.split(',')) {
      try {
        columns.push(matchColumnIdentifier(columnNames, c, offset));
      } catch (e) {
        if (!(e instanceof ColumnIdentifierError)) throw e;
        const r = parseRange(c, columnNames.length, false);
        if (!r) throw e;
        for (let x = r[0]; x < r[1]; x++) columns.push(matchColumnIdentifier(columnNames, x, offset));
      }
    }
  } else columns = columnNames.map((_, i) => i);
  const excludes = [];
  if (excluded) {
    for (const c of excluded.split(',')) {
      try {
        excludes.push(matchColumnIdentifier(columnNames, c, offset));
      } catch (e) {
        if (!(e instanceof ColumnIdentifierError)) throw e;
        const r = parseRange(c, columnNames.length, true);
        if (!r) continue;
        for (let x = r[0]; x < r[1]; x++) excludes.push(matchColumnIdentifier(columnNames, x, offset));
      }
    }
  }
  return columns.filter((c) => !excludes.includes(c));
}

function flushAndExit(code) {
  process.exitCode = code;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// Python's stdout in the C.UTF-8 locale: UTF-8 with the surrogateescape error handler, so U+DC80..U+DCFF are
// written as the bytes 0x80..0xFF and any other lone surrogate makes the write raise UnicodeEncodeError.
function encodeOutput(s) {
  const pieces = [];
  let last = 0;
  for (const m of s.matchAll(LONE_SURROGATE)) {
    const cu = m[0].charCodeAt(0);
    if (cu < 0xdc80 || cu > 0xdcff) {
      throw pyError('UnicodeEncodeError', `'utf-8' codec can't encode character '\\u${cu.toString(16)}' in position ${[...s.slice(0, m.index)].length}: surrogates not allowed`);
    }
    pieces.push(Buffer.from(s.slice(last, m.index)), Buffer.from([cu - 0xdc00]));
    last = m.index + 1;
  }
  if (!pieces.length) return s;
  pieces.push(Buffer.from(s.slice(last)));
  return Buffer.concat(pieces);
}

/**
 * Standard output collected in memory and written in one piece by flush(), encoded as Python writes it
 * (UTF-8 with surrogateescape for undecodable input bytes).
 */
class BufferedOut {
  constructor() { this.chunks = []; }

  /**
   * @param {string} s
   * @returns {void}
   */
  write(s) { this.chunks.push(encodeOutput(s)); }

  /**
   * Writes what was collected and empties the buffer.
   * @param {{write: function((string|Buffer)): *}} [stream]
   * @returns {void}
   */
  flush(stream = process.stdout) {
    const data = this.chunks.some((c) => typeof c !== 'string')
      ? Buffer.concat(this.chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)))
      : this.chunks.join('');
    this.chunks = [];
    if (data.length) stream.write(data);
  }
}

module.exports = {
  Utility, InputFile, ColumnIdentifierError, RequiredHeaderError, makeDefaultHeaders, matchColumnIdentifier,
  parseColumnIdentifiers, QUOTING_CHOICES, readBytes, decompress, stdinIsTTY,
};
