#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvstat (csvkit 2.2.0, MIT).
const { Utility, parseColumnIdentifiers } = require('../lib/cli');
const { addSniffAndInference } = require('../lib/common');
const { agateReader } = require('../lib/table');
const { OPERATIONS, calculateStats, printOne, printStats, printCsv, printJson } = require('../lib/csvstat-report');

/** csvstat: descriptive statistics for each column, as text, CSV or JSON, or one statistic with an operation flag. */
class CSVStat extends Utility {
  constructor() {
    super('csvstat', 'Print descriptive statistics for each column in a CSV file.');
  }

  /**
   * CSVStat.add_arguments: the output formats, -n, -c, the operation flags, --freq-count, --count, --decimal-format,
   * -G, -y and -I.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['--csv'], { dest: 'csv_output', action: 'store_true', help: 'Output results as a CSV table, rather than plain text.' });
    p.addArgument(['--json'], { dest: 'json_output', action: 'store_true', help: 'Output results as JSON text, rather than plain text.' });
    p.addArgument(['-i', '--indent'], { dest: 'indent', type: 'int', help: 'Indent the output JSON this many spaces. Disabled by default.' });
    p.addArgument(['-n', '--names'], { dest: 'names_only', action: 'store_true', help: 'Display column names and indices from the input CSV and exit.' });
    p.addArgument(['-c', '--columns'], { dest: 'columns', help: 'A comma-separated list of column indices, names or ranges to be examined, e.g. "1,id,3-5". Defaults to all columns.' });
    p.addArgument(['--type'], { dest: 'type_only', action: 'store_true', help: 'Only output data type.' });
    p.addArgument(['--nulls'], { dest: 'nulls_only', action: 'store_true', help: 'Only output whether columns contains nulls.' });
    p.addArgument(['--non-nulls'], { dest: 'nonnulls_only', action: 'store_true', help: 'Only output counts of non-null values.' });
    p.addArgument(['--unique'], { dest: 'unique_only', action: 'store_true', help: 'Only output counts of unique values.' });
    p.addArgument(['--min'], { dest: 'min_only', action: 'store_true', help: 'Only output smallest values.' });
    p.addArgument(['--max'], { dest: 'max_only', action: 'store_true', help: 'Only output largest values.' });
    p.addArgument(['--sum'], { dest: 'sum_only', action: 'store_true', help: 'Only output sums.' });
    p.addArgument(['--mean'], { dest: 'mean_only', action: 'store_true', help: 'Only output means.' });
    p.addArgument(['--median'], { dest: 'median_only', action: 'store_true', help: 'Only output medians.' });
    p.addArgument(['--stdev'], { dest: 'stdev_only', action: 'store_true', help: 'Only output standard deviations.' });
    p.addArgument(['--len'], { dest: 'len_only', action: 'store_true', help: 'Only output the length of the longest values.' });
    p.addArgument(['--max-precision'], { dest: 'maxprecision_only', action: 'store_true', help: 'Only output the most decimal places.' });
    p.addArgument(['--freq'], { dest: 'freq_only', action: 'store_true', help: 'Only output lists of frequent values.' });
    p.addArgument(['--freq-count'], { dest: 'freq_count', type: 'int', help: 'The maximum number of frequent values to display.' });
    p.addArgument(['--count'], { dest: 'count_only', action: 'store_true', help: 'Only output total row count.' });
    p.addArgument(['--decimal-format'], { dest: 'decimal_format', default: '%.3f', help: '%%-format specification for printing decimal numbers. Defaults to locale-specific formatting with "%%.3f".' });
    p.addArgument(['-G', '--no-grouping-separator'], { dest: 'no_grouping_separator', action: 'store_true', help: 'Do not use grouping separators in decimal numbers.' });
    addSniffAndInference(p);
  }

  /**
   * CSVStat.main.
   * @returns {void}
   * @throws {ExitError} with status 2 for more than one operation, an operation with --csv, --json or --count, or no
   *   input on a terminal
   * @throws {ColumnIdentifierError} for a -c entry that names no column
   * @throws {RequiredHeaderError} for -n with -H
   */
  main() {
    const a = this.args;
    if (a.names_only) {
      this.printColumnNames();
      return;
    }
    if (this.additionalInputExpected()) this.argparser.error('You must provide an input file or piped data.');
    const operations = OPERATIONS.map(([op]) => op).filter((op) => a[`${op}_only`]);
    if (operations.length > 1) this.argparser.error('Only one operation argument may be specified (--mean, --median, etc).');
    if (operations.length && a.csv_output) this.argparser.error('You may not specify --csv and an operation (--mean, --median, etc) at the same time.');
    if (operations.length && a.json_output) this.argparser.error('You may not specify --json and an operation (--mean, --median, etc) at the same time.');
    if (operations.length && a.count_only) this.argparser.error('You may not specify --count and an operation (--mean, --median, etc) at the same time.');
    if (a.count_only) {
      let count = [...agateReader(this.skipLines().lines(), this.reader_kwargs)].length;
      if (!a.no_header_row) count -= 1;
      this.out.write(`${count}\n`);
      return;
    }
    const table = this.tableFromCsv(this.input_file, {
      skipLines: a.skip_lines,
      sniffLimit: a.sniff_limit !== -1 ? a.sniff_limit : null,
      columnTypes: this.getColumnTypes(),
      kwargs: this.reader_kwargs,
    });
    const columnIds = parseColumnIdentifiers(a.columns, table.columnNames, this.columnOffset());
    const opts = { freqCount: a.freq_count ? a.freq_count : 5, decimalFormat: a.decimal_format, jsonOutput: a.json_output, indent: a.indent };
    if (operations.length) {
      for (const columnId of columnIds) printOne(this.out, table, columnId, operations[0], columnIds.length !== 1, opts);
      return;
    }
    const stats = new Map(columnIds.map((id) => [id, calculateStats(table, id, opts)]));
    if (a.csv_output) printCsv(this.out, table, columnIds, stats);
    else if (a.json_output) printJson(this.out, table, columnIds, stats, opts);
    else printStats(this.out, table, columnIds, stats, opts);
  }
}

new CSVStat().launch();
