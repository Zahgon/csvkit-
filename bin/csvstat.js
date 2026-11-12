#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvstat (csvkit 2.2.0, MIT).
const { pyError } = require('../lib/pyerrors');
const { Utility, parseColumnIdentifiers } = require('../lib/cli');
const { addSniffAndInference } = require('../lib/common');
const { agateReader } = require('../lib/table');
const T = require('../lib/types');
const { formatString } = require('../lib/pyformat');
const { dump, pyIntValue } = require('../lib/pyjson');
const { aggregate, countDistinct, mostCommon } = require('../lib/aggregations');
const pycsv = require('../lib/pycsv');

const OPERATIONS = [
  ['type', 'Type of data: '], ['nulls', 'Contains null values: '], ['nonnulls', 'Non-null values: '],
  ['unique', 'Unique values: '], ['min', 'Smallest value: '], ['max', 'Largest value: '], ['sum', 'Sum: '],
  ['mean', 'Mean: '], ['median', 'Median: '], ['stdev', 'StDev: '], ['len', 'Longest value: '],
  ['maxprecision', 'Most decimal places: '], ['freq', 'Most common values: '],
];
const LABEL_WIDTH = Math.max(...OPERATIONS.map(([, label]) => label.length));
const INT_STATS = new Set(['nonnulls', 'unique', 'maxprecision']);

// str(value).
function pyStr(v) {
  if (v === null) return 'None';
  if (v instanceof T.PyDateTime) return v.pyStr(' ');
  return pycsv.pyStr(v);
}

/**
 * @param {*} v a statistic
 * @returns {boolean} whether it is a finite Decimal
 */
function isFiniteDecimal(v) {
  return v !== null && v.isDecimal === true && !v.special;
}

// format_decimal: locale.format_string(f, d, grouping=not no_grouping_separator).rstrip('0').rstrip('.')
function formatDecimal(d, f) {
  return formatString(f, d).replace(/0+$/, '').replace(/\.+$/, '');
}

// csvkit.cli.default_float_decimal, the json.dump default of --json.
function defaultFloatDecimal(v) {
  if (v instanceof T.PyTimeDelta) return v.totalSeconds();
  if (v.isDecimal) return v.toNumber();
  if (v instanceof T.PyDate || v instanceof T.PyDateTime) return v.pyStr();
  throw pyError('TypeError', `${pyStr(v)} is not JSON serializable`);
}

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
    const freqCount = a.freq_count ? a.freq_count : 5;
    if (operations.length) {
      for (const columnId of columnIds) this.printOne(table, columnId, operations[0], columnIds.length !== 1, freqCount);
      return;
    }
    const stats = new Map(columnIds.map((id) => [id, this.calculateStats(table, id, freqCount)]));
    if (a.csv_output) this.printCsv(table, columnIds, stats);
    else if (a.json_output) this.printJson(table, columnIds, stats);
    else this.printStats(table, columnIds, stats);
  }

  /**
   * CSVStat._calculate_stat: one statistic of a column, formatted with --decimal-format for text and CSV output.
   * csvstat wraps it in `except Exception: return None`, so any Python exception (an error with a pyName) gives
   * null; other errors are faults in the port and propagate.
   * @param {object} table the agate Table
   * @param {number} columnId
   * @param {string} op the operation name, e.g. "mean"
   * @param {number} freqCount how many frequent values
   * @returns {*} the statistic, or null
   */
  calculateStat(table, columnId, op, freqCount) {
    const type = table.columnTypes[columnId];
    const values = table.rows.map((r) => r[columnId]);
    try {
      if (op === 'type') return type.name;
      if (op === 'unique') return pyIntValue(countDistinct(values));
      if (op === 'freq') return mostCommon(values, freqCount).map(([value, count]) => ({ value, count }));
      const v = aggregate(op, type, values);
      if (INT_STATS.has(op)) return pyIntValue(v);
      if (isFiniteDecimal(v) && !this.args.json_output) return formatDecimal(v, this.args.decimal_format);
      return v;
    } catch (e) {
      if (e.pyName) return null;
      throw e;
    }
  }

  /**
   * Every statistic of a column.
   * @param {object} table the agate Table
   * @param {number} columnId
   * @param {number} freqCount
   * @returns {Map<string, *>} statistic by operation name
   */
  calculateStats(table, columnId, freqCount) {
    return new Map(OPERATIONS.map(([op]) => [op, this.calculateStat(table, columnId, op, freqCount)]));
  }

  /**
   * CSVStat.print_one: one statistic of a column, labelled with the column when several are printed.
   * @param {object} table the agate Table
   * @param {number} columnId
   * @param {string} op
   * @param {boolean} label whether to prefix the column number and name
   * @param {number} freqCount
   * @returns {void}
   */
  printOne(table, columnId, op, label, freqCount) {
    let stat = this.calculateStat(table, columnId, op, freqCount);
    if (op === 'freq') stat = `{ ${stat.map((row) => `"${pyStr(row.value)}": ${row.count}`).join(', ')} }`;
    else stat = pyStr(stat);
    if (label) this.out.write(`${String(columnId + 1).padStart(3)}. ${table.columnNames[columnId]}: ${stat}\n`);
    else this.out.write(`${stat}\n`);
  }

  /**
   * CSVStat.print_stats: the text report and the row count.
   * @param {object} table the agate Table
   * @param {number[]} columnIds
   * @param {Map<number, Map<string, *>>} stats
   * @returns {void}
   */
  printStats(table, columnIds, stats) {
    for (const columnId of columnIds) {
      const columnStats = stats.get(columnId);
      const isNumber = table.columnTypes[columnId] instanceof T.NumberType;
      this.out.write(`${String(columnId + 1).padStart(3)}. "${table.columnNames[columnId]}"\n\n`);
      for (const [op, label] of OPERATIONS) {
        const v = columnStats.get(op);
        if (v === null) continue;
        if (op === 'freq') {
          v.forEach((row, i) => {
            this.out.write(`\t${(i === 0 ? label : '').padEnd(LABEL_WIDTH)} `);
            const value = isNumber && isFiniteDecimal(row.value) ? formatDecimal(row.value, this.args.decimal_format) : row.value;
            this.out.write(`${pyStr(value)} (${row.count}x)\n`);
          });
          continue;
        }
        let text = pyStr(v);
        if (op === 'nulls' && v) text = `${text} (excluded from calculations)`;
        else if (op === 'len') text = `${text} characters`;
        this.out.write(`\t${label.padEnd(LABEL_WIDTH)} ${text}\n`);
      }
      this.out.write('\n');
    }
    this.out.write(`Row count: ${table.rows.length}\n`);
  }

  /**
   * CSVStat.print_csv: one CSV row per column.
   * @param {object} table the agate Table
   * @param {number[]} columnIds
   * @param {Map<number, Map<string, *>>} stats
   * @returns {void}
   */
  printCsv(table, columnIds, stats) {
    const header = ['column_id', 'column_name', ...OPERATIONS.map(([op]) => op)];
    const writer = new pycsv.Writer(this.out, { lineterminator: '\n' });
    writer.writerow(header);
    for (const row of this.rows(table, columnIds, stats)) {
      if (row.has('freq')) row.set('freq', row.get('freq').map((r) => pyStr(r.value)).join(', '));
      writer.writerow(header.map((field) => (row.has(field) ? pyStr(row.get(field)).replace(/\r/g, '\n') : '')));
    }
  }

  /**
   * CSVStat.print_json: one JSON object per column, with -i's indent.
   * @param {object} table the agate Table
   * @param {number[]} columnIds
   * @param {Map<number, Map<string, *>>} stats
   * @returns {void}
   * @throws {Error} pyName TypeError for a value JSON cannot serialize
   */
  printJson(table, columnIds, stats) {
    const data = [...this.rows(table, columnIds, stats)].map((row) => {
      if (row.has('freq')) row.set('freq', row.get('freq').map((r) => new Map([['value', r.value], ['count', pyIntValue(r.count)]])));
      return row;
    });
    dump(data, this.out, { indent: this.args.indent, ensureAscii: false, default: defaultFloatDecimal });
  }

  /**
   * The per-column rows --csv and --json print: the column id and name, then each statistic that is not null.
   * @param {object} table the agate Table
   * @param {number[]} columnIds
   * @param {Map<number, Map<string, *>>} stats
   * @returns {Generator<Map<string, *>>}
   */
  * rows(table, columnIds, stats) {
    for (const columnId of columnIds) {
      const row = new Map([['column_id', pyIntValue(columnId + 1)], ['column_name', table.columnNames[columnId]]]);
      for (const [op] of OPERATIONS) if (stats.get(columnId).get(op) !== null) row.set(op, stats.get(columnId).get(op));
      yield row;
    }
  }
}

new CSVStat().launch();
