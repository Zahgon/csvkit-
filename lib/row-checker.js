'use strict';
// Port of csvkit 2.2.0 csvkit.cleanup.RowChecker (MIT): the checks and fixes of csvclean.

const { joinRows } = require('./cleanup');
const { pyError } = require('./pyerrors');
const { pyRepr } = require('./pystr');
const { split } = require('./pyunicode');

/**
 * list.remove() on csvkit's Error dataclass: removes the first error equal by line number, row and message.
 * @param {{line: number, row: string[], msg: string}[]} errors the error list, changed in place
 * @param {{line: number, row: string[], msg: string}} error the error to remove
 * @returns {void}
 * @throws {Error} pyName ValueError when no error is equal
 */
function removeError(errors, error) {
  const same = (e) => e.line === error.line && e.msg === error.msg && e.row.length === error.row.length
    && e.row.every((v, i) => v === error.row[i]);
  const index = errors.findIndex(same);
  if (index < 0) throw pyError('ValueError', 'list.remove(x): x not in list');
  errors.splice(index, 1);
}

/**
 * RowChecker: reads the header row of a CSV reader, then yields its data rows with the enabled fixes applied, and
 * collects the errors found (rows whose length differs from the header, and columns empty in every row).
 */
class RowChecker {
  /**
   * RowChecker.__init__: reads the header row, with --header-normalize-space applied.
   * @param {{readRow: function(): (string[]|null), line_num: number}} reader the agate CSV reader
   * @param {object} opts the checks and fixes
   * @param {boolean} opts.lengthMismatch report rows whose length differs from the header
   * @param {boolean} opts.emptyColumns report columns that are empty in every row
   * @param {boolean} opts.omitErrorRows leave rows whose length differs from the header out of the output
   * @param {boolean} opts.headerNormalizeSpace collapse runs of whitespace in the header and strip it
   * @param {boolean} opts.joinShortRows merge consecutive short rows into one row
   * @param {string} opts.separator the string with which to join short rows
   * @param {boolean} opts.fillShortRows fill short rows with opts.fillvalue
   * @param {(string|null)} opts.fillvalue the value of the missing cells of a filled row
   * @param {boolean} opts.zeroBased number columns from 0 in the empty-columns message
   * @throws {Error} the reader's errors
   */
  constructor(reader, opts) {
    this.reader = reader;
    this.opts = opts;
    let names = reader.readRow();
    if (names === null) names = [];
    else if (opts.headerNormalizeSpace) names = names.map((n) => split(n).join(' '));
    this.columnNames = names;
    this.errors = [];
  }

  /**
   * RowChecker.checked_rows: the data rows, fixed, without the error rows when they are omitted. Errors are added to
   * this.errors as the rows are read, and the empty-columns error once the input is exhausted.
   * @returns {Generator<string[]>}
   * @throws {Error} the reader's errors, and pyName IndexError from joining a short row that is empty
   */
  * checkedRows() {
    const o = this.opts;
    const names = this.columnNames;
    const n = names.length;
    let joinable = [];
    let rowCount = 0;
    const emptyCounts = names.map(() => 0);
    for (;;) {
      let row = this.reader.readRow();
      if (row === null) break;
      const lineNumber = this.reader.line_num - 1;
      rowCount++;
      const lengthError = { line: lineNumber, row, msg: `Expected ${n} columns, found ${row.length} columns` };
      if (o.fillShortRows) {
        if (row.length < n) row = row.concat(Array(n - row.length).fill(o.fillvalue));
      } else if (o.joinShortRows) {
        if (row.length >= n) joinable = [];
        else {
          joinable.push(lengthError);
          if (joinable.length > 1) {
            while (joinable.length) {
              const fixed = joinRows(joinable.map((e) => e.row), o.separator);
              if (fixed.length < n) break;
              if (fixed.length === n) {
                row = fixed;
                if (o.lengthMismatch) for (const f of joinable) removeError(this.errors, f);
                joinable = [];
                break;
              }
              joinable = joinable.slice(1);
            }
          }
        }
      }
      if (o.lengthMismatch && row.length !== n) this.errors.push(lengthError);
      if (o.emptyColumns) for (let i = 0; i < n; i++) if (i >= row.length || row[i] === '') emptyCounts[i]++;
      if (!o.omitErrorRows || row.length === n) yield row;
    }
    if (rowCount) {
      const empty = [];
      emptyCounts.forEach((c, i) => { if (c === rowCount) empty.push(i); });
      if (empty.length) {
        const off = o.zeroBased ? 0 : 1;
        this.errors.push({ line: 1, row: names.map(() => ''), msg: `Empty columns named ${empty.map((i) => pyRepr(names[i])).join(', ')}! Try: csvcut -C ${empty.map((i) => i + off).join(',')}` });
      }
    }
  }
}

module.exports = { RowChecker };
