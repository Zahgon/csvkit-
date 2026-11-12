'use strict';
// Port of Python's printf-style string formatting (the str % operator of CPython 3.11 Objects/unicodeobject.c,
// with PyOS_double_to_string for floats) for str and decimal.Decimal arguments, and of locale.format_string
// (Lib/locale.py) in the C locales, the only ones installed in the original's image.

const { pyError } = require('./pyerrors');
const { Decimal } = require('./decimal');
const { pyRepr } = require('./pystr');

function typeName(v) {
  return v && v.isDecimal ? 'decimal.Decimal' : 'str';
}

// The exact decimal value of a finite, non-negative double.
function exactDecimal(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  let e = -1074;
  if (expBits !== 0) {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  if (e >= 0) return new Decimal(0, mant << BigInt(e), 0);
  return new Decimal(0, mant * 5n ** BigInt(-e), e);
}

// The coefficient of `d` rounded half-even to exponent `exp`.
function roundToExponent(d, exp) {
  if (exp <= d.exp) return d.coef * 10n ** BigInt(d.exp - exp);
  const div = 10n ** BigInt(exp - d.exp);
  let q = d.coef / div;
  const r2 = (d.coef % div) * 2n;
  if (r2 > div || (r2 === div && q % 2n === 1n)) q += 1n;
  return q;
}

// |x| rounded half-even to `n` significant digits: [digits, decimal point position].
function significantDigits(x, n) {
  const d = exactDecimal(Math.abs(x));
  if (d.coef === 0n) return ['0'.repeat(n), 1];
  let digits = roundToExponent(d, d.adjusted() - n + 1).toString();
  let decpt = d.adjusted() + 1;
  if (digits.length > n) {
    digits = digits.slice(0, n);
    decpt += 1;
  }
  return [digits, decpt];
}

function exponentSuffix(exp, upper) {
  const e = Math.abs(exp);
  return `${upper ? 'E' : 'e'}${exp < 0 ? '-' : '+'}${e < 10 ? '0' : ''}${e}`;
}

/**
 * PyOS_double_to_string(x, code, prec, alt ? Py_DTSF_ALT : 0) for the e, f and g codes and their upper-case forms.
 * @param {number} x
 * @param {string} code one of eEfFgG
 * @param {number} prec
 * @param {boolean} alt the '#' flag
 * @returns {string}
 */
function formatFloat(x, code, prec, alt) {
  const upper = code === code.toUpperCase();
  if (Number.isNaN(x)) return upper ? 'NAN' : 'nan';
  const sign = x < 0 || Object.is(x, -0) ? '-' : '';
  if (!Number.isFinite(x)) return sign + (upper ? 'INF' : 'inf');
  const kind = code.toLowerCase();
  let body;
  if (kind === 'f') {
    const digits = roundToExponent(exactDecimal(Math.abs(x)), -prec).toString().padStart(prec + 1, '0');
    body = digits.slice(0, digits.length - prec);
    if (prec > 0 || alt) body += `.${digits.slice(digits.length - prec)}`;
  } else if (kind === 'e') {
    const [digits, decpt] = significantDigits(x, prec + 1);
    body = digits[0] + (prec > 0 || alt ? `.${digits.slice(1)}` : '') + exponentSuffix(x === 0 ? 0 : decpt - 1, upper);
  } else {
    const p = prec === 0 ? 1 : prec;
    let [digits, decpt] = significantDigits(x, p);
    if (!alt) digits = digits.replace(/0+$/, '') || '0';
    if (decpt <= -4 || decpt > p) {
      const frac = digits.slice(1);
      body = digits[0] + (frac || alt ? `.${frac}` : '') + exponentSuffix(decpt - 1, upper);
    } else if (decpt <= 0) {
      body = `0.${'0'.repeat(-decpt)}${digits}`;
    } else if (decpt >= digits.length) {
      body = digits + '0'.repeat(decpt - digits.length) + (alt ? '.' : '');
    } else {
      body = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
    }
  }
  return sign + body;
}

// int(v) for the d, i and u conversions, operator.index(v) for o, x and X (which a Decimal does not support).
function toInteger(v, conv) {
  if (!(v && v.isDecimal) || 'oxX'.includes(conv)) {
    const wanted = 'oxX'.includes(conv) ? 'an integer' : 'a real number';
    throw pyError('TypeError', `%${conv} format: ${wanted} is required, not ${typeName(v)}`);
  }
  return v.truncate();
}

// float(v), as PyFloat_AsDouble reports a str argument.
function toFloat(v) {
  if (v && v.isDecimal) return v.toNumber();
  throw pyError('TypeError', `must be real number, not ${typeName(v)}`);
}

function repr(v) {
  return v && v.isDecimal ? `Decimal('${v.pyStr()}')` : pyRepr(v);
}

// ascii(): repr() with the non-ASCII characters escaped.
function ascii(v) {
  return [...repr(v)].map((ch) => {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) return ch;
    if (cp < 0x100) return `\\x${cp.toString(16).padStart(2, '0')}`;
    if (cp < 0x10000) return `\\u${cp.toString(16).padStart(4, '0')}`;
    return `\\U${cp.toString(16).padStart(8, '0')}`;
  }).join('');
}

// Formats one argument for conversion `conv`: [text, isNumeric], or null for an unknown conversion.
function formatArg(v, conv, flags, prec) {
  switch (conv) {
    case 's': case 'r': case 'a': {
      const s = conv === 's' ? (v.isDecimal ? v.pyStr() : v) : conv === 'r' ? repr(v) : ascii(v);
      return [prec >= 0 ? [...s].slice(0, prec).join('') : s, false];
    }
    case 'd': case 'i': case 'u': case 'o': case 'x': case 'X': {
      const n = toInteger(v, conv);
      let digits = (n < 0n ? -n : n).toString(conv === 'o' ? 8 : 'xX'.includes(conv) ? 16 : 10);
      if (prec > digits.length) digits = '0'.repeat(prec - digits.length) + digits;
      if (conv === 'X') digits = digits.toUpperCase();
      return [(n < 0n ? '-' : '') + digits, true];
    }
    case 'e': case 'E': case 'f': case 'F': case 'g': case 'G':
      return [formatFloat(toFloat(v), conv, prec < 0 ? 6 : prec, Boolean(flags.alt)), true];
    case 'c':
      if (typeof v === 'string' && [...v].length === 1) return [v, false];
      throw pyError('TypeError', '%c requires int or char');
    default:
      return null;
  }
}

// unicode_format_arg_output: the sign, the alternate-form prefix of o, x and X, and the padding.
function pad(text, numeric, conv, flags, width) {
  let chars = [...text];
  const fill = numeric && flags.zero ? '0' : ' ';
  let sign = '';
  if (numeric) {
    if (chars[0] === '-' || chars[0] === '+') {
      sign = chars[0];
      chars = chars.slice(1);
    } else if (flags.sign) sign = '+';
    else if (flags.blank) sign = ' ';
  }
  const prefix = flags.alt && 'oxX'.includes(conv) ? `0${conv}` : '';
  let room = Math.max(width, chars.length + prefix.length);
  if (sign && room > chars.length + prefix.length) room -= 1;
  room -= prefix.length;
  let out = fill === ' ' ? '' : sign + prefix;
  if (room > chars.length && !flags.ljust) {
    out += fill.repeat(room - chars.length);
    room = chars.length;
  }
  if (fill === ' ') out += sign + prefix;
  out += chars.join('');
  if (room > chars.length) out += ' '.repeat(room - chars.length);
  return out;
}

const FLAG_NAMES = { '-': 'ljust', '+': 'sign', ' ': 'blank', '#': 'alt', 0: 'zero' };

/**
 * The str % operator, `fmt % args`, for a single (non-tuple) str or Decimal argument or, given an array, a tuple
 * of them.
 * @param {string} fmt
 * @param {*} args
 * @returns {string}
 */
function percentFormat(fmt, args) {
  const values = Array.isArray(args) ? args : [args];
  let argidx = 0;
  const nextArg = () => {
    if (argidx >= values.length) throw pyError('TypeError', 'not enough arguments for format string');
    return values[argidx++];
  };
  const chars = [...fmt];
  const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
  let pos = 0;
  const readInt = (what) => {
    let n = 0;
    while (isDigit(chars[pos])) {
      n = n * 10 + Number(chars[pos++]);
      if (n > Number.MAX_SAFE_INTEGER) throw pyError('ValueError', `${what} too big`);
    }
    return n;
  };
  const starArg = () => {
    nextArg();
    throw pyError('TypeError', '* wants int');
  };
  let out = '';
  while (pos < chars.length) {
    const c = chars[pos++];
    if (c !== '%') {
      out += c;
      continue;
    }
    if (chars[pos] === '(') throw pyError('TypeError', 'format requires a mapping');
    const flags = {};
    while (FLAG_NAMES[chars[pos]]) flags[FLAG_NAMES[chars[pos++]]] = true;
    let width = -1;
    let prec = -1;
    if (chars[pos] === '*') starArg();
    else if (isDigit(chars[pos])) width = readInt('width');
    if (chars[pos] === '.') {
      pos += 1;
      if (chars[pos] === '*') starArg();
      prec = readInt('precision');
    }
    if ('hlL'.includes(chars[pos]) && pos < chars.length) pos += 1;
    if (pos >= chars.length) throw pyError('ValueError', 'incomplete format');
    const conv = chars[pos++];
    if (conv === '%') {
      out += '%';
      continue;
    }
    const formatted = formatArg(nextArg(), conv, flags, prec);
    if (formatted === null) {
      const cp = conv.codePointAt(0);
      const shown = cp >= 32 && cp <= 126 ? conv : '?';
      throw pyError('ValueError', `unsupported format character '${shown}' (0x${cp.toString(16)}) at index ${pos - 1}`);
    }
    out += pad(formatted[0], formatted[1], conv, flags, width);
  }
  if (argidx < values.length) throw pyError('TypeError', 'not all arguments converted during string formatting');
  return out;
}

const PERCENT_RE = /%(?:\([^\n]*?\))?([-#0-9 +*.hlL]*?)[eEfFgGdiouxXcrs%]/g;

/**
 * locale.format_string(f, val, grouping) in a C locale, where the decimal point is '.' and there is no
 * grouping: formats each specifier with `val`, then the rewritten format with the results.
 * @param {string} f
 * @param {Decimal} val
 * @returns {string}
 * @throws {Error} pyName IndexError "tuple index out of range" for a format with more than one specifier, and the
 *   errors %-formatting raises for a specifier the value does not fit
 */
function formatString(f, val) {
  const results = [];
  let i = 0;
  for (const m of f.matchAll(PERCENT_RE)) {
    if (m[0].endsWith('%')) {
      results.push('%');
      continue;
    }
    if (i >= 1) throw pyError('IndexError', 'tuple index out of range');
    results.push(percentFormat(m[0], val));
    i += 1 + (m[1].match(/\*/g) || []).length;
  }
  return percentFormat(f.replace(PERCENT_RE, '%s'), results);
}

module.exports = { formatString };
