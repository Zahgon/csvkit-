'use strict';
// Port of csvkit 2.2.0 csvkit.cleanup (MIT): join_rows.

const { pyError } = require('./pyerrors');

/**
 * join_rows: the rows merged into a single row, the last cell of each row joined to the first cell of the next.
 * @param {string[][]} rows rows to merge
 * @param {string} separator the string with which to join the cells
 * @returns {string[]}
 * @throws {Error} pyName IndexError when the first row is empty
 */
function joinRows(rows, separator) {
  const fixed = [...rows[0]];
  for (let row of rows.slice(1)) {
    if (row.length === 0) row = [''];
    if (!fixed.length) throw pyError('IndexError', 'list index out of range');
    fixed[fixed.length - 1] = `${fixed[fixed.length - 1]}${separator}${row[0]}`;
    fixed.push(...row.slice(1));
  }
  return fixed;
}

module.exports = { joinRows };
