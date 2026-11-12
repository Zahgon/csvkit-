'use strict';
// Python str methods and re character classes whose Unicode behaviour differs from JavaScript's.

/** Python's whitespace (str.isspace(), re \s), as the body of a character class. */
const SPACE = ' \\t\\n\\v\\f\\r\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** Python's re \w for str patterns (str.isalnum() or '_'), as the body of a character class. */
const WORD = '\\p{L}\\p{N}_';
/** Python's re \b, for patterns compiled with the u flag. */
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;

/**
 * str.upper()
 * @param {string} s
 * @returns {string}
 */
function pyUpper(s) {
  return s.toUpperCase();
}

const PY_WS = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'gu');

/**
 * str.strip() with no arguments.
 * @param {string} s
 * @returns {string}
 */
function pyStrip(s) {
  return s.replace(PY_WS, '');
}

/**
 * Python repr() of a str: quoted with ' unless the text holds ' and no ", with the escapes CPython uses for
 * non-printable characters. Other values give String(value).
 * @param {*} s
 * @returns {string}
 */
function pyRepr(s) {
  if (typeof s !== 'string') return String(s);
  let q = "'";
  if (s.includes("'") && !s.includes('"')) q = '"';
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp >= 0x80 && cp < 0xa0) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (/[\p{Z}\p{C}]/u.test(ch) && ch !== ' ') {
      if (cp <= 0xff) out += '\\x' + cp.toString(16).padStart(2, '0');
      else if (cp <= 0xffff) out += '\\u' + cp.toString(16).padStart(4, '0');
      else out += '\\U' + cp.toString(16).padStart(8, '0');
    } else out += ch;
  }
  return q + out + q;
}

/**
 * Python repr() of a bytes object.
 * @param {Uint8Array} b
 * @returns {string}
 */
function pyBytesRepr(b) {
  let s = '';
  let hasSingle = false;
  let hasDouble = false;
  for (const c of b) {
    if (c === 0x27) hasSingle = true;
    if (c === 0x22) hasDouble = true;
  }
  const q = hasSingle && !hasDouble ? '"' : "'";
  for (const c of b) {
    if (c === 0x5c) s += '\\\\';
    else if (c === q.charCodeAt(0)) s += `\\${q}`;
    else if (c === 0x09) s += '\\t';
    else if (c === 0x0a) s += '\\n';
    else if (c === 0x0d) s += '\\r';
    else if (c < 0x20 || c >= 0x7f) s += `\\x${c.toString(16).padStart(2, '0')}`;
    else s += String.fromCharCode(c);
  }
  return `b${q}${s}${q}`;
}

module.exports = { SPACE, WORD, BOUNDARY, pyUpper, pyStrip, pyRepr, pyBytesRepr };
