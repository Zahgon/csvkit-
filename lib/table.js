'use strict';
// agate.Table: construction from CSV with type inference, ordering, joins and CSV output.

const pycsv = require('./pycsv');
const { Decimal } = require('./decimal');
const T = require('./types');
const { SITE_PACKAGES, warn } = require('./warnings');
const { pyError } = require('./pyerrors');


/**
 * agate.utils.letter_name: "a" to "z", then "aa" to "zz", and so on.
 * @param {number} i zero-based index
 * @returns {string}
 */
function letterName(i) {
  return String.fromCharCode(97 + (i % 26)).repeat(Math.floor(i / 26) + 1);
}

// Python truthiness of a value a csv reader can produce (str, None, or a QUOTE_NONNUMERIC float).
function pyTruthy(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'object' && typeof value.value === 'number') return value.value !== 0;
  return true;
}

/**
 * agate.utils.deduplicate for column names: unnamed columns get letter names and repeated names a "_2"
 * style suffix, each with agate's warning.
 * @param {Array<string|null>} values
 * @returns {string[]}
 * @throws {Error} pyName ValueError for a name that is neither a string nor empty
 */
function deduplicate(values) {
  const out = [];
  values.forEach((value, i) => {
    let nv;
    if (!pyTruthy(value)) {
      nv = letterName(i);
      warn(`${SITE_PACKAGES}/agate/utils.py`, 272, 'UnnamedColumnWarning', `Column ${i} has no name. Using "${nv}".`,
        '  warn_unnamed_column(i, new_value)');
    } else if (typeof value === 'string') {
      nv = value;
    } else {
      throw pyError('ValueError', 'Column names must be strings or None.');
    }
    let fv = nv;
    let dups = 0;
    while (out.includes(fv)) {
      fv = `${nv}_${dups + 2}`;
      dups++;
    }
    if (dups > 0) {
      warn(`${SITE_PACKAGES}/agate/utils.py`, 288, 'DuplicateColumnWarning',
        `Column name "${nv}" already exists in Table. Column will be renamed to "${fv}".`,
        '  warn_duplicate_column(new_value, final_value)');
    }
    out.push(fv);
  });
  return out;
}

// Marks an array of column names as the tuple agate keeps them in (its repr differs from a list's).
function asTuple(names) {
  Object.defineProperty(names, 'pyTuple', { value: true });
  return names;
}

/**
 * agate.TypeTester: infers each column's type as the first of the candidate types that can cast every value.
 */
class TypeTester {
  /** @param {Array<object>} types the candidate data types, in order of preference */
  constructor(types) { this.types = types; }
  /**
   * TypeTester.run: drops from each column's candidates every type whose test() fails on one of its values.
   * @param {Array<Array>} rows the uncast rows
   * @param {string[]} columnNames
   * @returns {Array<object>} one data type per column: the first surviving candidate, else the last type
   * @throws {Error} whatever a type's test() raises other than CastError
   */
  run(rows, columnNames) {
    const n = columnNames.length;
    const hyp = [];
    for (let i = 0; i < n; i++) hyp.push([...this.types]);
    for (const row of rows) {
      for (let i = 0; i < n; i++) {
        const h = hyp[i];
        if (h.length === 1) continue;
        for (const t of [...h]) {
          if (row.length > i && !t.test(row[i])) h.splice(h.indexOf(t), 1);
        }
      }
    }
    return hyp.map((h) => {
      for (const t of this.types) if (h.includes(t)) return t;
      return this.types[this.types.length - 1];
    });
  }
}

// agate.Table's warning when it names the columns itself; stacklevel=2 reports it at the caller ([file, line, source],
// agate/table/__init__.py:90 by default).
function warnDefaultNames(names, caller) {
  const [file, line, source] = caller || [`${SITE_PACKAGES}/agate/table/__init__.py`, 90,
    "  warnings.warn('Column names not specified. \"%s\" will be used as names.' % str(self._column_names),"];
  const tuple = `(${names.map((c) => `'${c}'`).join(', ')}${names.length === 1 ? ',' : ''})`;
  warn(file, line, 'RuntimeWarning', `Column names not specified. "${tuple}" will be used as names.`, source);
}

/**
 * agate.Table: column names, column types and rows of cast values.
 */
class Table {
  /**
   * agate.Table.__init__: deduplicates the column names (or names the columns "a", "b", ... with agate's warning)
   * and casts every value with its column type.
   * @param {Iterable<Array>} rows
   * @param {Array<string|null>|null} columnNames
   * @param {TypeTester|Array<object>} columnTypes a tester to infer the types, or one type per column
   * @param {{cast?: boolean, noHeaderWarning?: boolean, caller?: Array}} [opts] cast: false keeps the rows as
   *   given; noHeaderWarning skips the default-names warning; caller is the [file, line, source] that warning names
   * @throws {Error} pyName ValueError for a row longer than the header or a column name that is not a string
   * @throws {CastError} for a value its column type cannot cast, naming the row and column
   */
  constructor(rows, columnNames, columnTypes, opts = {}) {
    rows = [...rows];
    if (columnNames && columnNames.length) {
      this.columnNames = deduplicate(columnNames);
    } else if (rows.length) {
      this.columnNames = rows[0].map((_, i) => letterName(i));
      if (!opts.noHeaderWarning) warnDefaultNames(this.columnNames, opts.caller);
    } else {
      this.columnNames = [];
    }
    asTuple(this.columnNames);
    const n = this.columnNames.length;
    if (columnTypes instanceof TypeTester) this.columnTypes = columnTypes.run(rows, this.columnNames);
    else this.columnTypes = columnTypes;
    if (opts.cast === false) {
      this.rows = rows;
      return;
    }
    this.rows = rows.map((row, i) => {
      if (row.length > n) {
        throw pyError('ValueError', `Row ${i} has ${row.length} values, but Table only has ${n} columns.`);
      }
      const out = [];
      for (let j = 0; j < n; j++) {
        const v = j < row.length ? row[j] : null;
        try {
          out.push(this.columnTypes[j].cast(v));
        } catch (err) {
          if (err instanceof T.CastError) {
            throw new T.CastError(`${err.message} Error at row ${i} column ${this.columnNames[j]}.`);
          }
          throw err;
        }
      }
      return out;
    });
  }

  /**
   * A table over rows that are already cast, as Table._fork builds one.
   * @param {Array<Array>} rows
   * @param {string[]} names
   * @param {Array<object>} types
   * @returns {Table}
   */
  static fromRows(rows, names, types) {
    const t = Object.create(Table.prototype);
    t.rows = rows;
    t.columnNames = asTuple([...names]);
    t.columnTypes = types;
    return t;
  }

  /** @returns {Array<Array>} the rows as agate's to_csv hands them to the writer (see csvify) */
  csvRows() {
    return this.rows.map((r) => r.map((v, j) => csvify(v, this.columnTypes[j])));
  }

  /**
   * Table.to_csv: the header row and every row.
   * @param {{write: function(string): void}} out
   * @param {object} [writerOpts] csv writer options plus lineNumbers
   * @returns {void}
   */
  toCsv(out, writerOpts = {}) {
    const w = new LineWriter(out, writerOpts);
    w.writerow(this.columnNames);
    for (const r of this.csvRows()) w.writerow(r);
  }

  /**
   * Table.order_by: a stable sort by the key tuples keyFn gives.
   * @param {function(Array): Array} keyFn the sort key of a row
   * @param {boolean} reverse
   * @returns {Table} a new table over the same rows
   */
  orderBy(keyFn, reverse) {
    const idx = this.rows.map((r, i) => i);
    const keys = this.rows.map(keyFn);
    idx.sort((a, b) => {
      const c = compareKeys(keys[a], keys[b]);
      return reverse ? -c : c;
    });
    // Table._fork: a table without column names names them again from its first row
    if (!this.columnNames.length && this.rows.length) {
      warnDefaultNames([], [`${SITE_PACKAGES}/agate/table/__init__.py`, 278,
        '  return Table(rows, column_names, column_types, row_names=row_names, _is_fork=True)']);
    }
    return Table.fromRows(idx.map((i) => this.rows[i]), this.columnNames, this.columnTypes);
  }
}

// agate.NullOrder sorts after everything; tuples compare element-wise.
const NULL_ORDER = { nullOrder: true };

/**
 * Python's < ordering of two cell values of one column, with agate.NullOrder after everything.
 * @param {*} a
 * @param {*} b
 * @returns {number} negative, zero or positive
 */
function compareValues(a, b) {
  if (a === b) return 0;
  if (a && a.nullOrder) return b && b.nullOrder ? 0 : 1;
  if (b && b.nullOrder) return -1;
  if (typeof a === 'string' && typeof b === 'string') {
    // code point order
    const aa = [...a];
    const bb = [...b];
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
      const x = aa[i].codePointAt(0);
      const y = bb[i].codePointAt(0);
      if (x !== y) return x < y ? -1 : 1;
    }
    return aa.length - bb.length < 0 ? -1 : aa.length > bb.length ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  if (a && a.isDecimal && b && b.isDecimal) return a.cmp(b);
  if (a && a.key && b && b.key) {
    const x = a.key();
    const y = b.key();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return 0;
}

/**
 * Python's ordering of two tuples of cell values.
 * @param {Array} a
 * @param {Array} b
 * @returns {number}
 */
function compareKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareValues(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

/**
 * A cell value as agate's CSV writer receives it: numbers stay numbers, other values become their str().
 * @param {*} v
 * @param {object} type the column's agate type
 * @returns {*}
 */
function csvify(v, type) {
  if (v === null || v === undefined) return null;
  if (type instanceof T.NumberType) return v;
  return pycsv.pyStr(v);
}

/**
 * agate.csv.writer: a csv writer with "\n" line endings, an optional line_number column, and carriage
 * returns inside fields written as newlines.
 */
class LineWriter {
  /**
   * @param {{write: function(string): void}} out
   * @param {object} [opts] csv writer options plus lineNumbers
   * @throws {Error} pyName TypeError for an invalid dialect option
   */
  constructor(out, opts = {}) {
    const o = { ...opts };
    this.lineNumbers = !!o.lineNumbers;
    delete o.lineNumbers;
    if (o.lineterminator === undefined) o.lineterminator = '\n';
    this.w = new pycsv.Writer(out, o);
    this.rowCount = 0;
  }
  /**
   * @param {Array} row
   * @returns {void}
   * @throws {Error} pyName _csv.Error when the dialect cannot write a field (e.g. QUOTE_NONE without escapechar)
   */
  writerow(row) {
    row = [...row];
    if (this.lineNumbers) {
      row.unshift(this.rowCount === 0 ? 'line_number' : this.rowCount);
      this.rowCount++;
    }
    row = row.map((v) => (typeof v === 'string' ? v.replace(/\r/g, '\n') : v));
    this.w.writerow(row);
  }
  /**
   * @param {Iterable<Array>} rows
   * @returns {void}
   * @throws {Error} as writerow()
   */
  writerows(rows) { for (const r of rows) this.writerow(r); }
}

/**
 * The error agate.csv.reader raises for a csv.Error: FieldSizeLimitError for an oversized field, else the same.
 * @param {Error} e the error the csv reader raised
 * @param {number} lineNum the reader's line_num
 * @returns {Error} the error to raise
 */
function agateCsvError(e, lineNum) {
  if (!(e instanceof pycsv.CsvError && e.message.includes('field larger than field limit'))) return e;
  return pyError('agate.exceptions.FieldSizeLimitError', `CSV contains a field longer than the maximum length of ${pycsv.fieldSizeLimit()} characters on line ${lineNum}. Try raising the maximum with the field_size_limit parameter, or try setting quoting=csv.QUOTE_NONE.`);
}

/**
 * agate.csv.reader: csv rows, with a line_number column first when lineNumbers is set.
 * @param {Iterable<string>} lines
 * @param {object} [opts] csv dialect options plus lineNumbers and header
 * @yields {Array}
 * @throws {Error} pyName _csv.Error for malformed CSV, agate.exceptions.FieldSizeLimitError for an oversized field
 */
function* agateReader(lines, opts = {}) {
  const o = { ...opts };
  const lineNumbers = o.lineNumbers;
  const header = o.header === undefined ? true : o.header;
  delete o.lineNumbers;
  delete o.header;
  const r = new pycsv.Reader(lines, o);
  for (;;) {
    let row;
    try {
      row = r.readRow();
    } catch (e) {
      throw agateCsvError(e, r.line_num);
    }
    if (row === null) return;
    if (lineNumbers) {
      if (header && r.line_num === 1) row.unshift('line_numbers');
      else row.unshift(String(header ? r.line_num - 1 : r.line_num));
    }
    yield row;
  }
}

/**
 * agate.utils.max_precision: the most decimal places of any finite value, capped so whole and decimal places fit
 * the 28-digit context.
 * @param {Array<import('./decimal').Decimal|null>} values
 * @returns {number}
 */
function maxPrecision(values) {
  let maxWhole = 1;
  let maxDec = 0;
  for (const v of values) {
    // math.isnan / math.isinf go through float(), so a value too large for a float counts as infinite.
    if (v === null || !Number.isFinite(v.toNumber())) continue;
    const n = v.normalize();
    const expPlaces = -n.exp;
    const whole = n.digits.length - expPlaces;
    if (whole > maxWhole) maxWhole = whole;
    if (expPlaces > maxDec) maxDec = expPlaces;
  }
  if (maxWhole + maxDec > 28) maxDec = 28 - maxWhole;
  return maxDec;
}

module.exports = {
  Table, TypeTester, letterName, deduplicate, LineWriter, agateReader, agateCsvError, NULL_ORDER, maxPrecision,
  Decimal,
};
