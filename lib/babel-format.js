'use strict';
// Port of babel.numbers.format_decimal (Babel 2.18, BSD-3-Clause) for the plain number patterns agate's
// print_table builds; the locale and its symbols come from lib/babel.js.

const { Locale } = require('./babel');

const NUMBER_PATTERN_RE = /^((?:[^'0-9@#.,]|'[^']*')*)([0-9@#.,E+]*)(.*)/u;

function matchNumber(pattern) {
  return NUMBER_PATTERN_RE.exec(pattern).slice(1);
}

function parsePrecision(p) {
  let min = 0;
  let max = 0;
  for (const c of p) {
    if ('@0'.includes(c)) {
      min += 1;
      max += 1;
    } else if (c === '#') max += 1;
    else if (c !== ',') break;
  }
  return [min, max];
}

function parseGrouping(p) {
  const width = p.length;
  let g1 = p.lastIndexOf(',');
  if (g1 === -1) return [1000, 1000];
  g1 = width - g1 - 1;
  let g2 = p.slice(0, -g1 - 1).lastIndexOf(',');
  if (g2 === -1) return [g1, g1];
  g2 = width - g1 - g2 - 2;
  return [g1, g2];
}

/**
 * babel.numbers.parse_pattern for plain patterns (no scientific notation or significant digits).
 * @param {string} pattern e.g. '#,##0.000;-#,##0.000'
 */
function parsePattern(pattern) {
  let posPrefix;
  let number;
  let posSuffix;
  let negPrefix;
  let negSuffix;
  const semi = pattern.indexOf(';');
  if (semi >= 0) {
    [posPrefix, number, posSuffix] = matchNumber(pattern.slice(0, semi));
    [negPrefix, , negSuffix] = matchNumber(pattern.slice(semi + 1));
  } else {
    [posPrefix, number, posSuffix] = matchNumber(pattern);
    negPrefix = `-${posPrefix}`;
    negSuffix = posSuffix;
  }
  const dot = number.lastIndexOf('.');
  const integer = dot >= 0 ? number.slice(0, dot) : number;
  const fraction = dot >= 0 ? number.slice(dot + 1) : '';
  const affixes = posPrefix + negPrefix + posSuffix + negSuffix;
  return {
    prefix: [posPrefix, negPrefix],
    suffix: [posSuffix, negSuffix],
    numberPattern: number,
    grouping: parseGrouping(integer),
    intPrec: parsePrecision(integer),
    fracPrec: parsePrecision(fraction),
    scale: affixes.includes('%') ? 2 : affixes.includes('‰') ? 3 : 0,
  };
}

function formatInt(pattern, value, min, group) {
  let v = value.length < min ? '0'.repeat(min - value.length) + value : value;
  let gsize = pattern.grouping[0];
  let ret = '';
  while (v.length > gsize) {
    ret = group + v.slice(-gsize) + ret;
    v = v.slice(0, -gsize);
    gsize = pattern.grouping[1];
  }
  return v + ret;
}

function formatFrac(value, [min, max], decimal) {
  let v = value.length < min ? value + '0'.repeat(min - value.length) : value;
  if (max === 0 || (min === 0 && /^0*$/.test(v))) return '';
  while (v.length > min && v.endsWith('0')) v = v.slice(0, -1);
  return decimal + v;
}

/**
 * babel.numbers.format_decimal(number, format, locale) with decimal quantization and grouping, for plain patterns
 * such as agate's '#,##0.00;-#,##0.00' and finite or NaN numbers (print_table never formats an infinity).
 * @param {import('./decimal').Decimal} number
 * @param {string} format the number pattern
 * @param {string} locale a locale identifier
 * @returns {string}
 */
function formatDecimal(number, format, locale) {
  const [group, decimal] = Locale.parse(locale).numberSymbols();
  const pattern = parsePattern(format);
  const isNegative = number.sign;
  const value = number.scaleb(pattern.scale).abs().normalize();
  const [whole, frac = ''] = value.quantize(-pattern.fracPrec[1]).toFixedString().split('.');
  const digits = formatInt(pattern, whole, pattern.intPrec[0], group) + formatFrac(frac || '0', pattern.fracPrec, decimal);
  const retval = pattern.prefix[isNegative] + (pattern.numberPattern !== '' ? digits : '') + pattern.suffix[isNegative];
  return retval.replace(/'([^']*)'/g, (m, text) => text || "'");
}

module.exports = { formatDecimal };
