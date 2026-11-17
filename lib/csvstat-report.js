'use strict';
// Port of the statistics and report printing of csvkit.utilities.csvstat (csvkit 2.2.0, MIT): _calculate_stat,
// calculate_stats, print_one, print_stats, print_csv and print_json, over agate's aggregations.

const { pyError } = require('./pyerrors');
const T = require('./types');
const { formatString } = require('./pyformat');
const { dump, pyIntValue } = require('./pyjson');
const { aggregate, countDistinct, mostCommon } = require('./aggregations');
const pycsv = require('./pycsv');

// OPERATIONS: each statistic's name and its label in the text report, in report order.
const OPERATIONS = [
  ['type', 'Type of data: '], ['nulls', 'Contains null values: '], ['nonnulls', 'Non-null values: '],
  ['unique', 'Unique values: '], ['min', 'Smallest value: '], ['max', 'Largest value: '], ['sum', 'Sum: '],
  ['mean', 'Mean: '], ['median', 'Median: '], ['stdev', 'StDev: '], ['len', 'Longest value: '],
  ['maxprecision', 'Most decimal places: '], ['freq', 'Most common values: '],
];
const LABEL_WIDTH = Math.max(...OPERATIONS.map(([, label]) => label.length));
const INT_STATS = new Set(['nonnulls', 'unique', 'maxprecision']);

/**
 * str(value): the Python text of a statistic or value.
 * @param {*} v the value
 * @returns {string}
 */
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

/**
 * format_decimal: locale.format_string(f, d, grouping=not no_grouping_separator).rstrip('0').rstrip('.')
 * @param {object} d a finite Decimal
 * @param {string} f the --decimal-format specification
 * @returns {string}
 */
function formatDecimal(d, f) {
  return formatString(f, d).replace(/0+$/, '').replace(/\.+$/, '');
}

/**
 * csvkit.cli.default_float_decimal, the json.dump default of --json.
 * @param {*} v a value json.dump cannot serialize itself
 * @returns {(number|string)}
 * @throws {Error} pyName TypeError for a value that is not a timedelta, Decimal, date or datetime
 */
function defaultFloatDecimal(v) {
  if (v instanceof T.PyTimeDelta) return v.totalSeconds();
  if (v.isDecimal) return v.toNumber();
  if (v instanceof T.PyDate || v instanceof T.PyDateTime) return v.pyStr();
  throw pyError('TypeError', `${pyStr(v)} is not JSON serializable`);
}

/**
 * CSVStat._calculate_stat: one statistic of a column, formatted with --decimal-format for text and CSV output.
 * csvstat wraps it in `except Exception: return None`, so any Python exception (an error with a pyName) gives
 * null; other errors are faults in the port and propagate.
 * @param {object} table the agate Table
 * @param {number} columnId
 * @param {string} op the operation name, e.g. "mean"
 * @param {{freqCount: number, decimalFormat: string, jsonOutput: boolean}} opts --freq-count (default 5),
 *   --decimal-format and --json
 * @returns {*} the statistic, or null
 */
function calculateStat(table, columnId, op, opts) {
  const type = table.columnTypes[columnId];
  const values = table.rows.map((r) => r[columnId]);
  try {
    if (op === 'type') return type.name;
    if (op === 'unique') return pyIntValue(countDistinct(values));
    if (op === 'freq') return mostCommon(values, opts.freqCount).map(([value, count]) => ({ value, count }));
    const v = aggregate(op, type, values);
    if (INT_STATS.has(op)) return pyIntValue(v);
    if (isFiniteDecimal(v) && !opts.jsonOutput) return formatDecimal(v, opts.decimalFormat);
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
 * @param {{freqCount: number, decimalFormat: string, jsonOutput: boolean}} opts as for calculateStat
 * @returns {Map<string, *>} statistic by operation name
 */
function calculateStats(table, columnId, opts) {
  return new Map(OPERATIONS.map(([op]) => [op, calculateStat(table, columnId, op, opts)]));
}

/**
 * CSVStat.print_one: one statistic of a column, labelled with the column when several are printed.
 * @param {{write: function(string): void}} out the output stream
 * @param {object} table the agate Table
 * @param {number} columnId
 * @param {string} op
 * @param {boolean} label whether to prefix the column number and name
 * @param {{freqCount: number, decimalFormat: string, jsonOutput: boolean}} opts as for calculateStat
 * @returns {void}
 */
function printOne(out, table, columnId, op, label, opts) {
  let stat = calculateStat(table, columnId, op, opts);
  if (op === 'freq') stat = `{ ${stat.map((row) => `"${pyStr(row.value)}": ${row.count}`).join(', ')} }`;
  else stat = pyStr(stat);
  if (label) out.write(`${String(columnId + 1).padStart(3)}. ${table.columnNames[columnId]}: ${stat}\n`);
  else out.write(`${stat}\n`);
}

/**
 * CSVStat.print_stats: the text report and the row count.
 * @param {{write: function(string): void}} out the output stream
 * @param {object} table the agate Table
 * @param {number[]} columnIds
 * @param {Map<number, Map<string, *>>} stats
 * @param {{decimalFormat: string}} opts --decimal-format
 * @returns {void}
 */
function printStats(out, table, columnIds, stats, opts) {
  for (const columnId of columnIds) {
    const columnStats = stats.get(columnId);
    const isNumber = table.columnTypes[columnId] instanceof T.NumberType;
    out.write(`${String(columnId + 1).padStart(3)}. "${table.columnNames[columnId]}"\n\n`);
    for (const [op, label] of OPERATIONS) {
      const v = columnStats.get(op);
      if (v === null) continue;
      if (op === 'freq') {
        v.forEach((row, i) => {
          out.write(`\t${(i === 0 ? label : '').padEnd(LABEL_WIDTH)} `);
          const value = isNumber && isFiniteDecimal(row.value) ? formatDecimal(row.value, opts.decimalFormat) : row.value;
          out.write(`${pyStr(value)} (${row.count}x)\n`);
        });
        continue;
      }
      let text = pyStr(v);
      if (op === 'nulls' && v) text = `${text} (excluded from calculations)`;
      else if (op === 'len') text = `${text} characters`;
      out.write(`\t${label.padEnd(LABEL_WIDTH)} ${text}\n`);
    }
    out.write('\n');
  }
  out.write(`Row count: ${table.rows.length}\n`);
}

/**
 * CSVStat.print_csv: one CSV row per column.
 * @param {{write: function(string): void}} out the output stream
 * @param {object} table the agate Table
 * @param {number[]} columnIds
 * @param {Map<number, Map<string, *>>} stats
 * @returns {void}
 */
function printCsv(out, table, columnIds, stats) {
  const header = ['column_id', 'column_name', ...OPERATIONS.map(([op]) => op)];
  const writer = new pycsv.Writer(out, { lineterminator: '\n' });
  writer.writerow(header);
  for (const row of statRows(table, columnIds, stats)) {
    if (row.has('freq')) row.set('freq', row.get('freq').map((r) => pyStr(r.value)).join(', '));
    writer.writerow(header.map((field) => (row.has(field) ? pyStr(row.get(field)).replace(/\r/g, '\n') : '')));
  }
}

/**
 * CSVStat.print_json: one JSON object per column, with -i's indent.
 * @param {{write: function(string): void}} out the output stream
 * @param {object} table the agate Table
 * @param {number[]} columnIds
 * @param {Map<number, Map<string, *>>} stats
 * @param {{indent: (number|null)}} opts -i
 * @returns {void}
 * @throws {Error} pyName TypeError for a value JSON cannot serialize
 */
function printJson(out, table, columnIds, stats, opts) {
  const data = [...statRows(table, columnIds, stats)].map((row) => {
    if (row.has('freq')) row.set('freq', row.get('freq').map((r) => new Map([['value', r.value], ['count', pyIntValue(r.count)]])));
    return row;
  });
  dump(data, out, { indent: opts.indent, ensureAscii: false, default: defaultFloatDecimal });
}

/**
 * The per-column rows --csv and --json print: the column id and name, then each statistic that is not null.
 * @param {object} table the agate Table
 * @param {number[]} columnIds
 * @param {Map<number, Map<string, *>>} stats
 * @returns {Generator<Map<string, *>>}
 */
function* statRows(table, columnIds, stats) {
  for (const columnId of columnIds) {
    const row = new Map([['column_id', pyIntValue(columnId + 1)], ['column_name', table.columnNames[columnId]]]);
    for (const [op] of OPERATIONS) if (stats.get(columnId).get(op) !== null) row.set(op, stats.get(columnId).get(op));
    yield row;
  }
}

module.exports = { OPERATIONS, calculateStats, printOne, printStats, printCsv, printJson };
