#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvjoin (csvkit 2.2.0, MIT).

const { Utility, stdinIsTTY, matchColumnIdentifier } = require('../lib/cli');
const { Table, deduplicate } = require('../lib/table');
const { addSniffAndInference } = require('../lib/common');

/**
 * A string that two cell values share exactly when Python's dict treats them as the same key (True, 1 and
 * Decimal('1.0') are one key).
 * @param {*} v a cast cell value
 * @returns {string}
 */
function hashKey(v) {
  if (v === null || v === undefined) return 'N';
  if (typeof v === 'boolean') return `D${v ? 1 : 0}`;
  if (v.isDecimal) return `D${v.normalize().pyStr()}`;
  if (typeof v === 'string') return `S${v}`;
  if (typeof v === 'number') return `I${v}`;
  return `${v.kind}${v.key()}`;
}

/**
 * agate.Table.join: the left table's rows with the matching rows of the right table appended, by key column, or
 * by row number when leftKey is null. The right key column is dropped unless fullOuter; a right column whose name
 * the left table has gets a "2" suffix.
 * @param {Table} left
 * @param {Table} right
 * @param {number|null} leftKey the left key column, or null to join on row numbers
 * @param {number|null} [rightKey] the right key column (leftKey by default)
 * @param {{inner?: boolean, fullOuter?: boolean}} [options] inner drops unmatched left rows; fullOuter also keeps
 *   unmatched right rows
 * @returns {Table}
 */
function join(left, right, leftKey, rightKey, { inner = false, fullOuter = false } = {}) {
  if (rightKey === undefined) rightKey = leftKey;
  let leftData;
  let rightData;
  let rightKeyIndices = [];
  if (leftKey === null) {
    leftData = left.rows.map((_, i) => `I${i}`);
    rightData = right.rows.map((_, i) => `I${i}`);
  } else {
    leftData = left.rows.map((r) => hashKey(r[leftKey]));
    rightData = right.rows.map((r) => hashKey(r[rightKey]));
    // agate finds the key column with _columns.index(column): the first column whose values all equal it
    const keyValues = rightData.join('\u0000');
    rightKeyIndices = [right.columnNames.findIndex((_, j) => right.rows.map((r) => hashKey(r[j])).join('\u0000') === keyValues)];
  }
  const names = [...left.columnNames];
  const types = [...left.columnTypes];
  right.columnNames.forEach((name, i) => {
    if (!fullOuter && rightKeyIndices.includes(i)) return;
    names.push(left.columnNames.includes(name) ? `${name}2` : name);
    types.push(right.columnTypes[i]);
  });
  const hash = new Map();
  rightData.forEach((v, i) => {
    if (!hash.has(v)) hash.set(v, []);
    hash.get(v).push(right.rows[i]);
  });
  const rows = [];
  leftData.forEach((lv, li) => {
    const m = hash.get(lv);
    if (m && m.length) {
      for (const rr of m) {
        const nr = [...left.rows[li]];
        rr.forEach((v, k) => { if (!(rightKeyIndices.includes(k) && !fullOuter)) nr.push(v); });
        rows.push(nr);
      }
    } else if (!inner) {
      const nr = [...left.rows[li]];
      right.columnNames.forEach((_, k) => { if (!(rightKeyIndices.includes(k) && !fullOuter)) nr.push(null); });
      rows.push(nr);
    }
  });
  if (fullOuter) {
    const ls = new Set(leftData);
    rightData.forEach((rv, ri) => {
      if (ls.has(rv)) return;
      rows.push([...left.columnNames.map(() => null), ...right.rows[ri]]);
    });
  }
  return Table.fromRows(rows, deduplicate(names), types);
}

/** csvjoin: an inner, left, right or full outer join of several CSV files on columns, or their rows side by side. */
class CSVJoin extends Utility {
  constructor() {
    super('csvjoin', 'Execute a SQL-like join to merge CSV files on a specified column or columns.',
      "Note that the join operation requires reading all files into memory. Don't try this on very large files.", ['f']);
  }

  /**
   * CSVJoin.add_arguments: the files, -c, --outer, --left, --right, -y and -I.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['FILE'], { metavar: 'FILE', nargs: '*', dest: 'input_paths', default: ['-'], help: 'The CSV files to operate on. If only one is specified, it will be copied to STDOUT.' });
    p.addArgument(['-c', '--columns'], { dest: 'columns', help: 'The column name(s) on which to join. Should be either one name (or index) or a comma-separated list with one name (or index) per file, in the same order in which the files were specified. If not specified, the two files will be joined sequentially without matching.' });
    p.addArgument(['--outer'], { dest: 'outer_join', action: 'store_true', help: 'Perform a full outer join, rather than the default inner join.' });
    p.addArgument(['--left'], { dest: 'left_join', action: 'store_true', help: 'Perform a left outer join, rather than the default inner join. If more than two files are provided this will be executed as a sequence of left outer joins, starting at the left.' });
    p.addArgument(['--right'], { dest: 'right_join', action: 'store_true', help: 'Perform a right outer join, rather than the default inner join. If more than two files are provided this will be executed as a sequence of right outer joins, starting at the right.' });
    addSniffAndInference(p);
  }

  /**
   * CSVJoin.main.
   * @returns {void}
   * @throws {ExitError} with status 2 for incompatible join options (through ArgumentParser.error)
   * @throws {ColumnIdentifierError} for a join column a file does not have
   * @throws {CastError} for a value its inferred type cannot cast
   */
  main() {
    const a = this.args;
    const paths = a.input_paths;
    if (stdinIsTTY() && paths.length === 1 && paths[0] === '-') this.argparser.error('You must provide an input file or piped data.');
    const files = paths.map((p) => this.openInputFile(p));
    let joinNames;
    if (a.columns) {
      joinNames = a.columns.split(',').map((s) => s.trim());
      if (joinNames.length === 1) joinNames = files.map(() => joinNames[0]);
      if (joinNames.length !== files.length) this.argparser.error('The number of join column names must match the number of files, or be a single column name that exists in all files.');
    }
    if ((a.left_join || a.right_join || a.outer_join) && !a.columns) this.argparser.error('You must provide join column names when performing an outer join.');
    if (a.left_join && a.right_join) this.argparser.error('It is not valid to specify both a left and a right join.');
    const sniff = a.sniff_limit !== -1 ? a.sniff_limit : null;
    const types = this.getColumnTypes();
    const tables = files.map((f) => this.tableFromCsv(f, { skipLines: a.skip_lines, sniffLimit: sniff, columnTypes: types, kwargs: this.reader_kwargs }));
    const ids = [];
    if (a.columns) tables.forEach((t, i) => ids.push(matchColumnIdentifier(t.columnNames, joinNames[i])));
    let jt = tables[0];
    if (a.left_join) {
      tables.slice(1).forEach((t, i) => { jt = join(jt, t, ids[0], ids[i + 1]); });
    } else if (a.right_join) {
      jt = tables[tables.length - 1];
      const rem = tables.slice(0, -1).reverse();
      rem.forEach((t, i) => { jt = join(jt, t, ids[ids.length - 1], ids[ids.length - 2 - i]); });
    } else if (a.outer_join) {
      tables.slice(1).forEach((t, i) => { jt = join(jt, t, ids[0], ids[i + 1], { fullOuter: true }); });
    } else if (a.columns) {
      tables.slice(1).forEach((t, i) => { jt = join(jt, t, ids[0], ids[i + 1], { inner: true }); });
    } else {
      tables.slice(1).forEach((t) => { jt = join(jt, t, null, null, { fullOuter: true }); });
    }
    jt.toCsv(this.out, this.writer_kwargs);
  }
}

new CSVJoin().launch();
