#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvgrep (csvkit 2.2.0, MIT).

const fs = require('node:fs');
const { ArgumentError } = require('../lib/argparse');
const { Utility, readBytes } = require('../lib/cli');
const codecs = require('../lib/codecs');
const { osError } = require('../lib/pyerrors');
const { LineWriter } = require('../lib/table');
const { FilteringCSVReader } = require('../lib/grep');
const pyre = require('../lib/pyre');
const { rstrip } = require('../lib/pyunicode');
const warnings = require('../lib/warnings');

const CSVGREP_PY = `${warnings.SITE_PACKAGES}/csvkit/utilities/csvgrep.py`;

/**
 * {line.rstrip() for line in self.args.matchfile}: the lines of the -f file, read as text in universal newlines mode.
 * A named file is UTF-8 (strict), while sys.stdin's surrogateescape decoding turns undecodable bytes into lone
 * surrogates; such a line can never equal a cell, so it is left out.
 * @param {{bytes: Buffer|null, stdin: boolean}} matchfile what the -f type read (standard input is read here, after
 *   the CSV input, as Python reads sys.stdin only when it iterates it)
 * @returns {Set<string>}
 * @throws {Error} pyName UnicodeDecodeError for a named file that is not UTF-8
 */
function matchLines(matchfile) {
  const lines = new Set();
  if (!matchfile.stdin) {
    const reader = new codecs.TextReader(matchfile.bytes, 'utf-8');
    for (let line = reader.readline(); line; line = reader.readline()) lines.add(rstrip(line));
    return lines;
  }
  const raws = readBytes(null).toString('latin1').split(/\r\n|\r|\n/);
  // the text after the last line end is a line only when it is not empty
  if (raws[raws.length - 1] === '') raws.pop();
  for (const raw of raws) {
    try {
      lines.add(rstrip(codecs.decode(Buffer.from(raw, 'latin1'), 'utf-8')));
    } catch (e) {
      if (e.pyName !== 'UnicodeDecodeError') throw e;
    }
  }
  return lines;
}

/** csvgrep: keeps the rows whose given columns match a string, a regular expression or a line of a file. */
class CSVGrep extends Utility {
  constructor() {
    super('csvgrep', 'Search CSV files. Like the Unix "grep" command, but for tabular data.', '', ['L', 'I']);
  }

  /**
   * CSVGrep.add_arguments: -n, -c, -m, -r, -f, -i and -a.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['-n', '--names'], { dest: 'names_only', action: 'store_true', help: 'Display column names and indices from the input CSV and exit.' });
    p.addArgument(['-c', '--columns'], { dest: 'columns', help: 'A comma-separated list of column indices, names or ranges to be searched, e.g. "1,id,3-5".' });
    p.addArgument(['-m', '--match'], { dest: 'pattern', help: 'A string to search for.' });
    p.addArgument(['-r', '--regex'], { dest: 'regex', help: 'A regular expression to match.' });
    p.addArgument(['-f', '--file'], {
      dest: 'matchfile',
      // argparse.FileType('r'): '-' is sys.stdin, any other path is opened now and read in main()
      type: (v) => {
        if (v === '-') return { bytes: null, stdin: true };
        try {
          return { bytes: fs.readFileSync(v), stdin: false };
        } catch (e) {
          throw new ArgumentError(`argument -f/--file: can't open '${v}': ${osError(e, v).message}`);
        }
      },
      help: 'A path to a file. For each row, if any line in the file (stripped of line separators) is an exact match of the cell value, the row matches.',
    });
    p.addArgument(['-i', '--invert-match'], { dest: 'inverse', action: 'store_true', help: 'Select non-matching rows, instead of matching rows.' });
    p.addArgument(['-a', '--any-match'], { dest: 'any_match', action: 'store_true', help: 'Select rows in which any column matches, instead of all columns.' });
  }

  /**
   * CSVGrep.main.
   * @returns {void}
   * @throws {ColumnIdentifierError} for a -c entry that names no column
   * @throws {Error} pyName re.error for an invalid -r pattern, and the reader's _csv.Error
   */
  main() {
    const a = this.args;
    if (a.names_only) { this.printColumnNames(); return; }
    if (this.additionalInputExpected()) process.stderr.write('No input file or piped data provided. Waiting for standard input:\n');
    if (!a.columns) this.argparser.error('You must specify at least one column to search using the -c option.');
    if (a.regex === null && a.pattern === null && a.matchfile === null) this.argparser.error('One of -r, -m or -f must be specified, unless using the -n option.');
    const rk = { ...this.reader_kwargs };
    const wk = { ...this.writer_kwargs };
    if (wk.lineNumbers) { delete wk.lineNumbers; rk.lineNumbers = true; }
    const [rows, names, ids] = this.getRowsAndColumnNamesAndColumnIds(rk);
    let pattern;
    if (a.regex) {
      pattern = pyre.compile(a.regex, {
        warn: (category, message) => warnings.warn(CSVGREP_PY, 64, category, message,
          '  pattern = re.compile(self.args.regex)'),
      });
    } else if (a.matchfile !== null) {
      const lines = matchLines(a.matchfile);
      pattern = (x) => lines.has(x);
    } else {
      pattern = a.pattern;
    }
    const patterns = new Map(ids.map((i) => [i, pattern]));
    const filterReader = new FilteringCSVReader(rows, patterns, { header: false, inverse: a.inverse, anyMatch: a.any_match });
    const out = new LineWriter(this.out, wk);
    out.writerow(names);
    for (const row of filterReader) out.writerow(row);
  }
}

new CSVGrep().launch();
