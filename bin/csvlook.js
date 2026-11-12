#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvlook (csvkit 2.2.0, MIT).
const { Utility } = require('../lib/cli');
const { printTable } = require('../lib/print-table');
const { addSniffAndInference } = require('../lib/common');

/** csvlook: renders a CSV file as a Markdown-compatible fixed-width table. */
class CSVLook extends Utility {
  constructor() {
    super('csvlook', 'Render a CSV file in the console as a Markdown-compatible, fixed-width table.');
  }

  /**
   * CSVLook.add_arguments: --max-rows, --max-columns, --max-column-width, --max-precision, --no-number-ellipsis, -y
   * and -I.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['--max-rows'], { dest: 'max_rows', type: 'int', help: 'The maximum number of rows to display before truncating the data.' });
    p.addArgument(['--max-columns'], { dest: 'max_columns', type: 'int', help: 'The maximum number of columns to display before truncating the data.' });
    p.addArgument(['--max-column-width'], { dest: 'max_column_width', type: 'int', help: 'Truncate all columns to at most this width. The remainder will be replaced with ellipsis.' });
    p.addArgument(['--max-precision'], { dest: 'max_precision', type: 'int', help: 'The maximum number of decimal places to display. The remainder will be replaced with ellipsis.' });
    p.addArgument(['--no-number-ellipsis'], { dest: 'no_number_ellipsis', action: 'store_true', help: 'Disable the ellipsis if --max-precision is exceeded.' });
    addSniffAndInference(p);
  }

  /**
   * CSVLook.main.
   * @returns {void}
   * @throws {ExitError} with status 2 when no input is given on a terminal
   * @throws {Error} pyName ValueError for a negative --max-rows, and the reader's and casts' errors
   */
  main() {
    const a = this.args;
    if (this.additionalInputExpected()) this.argparser.error('You must provide an input file or piped data.');
    const opts = {};
    if (a.max_precision !== null) opts.maxPrecision = a.max_precision;
    if (a.no_number_ellipsis) opts.numberTruncation = '';
    const kw = { ...this.reader_kwargs };
    if (a.line_numbers) kw.lineNumbers = true;
    const t = this.tableFromCsv(this.input_file, {
      skipLines: a.skip_lines,
      sniffLimit: a.sniff_limit !== -1 ? a.sniff_limit : null,
      rowLimit: a.max_rows,
      columnTypes: this.getColumnTypes(),
      kwargs: kw,
    });
    printTable(t, this.out, { maxRows: a.max_rows, maxColumns: a.max_columns, maxColumnWidth: a.max_column_width, ...opts });
  }
}

new CSVLook().launch();
