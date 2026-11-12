'use strict';
// Port of Python's JSON encoder (CPython 3.11 Lib/json/encoder.py: json.dump and json.dumps with indent,
// separators, ensure_ascii and default). Python values are modelled as: null, booleans, strings, numbers (float),
// {pyInt} or bigint (int), PyFloat (float), arrays (list) and Maps (dict, in insertion order).

const { pyError } = require('./pyerrors');
const { pyFloatRepr } = require('./pycsv');

/**
 * A Python float that keeps its float printing ("102.0") through csv and json output.
 */
class PyFloat {
  /** @param {number} value */
  constructor(value) { this.value = value; this.isPyFloat = true; }

  /** @returns {string} repr(float) */
  pyStr() { return pyFloatRepr(this.value); }
}

/**
 * An int value for the encoder (printed without a decimal point).
 * @param {bigint|number} n
 * @returns {{pyInt: (bigint|number)}}
 */
function pyIntValue(n) { return { pyInt: n }; }

const ESCAPES = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

const hex4 = (n) => `\\u${n.toString(16).padStart(4, '0')}`;

/**
 * encode_basestring (ensureAscii false) or encode_basestring_ascii (ensureAscii true).
 * @param {string} s
 * @param {boolean} [ensureAscii]
 * @returns {string}
 */
function encodeString(s, ensureAscii = false) {
  const re = ensureAscii ? /[\\"]|[^ -~]/g : /[\x00-\x1f\\"]/g;
  return `"${s.replace(re, (ch) => ESCAPES[ch] || hex4(ch.charCodeAt(0)))}"`;
}

function floatStr(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  return pyFloatRepr(x);
}

// The encoding of a str, None, bool, int or float, or null for any other value.
function encodePrimitive(v, ensureAscii) {
  if (typeof v === 'string') return encodeString(v, ensureAscii);
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return floatStr(v);
  if (v.pyInt !== undefined) return String(v.pyInt);
  if (v.isPyFloat) return floatStr(v.value);
  return null;
}

function typeError(message) {
  return pyError('TypeError', message);
}

function pyTypeName(v) {
  if (v && v.isDecimal) return 'Decimal';
  if (v && v.kind) return v.kind;
  return typeof v;
}

/**
 * json.JSONEncoder.iterencode (the pure-Python _make_iterencode that json.dump uses): yields the chunks of the
 * encoding, so a failure part-way leaves the earlier chunks written, as in Python.
 * @param {*} obj
 * @param {object} [opts]
 * @param {number|string|null} [opts.indent]
 * @param {[string, string]} [opts.separators] item and key separators
 * @param {boolean} [opts.ensureAscii]
 * @param {function(*): *} [opts.default] converts a value the encoder does not know
 */
function* iterencode(obj, { indent = null, separators = null, ensureAscii = true, default: toJson = null } = {}) {
  const ind = typeof indent === 'number' ? ' '.repeat(Math.max(0, indent)) : indent;
  const [itemSep, keySep] = separators || [ind === null ? ', ' : ',', ': '];
  const fallback = toJson || ((o) => { throw typeError(`Object of type ${pyTypeName(o)} is not JSON serializable`); });

  function* encodeList(lst, level) {
    if (!lst.length) {
      yield '[]';
      return;
    }
    let buf = '[';
    let separator = itemSep;
    let newlineIndent = null;
    if (ind !== null) {
      level += 1;
      newlineIndent = `\n${ind.repeat(level)}`;
      separator = itemSep + newlineIndent;
      buf += newlineIndent;
    }
    let first = true;
    for (const value of lst) {
      if (first) first = false;
      else buf = separator;
      const prim = encodePrimitive(value, ensureAscii);
      if (prim !== null) yield buf + prim;
      else {
        yield buf;
        yield* encodeValue(value, level);
      }
    }
    if (newlineIndent !== null) yield `\n${ind.repeat(level - 1)}`;
    yield ']';
  }

  function* encodeDict(dct, level) {
    if (!dct.size) {
      yield '{}';
      return;
    }
    yield '{';
    let separator = itemSep;
    let newlineIndent = null;
    if (ind !== null) {
      level += 1;
      newlineIndent = `\n${ind.repeat(level)}`;
      separator = itemSep + newlineIndent;
      yield newlineIndent;
    }
    let first = true;
    for (const [k, value] of dct) {
      let key = k;
      if (typeof key !== 'string') {
        key = encodePrimitive(key, ensureAscii);
        if (key === null) throw typeError(`keys must be str, int, float, bool or None, not ${pyTypeName(k)}`);
      }
      if (first) first = false;
      else yield separator;
      yield encodeString(key, ensureAscii);
      yield keySep;
      const prim = encodePrimitive(value, ensureAscii);
      if (prim !== null) yield prim;
      else yield* encodeValue(value, level);
    }
    if (newlineIndent !== null) yield `\n${ind.repeat(level - 1)}`;
    yield '}';
  }

  function* encodeValue(o, level) {
    const prim = encodePrimitive(o, ensureAscii);
    if (prim !== null) yield prim;
    else if (Array.isArray(o)) yield* encodeList(o, level);
    else if (o instanceof Map) yield* encodeDict(o, level);
    else yield* encodeValue(fallback(o), level);
  }

  yield* encodeValue(obj, 0);
}

/**
 * json.dump(obj, out, ...): writes the encoding chunk by chunk.
 * @param {*} obj
 * @param {{write(s: string): void}} out
 * @param {object} [opts] as for iterencode
 */
function dump(obj, out, opts) {
  for (const chunk of iterencode(obj, opts)) out.write(chunk);
}

/**
 * json.dumps(obj, ...).
 * @param {*} obj
 * @param {object} [opts] as for iterencode
 * @returns {string}
 */
function dumps(obj, opts) {
  return [...iterencode(obj, opts)].join('');
}

module.exports = { dump, dumps, pyIntValue, PyFloat };
