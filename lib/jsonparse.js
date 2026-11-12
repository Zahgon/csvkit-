'use strict';
// json.loads with object_pairs_hook=OrderedDict and parse_float=Decimal: objects become Maps,
// integers BigInt-backed {pyInt}, floats Decimal.

const { Decimal } = require('./decimal');

/**
 * json.JSONDecodeError with Python's "msg: line L column C (char N)" message.
 */
class JSONDecodeError extends Error {
  /**
   * @param {string} msg the reason, e.g. "Expecting value"
   * @param {string} s the document
   * @param {number} pos the UTF-16 index of the error (the message counts code points, as Python does)
   */
  constructor(msg, s, pos) {
    const before = s.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    const col = [...before.slice(before.lastIndexOf('\n') + 1)].length + 1;
    super(`${msg}: line ${line} column ${col} (char ${[...before].length})`);
    this.pyName = 'json.decoder.JSONDecodeError';
  }
}

const NUMBER_RE = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;

/**
 * json.loads(s, object_pairs_hook=OrderedDict, parse_float=...): objects become Maps, integers {pyInt}
 * objects, floats whatever parseFloat returns.
 * @param {string} s
 * @param {{parseFloat?: function(string): *}} [options]
 * @returns {*}
 * @throws {JSONDecodeError} for text that is not one JSON document
 */
function loads(s, { parseFloat = (t) => Decimal.parse(t) } = {}) {
  let i = 0;
  const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const m = new Map();
      ws();
      if (s[i] === '}') { i++; return m; }
      for (;;) {
        ws();
        if (s[i] !== '"') throw new JSONDecodeError('Expecting property name enclosed in double quotes', s, i);
        const k = str();
        ws();
        if (s[i] !== ':') throw new JSONDecodeError("Expecting ':' delimiter", s, i);
        i++;
        m.set(k, value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return m; }
        throw new JSONDecodeError("Expecting ',' delimiter", s, i);
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      ws();
      if (s[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return a; }
        throw new JSONDecodeError("Expecting ',' delimiter", s, i);
      }
    }
    if (c === '"') return str();
    if (s.startsWith('null', i)) { i += 4; return null; }
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s.startsWith('NaN', i)) { i += 3; return NaN; }
    if (s.startsWith('Infinity', i)) { i += 8; return Infinity; }
    if (s.startsWith('-Infinity', i)) { i += 9; return -Infinity; }
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(s);
    if (m) {
      i += m[0].length;
      if (m[1] || m[2]) return parseFloat(m[0]);
      return { pyInt: BigInt(m[0]) };
    }
    throw new JSONDecodeError('Expecting value', s, i);
  };
  // scanstring (Modules/_json.c): error positions are those of the C scanner json.loads uses.
  const str = () => {
    const begin = i;
    i++;
    let out = '';
    for (;;) {
      if (i >= s.length) throw new JSONDecodeError('Unterminated string starting at', s, begin);
      const c = s[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        if (i + 1 >= s.length) throw new JSONDecodeError('Unterminated string starting at', s, begin);
        const n = s[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (n === 'u') {
          const hex = s.slice(i + 2, i + 6);
          if (i + 6 >= s.length || !/^[0-9a-fA-F]{4}$/.test(hex)) throw new JSONDecodeError('Invalid \\uXXXX escape', s, i + 1);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        if (!(n in map)) throw new JSONDecodeError('Invalid \\escape', s, i);
        out += map[n];
        i += 2;
        continue;
      }
      if (c < ' ') throw new JSONDecodeError('Invalid control character at', s, i);
      out += c;
      i++;
    }
  };
  ws();
  const v = value();
  ws();
  if (i < s.length) throw new JSONDecodeError('Extra data', s, i);
  return v;
}

module.exports = { loads, JSONDecodeError };
