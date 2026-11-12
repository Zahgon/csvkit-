#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvsort (csvkit 2.2.0, MIT).

const { Utility, parseColumnIdentifiers } = require('../lib/cli');
const { NULL_ORDER } = require('../lib/table');
const { addSniffAndInference } = require('../lib/common');
const { pyUpper } = require('../lib/pystr');

/** csvsort: sorts the rows by one or more columns, with type inference. */
class CSVSort extends Utility {
  constructor() {
    super('csvsort', 'Sort CSV files. Like the Unix "sort" command, but for tabular data.');
  }

  /**
   * CSVSort.add_arguments: -n, -c, -r, -i, -y and -I.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['-n', '--names'], { dest: 'names_only', action: 'store_true', help: 'Display column names and indices from the input CSV and exit.' });
    p.addArgument(['-c', '--columns'], { dest: 'columns', help: 'A comma-separated list of column indices, names or ranges to sort by, e.g. "1,id,3-5". Defaults to all columns.' });
    p.addArgument(['-r', '--reverse'], { dest: 'reverse', action: 'store_true', help: 'Sort in descending order.' });
    p.addArgument(['-i', '--ignore-case'], { dest: 'ignore_case', action: 'store_true', help: 'Perform case-independent sorting.' });
    addSniffAndInference(p);
  }

  /**
   * CSVSort.main.
   * @returns {void}
   * @throws {ColumnIdentifierError} for a -c entry that names no column
   * @throws {ExitError} with status 2 when no input is given on a terminal
   * @throws {RequiredHeaderError} for -n with -H
   */
  main() {
    const a = this.args;
    if (a.names_only) { this.printColumnNames(); return; }
    if (this.additionalInputExpected()) this.argparser.error('You must provide an input file or piped data.');
    const t = this.tableFromCsv(this.input_file, {
      skipLines: a.skip_lines,
      sniffLimit: a.sniff_limit !== -1 ? a.sniff_limit : null,
      columnTypes: this.getColumnTypes(),
      kwargs: this.reader_kwargs,
    });
    const key = parseColumnIdentifiers(a.columns, t.columnNames, this.columnOffset());
    const keyFn = (row) => key.map((n) => {
      const v = row[n];
      if (v === null) return NULL_ORDER;
      if (a.ignore_case && typeof v === 'string') return pyUpper(v);
      return v;
    });
    const sorted = t.orderBy(keyFn, a.reverse);
    sorted.toCsv(this.out, this.writer_kwargs);
  }
}

new CSVSort().launch();
