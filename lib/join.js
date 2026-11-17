'use strict';
// Port of agate.Table.join (agate 1.14.2, MIT), the join csvjoin applies to each pair of tables.

const { Table, deduplicate } = require('./table');

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

module.exports = { join };
