'use strict';
// A port of CPython 3.11's _csv module (reader, writer, dialect validation) and csv.Sniffer.

const pyunicode = require('./pyunicode');
const pyre = require('./pyre');
const { pyRepr } = require('./pystr');

const QUOTE_MINIMAL = 0;
const QUOTE_ALL = 1;
const QUOTE_NONNUMERIC = 2;
const QUOTE_NONE = 3;

/**
 * _csv.Error.
 */
class CsvError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.pyName = 'Error';
  }
}

/** The ValueError a QUOTE_NONNUMERIC reader raises for an unquoted field that is not a float. */
class ValueErr extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.pyName = 'ValueError';
  }
}

/**
 * The TypeError _csv raises for bad dialect parameters.
 */
class PyTypeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.pyName = 'TypeError';
  }
}

const limits = { fieldSizeLimit: 131072 };

/**
 * csv.field_size_limit([n]): the previous limit, setting a new one when n is given.
 * @param {number} [n]
 * @returns {number}
 */
function fieldSizeLimit(n) {
  const old = limits.fieldSizeLimit;
  if (n !== undefined) limits.fieldSizeLimit = n;
  return old;
}

function charOrNone(name, value, dflt) {
  if (value === undefined) return dflt;
  if (value === null) return null;
  if ([...value].length !== 1) throw new PyTypeError(`"${name}" must be a 1-character string`);
  return value;
}

/**
 * A validated dialect from a base dialect and keyword overrides, with the errors _csv raises for bad values.
 * @param {object} [opts] delimiter, quotechar, escapechar, doublequote, skipinitialspace, lineterminator, quoting,
 * strict and an optional base `dialect`
 * @returns {object}
 * @throws {Error} pyName TypeError for a delimiter, quotechar or escapechar that is not one character, a bad
 *   quoting value, or quoting without a quotechar
 */
function makeDialect(opts = {}) {
  const base = opts.dialect || {};
  const pick = (k, d) => (opts[k] !== undefined ? opts[k] : base[k] !== undefined ? base[k] : d);
  const d = {};
  const delimiter = pick('delimiter', ',');
  if (typeof delimiter !== 'string' || [...delimiter].length !== 1) {
    throw new PyTypeError('"delimiter" must be a 1-character string');
  }
  d.delimiter = delimiter;
  d.doublequote = pick('doublequote', true);
  d.escapechar = charOrNone('escapechar', pick('escapechar', null), null);
  d.lineterminator = pick('lineterminator', '\r\n');
  d.quotechar = charOrNone('quotechar', pick('quotechar', '"'), '"');
  // _csv: an explicit quotechar=None without a quoting argument means QUOTE_NONE
  d.quoting = pick('quoting', d.quotechar === null && pick('quotechar', '"') === null ? QUOTE_NONE : QUOTE_MINIMAL);
  if (![0, 1, 2, 3].includes(d.quoting)) throw new PyTypeError('bad "quoting" value');
  d.skipinitialspace = !!pick('skipinitialspace', false);
  d.strict = !!pick('strict', false);
  if (d.quotechar === null && d.quoting !== QUOTE_NONE) {
    throw new PyTypeError('quotechar must be set if quoting enabled');
  }
  return d;
}

const S = {
  START_RECORD: 0, START_FIELD: 1, ESCAPED_CHAR: 2, IN_FIELD: 3, IN_QUOTED_FIELD: 4,
  ESCAPE_IN_QUOTED_FIELD: 5, QUOTE_IN_QUOTED_FIELD: 6, EAT_CRNL: 7, AFTER_ESCAPED_CRNL: 8,
};
const EOL = -1;

/**
 * _csv.reader: an iterator of rows over an iterator of lines, with line_num.
 */
class Reader {
  /**
   * @param {Iterable<string>|Iterator<string>} lines the input lines, each normally ending with "\n"
   * @param {object} [opts] dialect options, see makeDialect()
   * @throws {Error} pyName TypeError for an invalid dialect option
   */
  constructor(lines, opts = {}) {
    this.dialect = makeDialect(opts);
    this.lines = lines[Symbol.iterator] ? lines[Symbol.iterator]() : lines;
    this.line_num = 0;
  }

  /** @returns {Reader} this iterator */
  [Symbol.iterator]() { return this; }

  /**
   * Iterator protocol over readRow().
   * @returns {{done: boolean, value: (Array|undefined)}}
   * @throws {CsvError} as readRow()
   */
  next() {
    const row = this.readRow();
    if (row === null) return { done: true, value: undefined };
    return { done: false, value: row };
  }

  /**
   * Reader.__next__: parses the next record, reading as many lines as a quoted field spans.
   * @returns {Array<string|ReaderFloat>|null} the fields, or null at end of input
   * @throws {CsvError} "unexpected end of data" in strict mode, "field larger than field limit", or a malformed
   *   quote or line ending
   * @throws {Error} pyName ValueError for an unquoted field QUOTE_NONNUMERIC cannot read as a float
   */
  readRow() {
    this.fields = [];
    this.field = [];
    this.fieldLen = 0;
    this.state = S.START_RECORD;
    this.numeric = false;
    do {
      const r = this.lines.next();
      if (r.done) {
        if (this.fieldLen !== 0 || this.state === S.IN_QUOTED_FIELD) {
          if (this.dialect.strict) throw new CsvError('unexpected end of data');
          this.saveField();
          break;
        }
        return null;
      }
      const line = r.value;
      this.line_num++;
      for (const c of line) this.processChar(c);
      this.processChar(EOL);
    } while (this.state !== S.START_RECORD);
    const f = this.fields;
    this.fields = null;
    return f;
  }

  /**
   * parse_add_char: appends a character to the current field.
   * @param {string} c
   * @returns {void}
   * @throws {CsvError} when the field passes csv.field_size_limit()
   */
  addChar(c) {
    if (this.fieldLen >= limits.fieldSizeLimit) {
      throw new CsvError(`field larger than field limit (${limits.fieldSizeLimit})`);
    }
    this.field.push(c);
    this.fieldLen++;
  }

  /**
   * parse_save_field: ends the current field (as a float for an unquoted QUOTE_NONNUMERIC field).
   * @returns {void}
   * @throws {Error} pyName ValueError for an unquoted QUOTE_NONNUMERIC field that is not a float
   */
  saveField() {
    let s = this.field.join('');
    this.field = [];
    this.fieldLen = 0;
    if (this.numeric) {
      this.numeric = false;
      const v = pyunicode.pyFloat(s);
      if (v === null) throw new ValueErr(`could not convert string to float: ${pyRepr(s)}`);
      s = new ReaderFloat(v);
    }
    this.fields.push(s);
  }

  /**
   * parse_process_char: one step of _csv's reader state machine.
   * @param {string|number} c a character, or EOL at the end of a line
   * @returns {void}
   * @throws {CsvError} for input the dialect does not allow
   */
  processChar(c) {
    const d = this.dialect;
    const isNL = c === '\n' || c === '\r';
    switch (this.state) {
      case S.START_RECORD:
        if (c === EOL) return;
        if (isNL) { this.state = S.EAT_CRNL; return; }
        this.state = S.START_FIELD;
      // fallthrough
      case S.START_FIELD:
        if (isNL || c === EOL) {
          this.saveField();
          this.state = c === EOL ? S.START_RECORD : S.EAT_CRNL;
        } else if (c === d.quotechar && d.quoting !== QUOTE_NONE) {
          this.state = S.IN_QUOTED_FIELD;
        } else if (c === d.escapechar) {
          this.state = S.ESCAPED_CHAR;
        } else if (c === ' ' && d.skipinitialspace) {
          // ignore
        } else if (c === d.delimiter) {
          this.saveField();
        } else {
          if (d.quoting === QUOTE_NONNUMERIC) this.numeric = true;
          this.addChar(c);
          this.state = S.IN_FIELD;
        }
        return;
      case S.ESCAPED_CHAR:
        if (isNL) { this.addChar(c); this.state = S.AFTER_ESCAPED_CRNL; return; }
        if (c === EOL) c = '\n';
        this.addChar(c);
        this.state = S.IN_FIELD;
        return;
      case S.AFTER_ESCAPED_CRNL:
        if (c === EOL) return;
      // fallthrough
      case S.IN_FIELD:
        if (c === '\n' || c === '\r' || c === EOL) {
          this.saveField();
          this.state = c === EOL ? S.START_RECORD : S.EAT_CRNL;
        } else if (c === d.escapechar) {
          this.state = S.ESCAPED_CHAR;
        } else if (c === d.delimiter) {
          this.saveField();
          this.state = S.START_FIELD;
        } else {
          this.addChar(c);
        }
        return;
      case S.IN_QUOTED_FIELD:
        if (c === EOL) {
          // nothing
        } else if (c === d.escapechar) {
          this.state = S.ESCAPE_IN_QUOTED_FIELD;
        } else if (c === d.quotechar && d.quoting !== QUOTE_NONE) {
          this.state = d.doublequote ? S.QUOTE_IN_QUOTED_FIELD : S.IN_FIELD;
        } else {
          this.addChar(c);
        }
        return;
      case S.ESCAPE_IN_QUOTED_FIELD:
        if (c === EOL) c = '\n';
        this.addChar(c);
        this.state = S.IN_QUOTED_FIELD;
        return;
      case S.QUOTE_IN_QUOTED_FIELD:
        if (d.quoting !== QUOTE_NONE && c === d.quotechar) {
          this.addChar(c);
          this.state = S.IN_QUOTED_FIELD;
        } else if (c === d.delimiter) {
          this.saveField();
          this.state = S.START_FIELD;
        } else if (c === '\n' || c === '\r' || c === EOL) {
          this.saveField();
          this.state = c === EOL ? S.START_RECORD : S.EAT_CRNL;
        } else if (!d.strict) {
          this.addChar(c);
          this.state = S.IN_FIELD;
        } else {
          throw new CsvError(`'${d.delimiter}' expected after '${d.quotechar}'`);
        }
        return;
      case S.EAT_CRNL:
        if (isNL) return;
        if (c === EOL) { this.state = S.START_RECORD; return; }
        throw new CsvError("new-line character seen in unquoted field - do you need to open the file with newline=''?");
      default:
    }
  }
}

/**
 * str() of a value as the csv writer prints it (None as the empty string).
 * @param {*} v
 * @returns {string}
 */
function pyStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (v.pyInt !== undefined) return String(v.pyInt);
  if (typeof v.pyStr === 'function') return v.pyStr();
  return String(v);
}

/**
 * repr() of a Python float: the shortest round-tripping digits, in exponent form below 1e-4 and from 1e16.
 * @param {number} x
 * @returns {string}
 */
function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mant, expStr] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const e = parseInt(expStr, 10);
  if (e >= -4 && e < 16) {
    let r;
    if (e >= 0) {
      const ip = digits.slice(0, e + 1).padEnd(e + 1, '0');
      const fp = digits.slice(e + 1);
      r = `${ip}.${fp || '0'}`;
    } else {
      r = `0.${'0'.repeat(-e - 1)}${digits}`;
    }
    return sign + r;
  }
  const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const es = Math.abs(e) < 10 ? `0${Math.abs(e)}` : `${Math.abs(e)}`;
  return `${sign}${m}e${e < 0 ? '-' : '+'}${es}`;
}

/** The float a QUOTE_NONNUMERIC reader makes of an unquoted field; written back as repr(float). */
class ReaderFloat {
  /** @param {number} value */
  constructor(value) { this.value = value; }

  /** @returns {string} repr(float) */
  pyStr() { return pyFloatRepr(this.value); }
}

function isPyNumber(v) {
  return typeof v === 'number' || typeof v === 'boolean' || v instanceof ReaderFloat || (v && v.isDecimal);
}

/**
 * _csv.writer: writerow() quotes and escapes fields by the dialect and writes them with its line terminator.
 */
class Writer {
  /**
   * @param {{write: function(string): void}} out
   * @param {object} [opts] dialect options, see makeDialect()
   * @throws {Error} pyName TypeError for an invalid dialect option or a lineterminator that is not a string
   */
  constructor(out, opts = {}) {
    this.out = out;
    this.dialect = makeDialect(opts);
    if (typeof this.dialect.lineterminator !== 'string') throw new PyTypeError('"lineterminator" must be a string');
  }

  /**
   * Writer.writerow: the fields quoted and escaped by the dialect, then the line terminator.
   * @param {Iterable<*>} row the fields; each is written as its str() (None as '')
   * @returns {void}
   * @throws {CsvError} "single empty field record must be quoted" under QUOTE_NONE, or from appendField()
   */
  writerow(row) {
    const d = this.dialect;
    const parts = [];
    let recLen = 0;
    const fields = [...row];
    for (const field of fields) {
      let quoted = false;
      if (d.quoting === QUOTE_NONNUMERIC) quoted = !isPyNumber(field);
      else if (d.quoting === QUOTE_ALL) quoted = true;
      const s = pyStr(field);
      parts.push(this.appendField(s, quoted, parts.length > 0));
      recLen += s.length;
    }
    if (fields.length > 0 && parts.join('').length === 0) {
      if (d.quoting === QUOTE_NONE) throw new CsvError('single empty field record must be quoted');
      parts[parts.length - 1] = this.appendField('', true, fields.length > 1);
    }
    this.out.write(parts.join('') + d.lineterminator);
  }

  /**
   * join_append_data: one field with its delimiter, escapes and quotes.
   * @param {string} s the field's text
   * @param {boolean} quoted whether the quoting mode already requires quotes
   * @param {boolean} needDelim whether a delimiter goes first
   * @returns {string}
   * @throws {CsvError} "need to escape, but no escapechar set"
   */
  appendField(s, quoted, needDelim) {
    const d = this.dialect;
    let buf = needDelim ? d.delimiter : '';
    let body = '';
    for (const c of s) {
      let wantEscape = false;
      if (c === d.delimiter || c === d.escapechar || c === d.quotechar || d.lineterminator.includes(c)) {
        if (d.quoting === QUOTE_NONE) {
          wantEscape = true;
        } else {
          if (c === d.quotechar) {
            if (d.doublequote) body += d.quotechar;
            else wantEscape = true;
          } else if (c === d.escapechar) {
            wantEscape = true;
          }
          if (!wantEscape) quoted = true;
        }
        if (wantEscape) {
          if (d.escapechar === null) throw new CsvError('need to escape, but no escapechar set');
          body += d.escapechar;
        }
      }
      body += c;
    }
    if (quoted) body = d.quotechar + body + d.quotechar;
    return buf + body;
  }

  /**
   * @param {Iterable<Iterable<*>>} rows
   * @returns {void}
   * @throws {CsvError} as writerow()
   */
  writerows(rows) {
    for (const r of rows) this.writerow(r);
  }
}

// csv.Sniffer
function countOf(s, sub) {
  if (sub.length === 0) return s.length + 1;
  let n = 0;
  let i = 0;
  for (;;) {
    const j = s.indexOf(sub, i);
    if (j < 0) return n;
    n++;
    i = j + sub.length;
  }
}

const NO_WARNINGS = { warn: () => {} };

// csv.Sniffer._guess_quote_and_delimiter, with its regular expressions run by the port of Python's re.
function guessQuoteAndDelimiter(data, delimiters) {
  const body = String.raw`(?:(?P=quote){2}|(?!(?P=quote)).)*+`;
  const patterns = [
    String.raw`(?P<delim>[^\w\n"\'])(?P<space> ?)(?P<quote>["\'])${body}(?P=quote)(?P=delim)`,
    String.raw`(?:^|\n)(?P<quote>["\'])${body}(?P=quote)(?P<delim>[^\w\n"\'])(?P<space> ?)`,
    String.raw`(?P<delim>[^\w\n"\'])(?P<space> ?)(?P<quote>["\'])${body}(?P=quote)(?:$|\n)`,
    String.raw`(?:^|\n)(?P<quote>["\'])${body}(?P=quote)(?:$|\n)`,
  ];
  let matches = [];
  let groupindex = null;
  for (const pattern of patterns) {
    const regexp = pyre.compile(pattern, NO_WARNINGS, pyre.FLAG.DOTALL | pyre.FLAG.MULTILINE);
    matches = regexp.finditer(data);
    groupindex = regexp.groupindex;
    if (matches.length) break;
  }
  if (!matches.length) return ['', false, null, 0];
  const quotes = new Map();
  const delims = new Map();
  let spaces = 0;
  for (const m of matches) {
    const quote = m[groupindex.get('quote')] || '';
    if (quote) quotes.set(quote, (quotes.get(quote) || 0) + 1);
    if (!groupindex.has('delim')) continue;
    const key = m[groupindex.get('delim')] || '';
    if (key && (delimiters == null || delimiters.includes(key))) delims.set(key, (delims.get(key) || 0) + 1);
    if (!groupindex.has('space')) continue;
    if (m[groupindex.get('space')]) spaces++;
  }
  const maxKey = (m) => {
    let best;
    let bv = -Infinity;
    for (const [k, v] of m) if (v > bv) { bv = v; best = k; }
    return best;
  };
  const quotechar = maxKey(quotes);
  let delim;
  let skipinitialspace;
  if (delims.size) {
    delim = maxKey(delims);
    skipinitialspace = delims.get(delim) === spaces;
    if (delim === '\n') delim = '';
  } else {
    delim = '';
    skipinitialspace = 0;
  }
  let doublequote = false;
  if (delim) {
    const d = pyre.escape(delim);
    const space = delim !== ' ' ? ' *+' : '';
    const dq = pyre.compile(
      `(?:(?<=${d})|^)${space}${quotechar}((?:${quotechar}${quotechar}|[^${quotechar}]++)*+)${quotechar}(?:${d}|$)`,
      NO_WARNINGS, pyre.FLAG.MULTILINE,
    );
    doublequote = dq.finditer(data).some((m) => m[1].includes(quotechar + quotechar));
  }
  return [quotechar, doublequote, delim, skipinitialspace];
}

function guessDelimiter(sample, delimiters) {
  const data = sample.split('\n').filter((x) => x);
  const ascii = [];
  for (let c = 0; c < 127; c++) ascii.push(String.fromCharCode(c));
  const chunkLength = Math.min(10, data.length);
  let iteration = 0;
  const charFrequency = new Map();
  const modes = new Map();
  const delims = new Map();
  let start = 0;
  let end = chunkLength;
  const dataFirstCount = (d) => countOf(data[0], d) === countOf(data[0], d + ' ');
  while (start < data.length) {
    iteration++;
    for (const line of data.slice(start, end)) {
      const counts = new Map();
      for (const ch of line) counts.set(ch, (counts.get(ch) || 0) + 1);
      for (const ch of ascii) {
        const meta = charFrequency.get(ch) || new Map();
        const freq = counts.get(ch) || 0;
        meta.set(freq, (meta.get(freq) || 0) + 1);
        charFrequency.set(ch, meta);
      }
    }
    for (const [ch, meta] of charFrequency) {
      const items = [...meta.entries()];
      if (items.length === 1 && items[0][0] === 0) continue;
      if (items.length > 1) {
        let best = items[0];
        for (const it of items) if (it[1] > best[1]) best = it;
        const idx = items.indexOf(best);
        items.splice(idx, 1);
        modes.set(ch, [best[0], best[1] - items.reduce((a, it) => a + it[1], 0)]);
      } else {
        modes.set(ch, items[0]);
      }
    }
    const total = Math.min(chunkLength * iteration, data.length);
    let consistency = 1.0;
    const threshold = 0.9;
    while (delims.size === 0 && consistency >= threshold) {
      for (const [k, v] of modes) {
        if (v[0] > 0 && v[1] > 0) {
          if (v[1] / total >= consistency && (delimiters == null || delimiters.includes(k))) delims.set(k, v);
        }
      }
      consistency -= 0.01;
    }
    if (delims.size === 1) {
      const delim = [...delims.keys()][0];
      return [delim, dataFirstCount(delim)];
    }
    start = end;
    end += chunkLength;
  }
  if (!delims.size) return ['', 0];
  if (delims.size > 1) {
    for (const d of [',', '\t', ';', ' ', ':']) {
      if (delims.has(d)) return [d, dataFirstCount(d)];
    }
  }
  const items = [...delims.entries()].map(([k, v]) => [v, k]);
  items.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const delim = items[items.length - 1][1];
  return [delim, dataFirstCount(delim)];
}

/**
 * csv.Sniffer().sniff(sample, delimiters): the dialect deduced from a sample, raising "Could not determine
 * delimiter" when none fits.
 * @param {string} sample
 * @param {string|null} [delimiters] the characters a delimiter may be
 * @returns {object} the dialect options: lineterminator, quoting, doublequote, delimiter, quotechar, skipinitialspace
 * @throws {CsvError} "Could not determine delimiter"
 */
function sniff(sample, delimiters) {
  sample = sample.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let [quotechar, doublequote, delimiter, skipinitialspace] = guessQuoteAndDelimiter(sample, delimiters);
  if (!delimiter) [delimiter, skipinitialspace] = guessDelimiter(sample, delimiters);
  if (!delimiter) throw new CsvError('Could not determine delimiter');
  return {
    lineterminator: '\r\n',
    quoting: QUOTE_MINIMAL,
    doublequote,
    delimiter,
    quotechar: quotechar || '"',
    skipinitialspace: !!skipinitialspace,
  };
}

module.exports = { QUOTE_NONNUMERIC, QUOTE_NONE, CsvError, Reader, Writer, sniff, fieldSizeLimit, pyStr, pyFloatRepr };
