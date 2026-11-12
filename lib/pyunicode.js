'use strict';
// Python str character classes over CPython 3.11's own Unicode tables (lib/unicode-data.js): str.isspace,
// str.isdigit, str.isdecimal with the digit values int() uses, str.split() / str.rstrip() without arguments,
// int(str), float(str) and unicodedata.lookup.

const { pyError } = require('./pyerrors');
const { pyStrip, pyRepr } = require('./pystr');
const U = require('./unicode-data');

const DIGITS = '\\d(?:_?\\d)*';
const FLOAT_LITERAL = new RegExp(`^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?$`);

/**
 * Whether c lies in one of the flat [first, last] ranges.
 * @param {number[]} ranges sorted flat pairs
 * @param {number} c a code point
 * @returns {boolean} membership
 */
function inRanges(ranges, c) {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c < ranges[2 * mid]) hi = mid - 1;
    else if (c > ranges[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

const isSpaceChar = (ch) => inRanges(U.SPACE, ch.codePointAt(0));

/** @param {string} s @returns {boolean} str.isdigit() */
function isDigit(s) {
  return s.length > 0 && Array.from(s).every((ch) => inRanges(U.DIGIT, ch.codePointAt(0)));
}

/**
 * The value of a decimal digit character (any script), as int() reads it.
 * @param {number} cp a code point
 * @returns {number} 0 to 9, or -1 when cp is not a decimal digit
 */
function decimalValue(cp) {
  const r = U.DECIMAL;
  for (let i = 0; i < r.length; i += 2) {
    if (cp >= r[i] && cp <= r[i + 1]) return (cp - r[i]) % 10;
    if (cp < r[i]) break;
  }
  return -1;
}

/** @param {string} s @returns {string} s.rstrip() */
function rstrip(s) {
  const chars = Array.from(s);
  let b = chars.length;
  while (b > 0 && isSpaceChar(chars[b - 1])) b--;
  return chars.slice(0, b).join('');
}

/** @param {string} s @returns {string[]} s.split() */
function split(s) {
  const out = [];
  let word = '';
  for (const ch of s) {
    if (isSpaceChar(ch)) {
      if (word) out.push(word);
      word = '';
    } else {
      word += ch;
    }
  }
  if (word) out.push(word);
  return out;
}

let nameMap = null;
const JAMO_L = ['G', 'GG', 'N', 'D', 'DD', 'R', 'M', 'B', 'BB', 'S', 'SS', '', 'J', 'JJ', 'C', 'K', 'T', 'P', 'H'];
const JAMO_V = ['A', 'AE', 'YA', 'YAE', 'EO', 'E', 'YEO', 'YE', 'O', 'WA', 'WAE', 'OE', 'YO', 'U', 'WEO', 'WE', 'WI',
  'YU', 'EU', 'YI', 'I'];
const JAMO_T = ['', 'G', 'GG', 'GS', 'N', 'NJ', 'NH', 'D', 'L', 'LG', 'LM', 'LB', 'LS', 'LT', 'LP', 'LH', 'M', 'B',
  'BS', 'S', 'SS', 'NG', 'J', 'C', 'K', 'T', 'P', 'H'];

function longestJamo(s, pos, table) {
  let best = -1;
  for (let i = 0; i < table.length; i++) {
    if (s.startsWith(table[i], pos) && (best < 0 || table[i].length > table[best].length)) best = i;
  }
  return best;
}

/**
 * unicodedata.lookup(name) for a single character: names and aliases (ASCII letters in any case), and the
 * algorithmic CJK unified ideograph and Hangul syllable names.
 * @param {string} name the character name
 * @returns {number} the code point, or -1 when there is no such character
 */
function lookupName(name) {
  if (name.startsWith('HANGUL SYLLABLE ')) {
    let pos = 16;
    const l = longestJamo(name, pos, JAMO_L);
    pos += JAMO_L[l].length;
    const v = longestJamo(name, pos, JAMO_V);
    if (v < 0) return -1;
    pos += JAMO_V[v].length;
    const t = longestJamo(name, pos, JAMO_T);
    pos += JAMO_T[t].length;
    return pos === name.length ? 0xac00 + (l * 21 + v) * 28 + t : -1;
  }
  if (name.startsWith('CJK UNIFIED IDEOGRAPH-')) {
    const hex = name.slice(22);
    if (!/^[0-9A-F]{4,5}$/.test(hex)) return -1;
    const cp = parseInt(hex, 16);
    return inRanges(require('./unicode-names').CJK_UNIFIED, cp) ? cp : -1;
  }
  if (nameMap === null) {
    const zlib = require('node:zlib');
    nameMap = new Map();
    const text = zlib.inflateSync(Buffer.from(require('./unicode-names').NAMES, 'base64')).toString('latin1');
    for (const line of text.split('\n')) {
      const tab = line.indexOf('\t');
      nameMap.set(line.slice(0, tab), parseInt(line.slice(tab + 1), 16));
    }
  }
  const cp = nameMap.get(name.replace(/[a-z]+/g, (m) => m.toUpperCase()));
  return cp === undefined ? -1 : cp;
}

/**
 * Replaces every decimal digit (any script) by its ASCII digit, as int(), float() and Decimal() read them.
 * @param {string} s
 * @returns {string}
 */
function asciiDigits(s) {
  let out = '';
  for (const ch of s) {
    const v = decimalValue(ch.codePointAt(0));
    out += v >= 0 ? String(v) : ch;
  }
  return out;
}

/**
 * The literal int(str) reads in base 10: surrounding whitespace, a sign, decimal digits of any script and single
 * underscores between digits.
 * @param {string} s the text
 * @returns {string|null} the sign and ASCII digits, or null where int() raises ValueError
 */
function intLiteral(s) {
  const t = asciiDigits(pyStrip(s));
  return /^[+-]?\d+(?:_\d+)*$/.test(t) ? t.replace(/_/g, '') : null;
}

/**
 * int(str) in base 10.
 * @param {string} s the text
 * @returns {number|null} the value, or null where int() raises ValueError
 */
function pyInt(s) {
  const t = intLiteral(s);
  return t === null ? null : Number(t);
}

/**
 * int(str) in base 10, raising Python's ValueError for text that is not an integer literal.
 * @param {string} s the text
 * @returns {number}
 * @throws {Error} pyName ValueError "invalid literal for int() with base 10: ..."
 */
function strToInt(s) {
  const v = pyInt(s);
  if (v === null) throw pyError('ValueError', `invalid literal for int() with base 10: ${pyRepr(s)}`);
  return v;
}

/**
 * float(str): surrounding whitespace, decimal digits of any script, underscores between digits, inf and nan.
 * @param {string} s the text
 * @returns {number|null} the value, or null where float() raises ValueError
 */
function pyFloat(s) {
  const t = asciiDigits(pyStrip(s));
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (special) {
    if (special[2].toLowerCase() === 'nan') return NaN;
    return special[1] === '-' ? -Infinity : Infinity;
  }
  return FLOAT_LITERAL.test(t) ? Number(t.replace(/_/g, '')) : null;
}

/**
 * float(str), raising Python's ValueError for text that is not a float literal.
 * @param {string} s the text
 * @returns {number}
 * @throws {Error} pyName ValueError "could not convert string to float: ..."
 */
function strToFloat(s) {
  const v = pyFloat(s);
  if (v === null) throw pyError('ValueError', `could not convert string to float: ${pyRepr(s)}`);
  return v;
}

module.exports = {
  inRanges, isDigit, decimalValue, asciiDigits, rstrip, split, intLiteral, pyInt, strToInt, pyFloat, strToFloat,
  lookupName,
};
