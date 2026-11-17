'use strict';
// Port of agate.csv_py3 (agate, MIT): DictReader and DictWriter, the Map-row reader and writer of csvstack.

const { pyError } = require('./pyerrors');
const { pyRepr } = require('./pystr');
const pycsv = require('./pycsv');

/**
 * agate.csv.DictReader (csv.DictReader with restkey and restval None): the first row gives the field names and each
 * later non-empty row becomes a Map of field name to value, extra values under the key null and missing ones null.
 * It reads lazily, as an iterator, like the original.
 */
class DictReader {
  /**
   * @param {Iterable<string>} lines the input lines
   * @param {object} opts csv.reader keywords
   * @throws {Error} pyName TypeError for a keyword csv.reader does not take (csvkit passes header=False for -H)
   */
  constructor(lines, opts) {
    if ('header' in opts) throw pyError('TypeError', "'header' is an invalid keyword argument for this function");
    this.reader = new pycsv.Reader(lines, opts);
    this.restkey = null;
    this.restval = null;
    this.names = undefined;
  }

  /** @returns {string[]|null} the field names, read from the first row on first use (null for empty input) */
  get fieldnames() {
    if (this.names === undefined) this.names = this.reader.readRow();
    return this.names;
  }

  /** @returns {number} the number of lines read */
  get line_num() { return this.reader.line_num; }

  /** @returns {DictReader} this iterator */
  [Symbol.iterator]() { return this; }

  /**
   * DictReader.__next__: the next non-empty row as a Map.
   * @returns {{done: boolean, value: (Map|undefined)}}
   * @throws {Error} pyName _csv.Error for malformed CSV
   */
  next() {
    const names = this.fieldnames;
    let row = this.reader.readRow();
    while (row !== null && row.length === 0) row = this.reader.readRow();
    if (row === null) return { done: true, value: undefined };
    const d = new Map();
    names.forEach((n, i) => d.set(n, i < row.length ? row[i] : this.restval));
    if (row.length > names.length) d.set(this.restkey, row.slice(names.length));
    return { done: false, value: d };
  }
}

/**
 * agate.csv.DictWriter: writes Map rows in the order of its field names, with "\n" line ends. Carriage returns in
 * string values become newlines, so the writer quotes them, and with line numbers each row gets a "line_number" field
 * counted from 1.
 */
class DictWriter {
  /**
   * @param {{write: function(string): void}} out the output stream
   * @param {string[]} fieldnames the field names, in output order
   * @param {{lineNumbers: (boolean|undefined)}} opts lineNumbers adds the "line_number" field before the others
   */
  constructor(out, fieldnames, opts) {
    this.lineNumbers = Boolean(opts.lineNumbers);
    this.fieldnames = this.lineNumbers ? ['line_number', ...fieldnames] : fieldnames;
    this.rowCount = 1;
    this.writer = new pycsv.Writer(out, { lineterminator: '\n' });
  }

  /**
   * DictWriter.writeheader: the field names as a row.
   * @returns {void}
   */
  writeheader() {
    this.writer.writerow(this.fieldnames);
  }

  /**
   * DictWriter.writerow: one row, a missing field written as an empty cell.
   * @param {Map<(string|null), *>} row the row, by field name (null holds a reader's extra values)
   * @returns {void}
   * @throws {Error} pyName ValueError when the row has a field the field names do not include
   */
  writerow(row) {
    for (const [k, v] of row) if (typeof v === 'string') row.set(k, v.replace(/\r/g, '\n'));
    if (this.lineNumbers) {
      row.set('line_number', this.rowCount);
      this.rowCount++;
    }
    const extra = [...row.keys()].filter((k) => !this.fieldnames.includes(k));
    if (extra.length) {
      throw pyError('ValueError', `dict contains fields not in fieldnames: ${extra.map((k) => (k === null ? 'None' : pyRepr(k))).join(', ')}`);
    }
    this.writer.writerow(this.fieldnames.map((h) => (row.has(h) ? row.get(h) : '')));
  }
}

module.exports = { DictReader, DictWriter };
