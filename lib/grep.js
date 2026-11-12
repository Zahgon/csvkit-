'use strict';
// Port of csvkit 2.2.0 csvkit.grep (MIT): FilteringCSVReader and its pattern standardization.

const { pyError } = require('./pyerrors');
const { ColumnIdentifierError } = require('./cli');

/**
 * pattern_as_function: a test for a cell value. A function is used as is, a compiled pattern (lib/pyre, an object
 * with search()) tests with search(), and a string tests for a substring.
 * @param {Function|{search: Function}|string} obj pattern
 * @returns {function(string): *}
 */
function patternAsFunction(obj) {
  if (typeof obj === 'function') return obj;
  if (obj && typeof obj.search === 'function' && typeof obj !== 'string') return (arg) => obj.search(arg);
  return (x) => x.includes(obj);
}

/** Python truthiness of a pattern value: empty strings and null are skipped. */
function truthy(v) {
  return v !== null && v !== undefined && v !== '';
}

/**
 * standardize_patterns: a Map from column index to test. A Map of patterns may be keyed by column index or, when
 * the reader has a header, by column name; an array of patterns applies to the columns in order.
 * @param {string[]|null} columnNames header row, or null
 * @param {Map<number|string, *>|Array} patterns patterns
 * @returns {Map<number|string, Function>}
 * @throws {ColumnIdentifierError} when a pattern keyed by name falls on a column index that already has one
 */
function standardizePatterns(columnNames, patterns) {
  if (!(patterns instanceof Map)) return new Map(patterns.map((x, i) => [i, patternAsFunction(x)]));
  const tests = new Map();
  for (const [k, v] of patterns) {
    if (truthy(v)) tests.set(k, patternAsFunction(v));
  }
  if (!columnNames || !columnNames.length) return tests;
  const p2 = new Map();
  for (const [k, test] of tests) {
    if (columnNames.includes(k)) {
      const idx = columnNames.indexOf(k);
      if (tests.has(idx)) throw new ColumnIdentifierError(`Column ${k} has index ${idx} which already has a pattern.`);
      p2.set(idx, test);
    } else {
      p2.set(k, test);
    }
  }
  return p2;
}

/**
 * FilteringCSVReader: yields the rows of a row iterator that pass the pattern tests (all of them, or any of them
 * with anyMatch; the opposite with inverse). With header, the first row is the column names and is yielded
 * untested.
 */
class FilteringCSVReader {
  /**
   * @param {Iterable<string[]>} reader rows
   * @param {Map<number|string, *>|Array} patterns patterns (see standardizePatterns)
   * @param {{header?: boolean, anyMatch?: boolean, inverse?: boolean}} [options] options
   * @throws {Error} pyName StopIteration with header for an input without rows, and ColumnIdentifierError from
   *   standardizePatterns()
   */
  constructor(reader, patterns, { header = true, anyMatch = false, inverse = false } = {}) {
    this.reader = reader[Symbol.iterator]();
    this.header = header;
    this.columnNames = null;
    this.returnedHeader = false;

    if (this.header) {
      const first = this.reader.next();
      if (first.done) {
        throw pyError('StopIteration', '');
      }
      this.columnNames = first.value;
    }

    this.anyMatch = anyMatch;
    this.inverse = inverse;
    this.patterns = standardizePatterns(this.columnNames, patterns);
  }

  /** @returns {FilteringCSVReader} this iterator */
  [Symbol.iterator]() {
    return this;
  }

  /**
   * The header row first (when there is one), then the next row that passes the tests.
   * @returns {{done: boolean, value: (string[]|undefined)}}
   */
  next() {
    if (this.columnNames && this.columnNames.length && !this.returnedHeader) {
      this.returnedHeader = true;
      return { done: false, value: this.columnNames };
    }

    for (;;) {
      const r = this.reader.next();
      if (r.done) return r;
      if (this.testRow(r.value)) return r;
    }
  }

  /**
   * Whether a row passes the tests.
   * @param {string[]} row row
   * @returns {boolean}
   */
  testRow(row) {
    for (const [idx, test] of this.patterns) {
      const value = Number.isInteger(idx) && idx >= -row.length && idx < row.length ? row.at(idx) : '';
      const result = test(value);
      if (this.anyMatch) {
        if (result) return !this.inverse;
      } else if (!result) {
        return this.inverse;
      }
    }

    if (this.anyMatch) return this.inverse;
    return !this.inverse;
  }
}

module.exports = { FilteringCSVReader, standardizePatterns, patternAsFunction };
