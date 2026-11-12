'use strict';
// Port of SQLite 3.40's sum(), total(), avg(), group_concat() and quote() (src/func.c, public domain), the SQLite
// the original's Python links against. Newer SQLite versions, such as the one node:sqlite bundles, sum with
// compensated arithmetic and convert REAL values to text with 17 significant digits instead of "%!.15g".

const SPACE = '[ \\t\\n\\v\\f\\r]*';
const INTEGER_TEXT = new RegExp(`^${SPACE}[+-]?\\d+${SPACE}$`);
const REAL_TEXT = new RegExp(`^${SPACE}[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?${SPACE}$`);
const REAL_PREFIX = new RegExp(`^${SPACE}[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?`);
const INT64_MAX = 0x7fffffffffffffffn;
const INT64_MIN = -0x8000000000000000n;

function textOf(value) {
  return value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value;
}

// sqlite3_value_double() of a TEXT or BLOB value: the longest numeric prefix, or 0.
function realPrefix(text) {
  const m = REAL_PREFIX.exec(text);
  return m ? Number(m[0].trim()) : 0;
}

// sqlite3_value_numeric_type() followed by the int64 or double read of the value: {int} or {real}.
function numericValue(value) {
  if (typeof value === 'bigint') return { int: value };
  if (typeof value === 'number') return { real: value };
  if (typeof value === 'string' && INTEGER_TEXT.test(value)) {
    const int = BigInt(value.trim());
    if (int >= INT64_MIN && int <= INT64_MAX) return { int };
  }
  if (typeof value === 'string' && REAL_TEXT.test(value)) {
    const real = Number(value.trim());
    if (real === 0 || (Number.isInteger(real) && Math.abs(real) < 2 ** 51)) return { int: BigInt(real) };
    return { real };
  }
  return { real: realPrefix(textOf(value)) };
}

/**
 * Formats a double as SQLite's "%!.15g" does: 15 significant digits, trailing zeros removed but one kept after
 * the decimal point, and an exponent of at least two digits.
 * @param {number} x
 * @returns {string}
 */
function formatReal(x) {
  if (!Number.isFinite(x)) return x > 0 ? 'Inf' : '-Inf';
  const [mantissa, exp] = x.toExponential(14).split('e');
  const e = Number(exp);
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace(/[-.]/g, '');
  const trim = (s) => s.replace(/0+$/, '') || '0';
  let out;
  if (e < -4 || e >= 15) {
    out = `${digits[0]}.${trim(digits.slice(1))}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  } else if (e < 0) {
    out = `0.${trim('0'.repeat(-e - 1) + digits)}`;
  } else {
    out = `${digits.slice(0, e + 1)}.${trim(digits.slice(e + 1))}`;
  }
  return negative ? `-${out}` : out;
}

// sqlite3_value_text() of a value, with REAL values formatted the 3.40 way.
function valueText(value) {
  if (typeof value === 'number') return formatReal(value);
  if (typeof value === 'bigint') return value.toString();
  return textOf(value);
}

function sumStep(acc, value) {
  if (value === null) return acc;
  const state = acc || { count: 0, approx: false, overflow: false, int: 0n, real: 0 };
  const v = numericValue(value);
  state.count++;
  if (v.int !== undefined) {
    state.real += Number(v.int);
    if (!state.approx && !state.overflow) {
      state.int += v.int;
      if (state.int > INT64_MAX || state.int < INT64_MIN) {
        state.approx = true;
        state.overflow = true;
      }
    }
  } else {
    state.real += v.real;
    state.approx = true;
  }
  return state;
}

function sumInverse(state, value) {
  if (value === null) return state;
  const v = numericValue(value);
  state.count--;
  if (v.int !== undefined && !state.approx) {
    state.real -= Number(v.int);
    state.int -= v.int;
  } else {
    state.real -= v.int !== undefined ? Number(v.int) : v.real;
  }
  return state;
}

function quote(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    const text = formatReal(value);
    if (!Number.isFinite(value) || Number(text) === value) return text;
    const [mantissa, exp] = value.toExponential(20).split('e');
    return `${mantissa.replace(/0+$/, '').replace(/\.$/, '.0')}e${exp[0]}${exp.slice(1).padStart(2, '0')}`;
  }
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex').toUpperCase()}'`;
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Registers SQLite 3.40's versions of sum(), total(), avg(), group_concat() and quote() on a node:sqlite database.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Function} UserFunctionError the error class that reports a failing SQL function
 * @returns {void}
 */
function registerSqlite340Functions(db, UserFunctionError) {
  const options = { start: null, step: sumStep, inverse: sumInverse, useBigIntArguments: true, deterministic: true };
  db.aggregate('sum', {
    ...options,
    result: (s) => {
      if (s === null || s.count === 0) return null;
      if (s.overflow) throw new UserFunctionError('integer overflow');
      return s.approx ? s.real : s.int;
    },
  });
  db.aggregate('total', { ...options, result: (s) => (s === null ? 0 : s.real) });
  db.aggregate('avg', { ...options, result: (s) => (s === null || s.count === 0 ? null : s.real / s.count) });

  const concat = (items, value, sep) => {
    if (value === null) return items;
    const list = items || [];
    list.push({ sep: sep === null ? '' : valueText(sep), text: valueText(value) });
    return list;
  };
  const concatOptions = {
    start: null,
    useBigIntArguments: true,
    deterministic: true,
    inverse: (items, value) => {
      if (value !== null) items.shift();
      return items;
    },
    result: (items) => {
      if (items === null || !items.length) return null;
      return items.map((item, i) => (i ? item.sep + item.text : item.text)).join('');
    },
  };
  db.aggregate('group_concat', { ...concatOptions, step: (items, value) => concat(items, value, ',') });
  db.aggregate('group_concat', { ...concatOptions, step: (items, value, sep) => concat(items, value, sep) });
  db.function('quote', { deterministic: true, useBigIntArguments: true }, quote);
}

module.exports = { registerSqlite340Functions };
