#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvcut (csvkit 2.2.0, MIT).

const { Utility } = require('../lib/cli');
const { LineWriter } = require('../lib/table');

/** csvcut: selects, reorders and drops columns, without type inference. */
class CSVCut extends Utility {
  constructor() {
    super('csvcut', 'Filter and truncate CSV files. Like the Unix "cut" command, but for tabular data.', '', ['L', 'I']);
  }

  /**
   * CSVCut.add_arguments: -n, -c, -C and -x.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['-n', '--names'], { dest: 'names_only', action: 'store_true', help: 'Display column names and indices from the input CSV and exit.' });
    p.addArgument(['-c', '--columns'], { dest: 'columns', help: 'A comma-separated list of column indices, names or ranges to be extracted, e.g. "1,id,3-5". Defaults to all columns.' });
    p.addArgument(['-C', '--not-columns'], { dest: 'not_columns', help: 'A comma-separated list of column indices, names or ranges to be excluded, e.g. "1,id,3-5". Defaults to no columns.' });
    p.addArgument(['-x', '--delete-empty-rows'], { dest: 'delete_empty', action: 'store_true', help: 'After cutting, delete rows which are completely empty.' });
  }

  /**
   * CSVCut.main.
   * @returns {void}
   * @throws {ColumnIdentifierError} for a -c or -C entry that names no column
   * @throws {RequiredHeaderError} for -n with -H
   */
  main() {
    if (this.args.names_only) { this.printColumnNames(); return; }
    if (this.additionalInputExpected()) process.stderr.write('No input file or piped data provided. Waiting for standard input:\n');
    const [rows, names, ids] = this.getRowsAndColumnNamesAndColumnIds(this.reader_kwargs);
    const out = new LineWriter(this.out, this.writer_kwargs);
    out.writerow(ids.map((i) => names[i]));
    for (const row of rows) {
      const o = ids.map((i) => (i < row.length ? row[i] : null));
      if (!this.args.delete_empty || o.some((v) => v)) out.writerow(o);
    }
  }
}

new CSVCut().launch();
