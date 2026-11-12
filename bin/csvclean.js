#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvclean (csvkit 2.2.0, MIT).

const { ExitError } = require('../lib/argparse');
const { Utility } = require('../lib/cli');
const { joinRows } = require('../lib/cleanup');
const { LineWriter, agateCsvError } = require('../lib/table');
const { pyRepr } = require('../lib/pystr');
const pycsv = require('../lib/pycsv');
const { pyError } = require('../lib/pyerrors');

// list.remove() on csvkit's Error dataclass: the first error equal by line number, row and message.
function removeError(errors, error) {
  const same = (e) => e.line === error.line && e.msg === error.msg && e.row.length === error.row.length
    && e.row.every((v, i) => v === error.row[i]);
  const index = errors.findIndex(same);
  if (index < 0) throw pyError('ValueError', 'list.remove(x): x not in list');
  errors.splice(index, 1);
}
const { split } = require('../lib/pyunicode');

/** csvclean: reports (and with its options fixes) rows whose length differs from the header, and empty columns. */
class CSVClean extends Utility {
  constructor() {
    super('csvclean', 'Report and fix common errors in a CSV file.', '', ['L', 'I']);
  }

  /**
   * CSVClean.add_arguments: the check and fix options.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['--length-mismatch'], { dest: 'length_mismatch', action: 'store_true', help: 'Report data rows that are shorter or longer than the header row.' });
    p.addArgument(['--empty-columns'], { dest: 'empty_columns', action: 'store_true', help: 'Report empty columns as errors.' });
    p.addArgument(['-a', '--enable-all-checks'], { dest: 'enable_all_checks', action: 'store_true', help: 'Enable all error reporting.' });
    p.addArgument(['--omit-error-rows'], { dest: 'omit_error_rows', action: 'store_true', help: 'Omit data rows that contain errors, from standard output.' });
    p.addArgument(['--label'], { dest: 'label', help: 'Add a "label" column to standard error. Useful in automated workflows. Use "-" to default to the input filename.' });
    p.addArgument(['--header-normalize-space'], { dest: 'header_normalize_space', action: 'store_true', help: 'Strip leading and trailing whitespace and replace sequences of whitespace characters by a single space in the header.' });
    p.addArgument(['--join-short-rows'], { dest: 'join_short_rows', action: 'store_true', help: 'Merges short rows into a single row.' });
    p.addArgument(['--separator'], { dest: 'separator', default: '\n', help: 'The string with which to join short rows. Defaults to a newline.' });
    p.addArgument(['--fill-short-rows'], { dest: 'fill_short_rows', action: 'store_true', help: 'Fill short rows with the missing cells.' });
    p.addArgument(['--fillvalue'], { dest: 'fillvalue', help: 'The value with which to fill short rows. Defaults to none.' });
  }

  /**
   * CSVClean.main: writes the fixed rows to standard output and the errors found, as CSV, to standard error.
   * @returns {void}
   * @throws {ExitError} with status 1 when errors were found
   * @throws {Error} pyName agate.exceptions.FieldSizeLimitError or _csv.Error from the reader
   */
  main() {
    const a = this.args;
    if (this.additionalInputExpected()) process.stderr.write('No input file or piped data provided. Waiting for standard input:\n');
    if (!a.length_mismatch && !a.empty_columns && !a.enable_all_checks && !a.header_normalize_space && !a.join_short_rows && !a.fill_short_rows) {
      this.argparser.error('No checks or fixes were enabled. See available options with: csvclean --help');
    }
    if (a.join_short_rows && a.fill_short_rows) this.argparser.error('The --join-short-rows and --fill-short-rows options are mutually exclusive.');
    const dflt = a.enable_all_checks;
    const lengthMismatch = dflt || a.length_mismatch;
    const emptyColumns = dflt || a.empty_columns;
    const kw = { ...this.reader_kwargs };
    delete kw.header;
    const csvReader = new pycsv.Reader(this.skipLines().lines(), kw);
    // agate.csv.reader
    const reader = {
      readRow() {
        try {
          return csvReader.readRow();
        } catch (e) {
          throw agateCsvError(e, csvReader.line_num);
        }
      },
      get line_num() { return csvReader.line_num; },
    };
    let names = reader.readRow();
    if (names === null) names = [];
    else if (a.header_normalize_space) names = names.map((n) => split(n).join(' '));
    const errors = [];
    const out = new LineWriter(this.out, this.writer_kwargs);
    out.writerow(names);
    const n = names.length;
    let joinable = [];
    let rowCount = 0;
    const emptyCounts = names.map(() => 0);
    for (;;) {
      let row = reader.readRow();
      if (row === null) break;
      const lineNumber = reader.line_num - 1;
      rowCount++;
      const lengthError = { line: lineNumber, row, msg: `Expected ${n} columns, found ${row.length} columns` };
      if (a.fill_short_rows) {
        if (row.length < n) row = row.concat(Array(n - row.length).fill(a.fillvalue));
      } else if (a.join_short_rows) {
        if (row.length >= n) joinable = [];
        else {
          joinable.push(lengthError);
          if (joinable.length > 1) {
            while (joinable.length) {
              const fixed = joinRows(joinable.map((e) => e.row), a.separator);
              if (fixed.length < n) break;
              if (fixed.length === n) {
                row = fixed;
                if (lengthMismatch) for (const f of joinable) removeError(errors, f);
                joinable = [];
                break;
              }
              joinable = joinable.slice(1);
            }
          }
        }
      }
      if (lengthMismatch && row.length !== n) errors.push(lengthError);
      if (emptyColumns) for (let i = 0; i < n; i++) if (i >= row.length || row[i] === '') emptyCounts[i]++;
      if (!a.omit_error_rows || row.length === n) out.writerow(row);
    }
    if (rowCount) {
      const empty = [];
      emptyCounts.forEach((c, i) => { if (c === rowCount) empty.push(i); });
      if (empty.length) {
        const off = a.zero_based ? 0 : 1;
        errors.push({ line: 1, row: names.map(() => ''), msg: `Empty columns named ${empty.map((i) => pyRepr(names[i])).join(', ')}! Try: csvcut -C ${empty.map((i) => i + off).join(',')}` });
      }
    }
    if (errors.length) {
      let label = a.label;
      if (label === '-') label = this.input_file.isStdin ? 'stdin' : this.input_file.name;
      this.out.flush();
      const ew = new LineWriter(process.stderr, this.writer_kwargs);
      const fields = ['line_number', 'msg', ...names];
      if (a.label) fields.unshift('label');
      ew.writerow(fields);
      for (const e of errors) {
        const r = [e.line, e.msg, ...e.row];
        if (a.label) r.unshift(label);
        ew.writerow(r);
      }
      throw new ExitError(1);
    }
  }
}

new CSVClean().launch();
