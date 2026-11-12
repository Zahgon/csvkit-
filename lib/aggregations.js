'use strict';
// Port of the agate.aggregations csvstat uses (agate 1.14.2, MIT): HasNulls, Count, Min, Max, Sum, Mean, Median
// (through Percentiles), Variance, StDev, MaxLength and MaxPrecision, plus Column.values_distinct and the
// collections.Counter.most_common ranking of csvstat's frequent values. Values follow Python's semantics: a
// Decimal NaN equals nothing (not even itself) and ordering it raises decimal.InvalidOperation.

const { pyError } = require('./pyerrors');
const { Decimal } = require('./decimal');
const { maxPrecision } = require('./table');
const T = require('./types');

/** agate.exceptions.DataTypeError: an aggregation applied to a column type it does not support. */
class DataTypeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.pyName = 'agate.exceptions.DataTypeError';
  }
}

const MAX_TIMEDELTA_US = 999999999 * 86400e6 + 86399999999;

function timedelta(us) {
  if (Math.abs(us) > MAX_TIMEDELTA_US) throw pyError('OverflowError', `days=${Math.floor(us / 86400e6)}; must have magnitude <= 999999999`);
  return new T.PyTimeDelta(us);
}

/**
 * Python's ordering of two values of one agate type (`a < b` and friends), raising where Python raises.
 * @returns {number} negative, zero or positive
 */
function compare(a, b) {
  if (a.isDecimal) return a.cmp(b);
  if (a instanceof T.PyDateTime && (a.tz === null) !== (b.tz === null)) {
    throw pyError('TypeError', "can't compare offset-naive and offset-aware datetimes");
  }
  const x = a.key();
  const y = b.key();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A key under which values that Python considers equal (and hash alike) coincide; every NaN gets its own key,
 * as a NaN is only equal to itself.
 */
function equalityKey(v) {
  if (v === null) return 'None';
  if (typeof v === 'string') return `s${v}`;
  if (typeof v === 'boolean') return `b${v}`;
  if (v.isDecimal) {
    if (v.isNaN()) return Symbol('NaN');
    if (v.special) return `d${v.sign ? '-' : ''}inf`;
    if (v.coef === 0n) return 'd0';
    let { coef, exp } = v;
    while (coef % 10n === 0n) {
      coef /= 10n;
      exp += 1;
    }
    return `d${v.sign ? '-' : ''}${coef}e${exp}`;
  }
  if (v instanceof T.PyDateTime) return `${v.kind}${v.tz === null ? 'naive' : 'aware'}${v.key()}`;
  return `${v.kind}${v.key()}`;
}

function nonNull(values) {
  return values.filter((v) => v !== null);
}

function requireType(type, types, aggregation, description) {
  if (!types.some((t) => type instanceof t)) {
    throw new DataTypeError(`${aggregation} can only be applied to columns containing ${description} data.`);
  }
}

function extreme(type, values, sign) {
  requireType(type, [T.DateType, T.DateTimeType, T.NumberType, T.TimeDeltaType], 'Min', 'DateTime, Date or Number');
  const data = nonNull(values);
  if (!data.length) return null;
  let best = data[0];
  for (const v of data.slice(1)) if (compare(v, best) * sign > 0) best = v;
  return best;
}

function sum(type, values) {
  requireType(type, [T.NumberType, T.TimeDeltaType], 'Sum', 'Number or TimeDelta');
  const data = nonNull(values);
  if (type instanceof T.TimeDeltaType) return data.reduce((acc, v) => timedelta(acc.us + v.us), timedelta(0));
  return data.reduce((acc, v) => acc.add(v), Decimal.fromInt(0));
}

// timedelta // int with round-half-even, as timedelta / int rounds.
function divideTimedelta(td, n) {
  const q = Math.floor(td.us / n);
  const r2 = (td.us - q * n) * 2;
  return timedelta(r2 > n || (r2 === n && q % 2 !== 0) ? q + 1 : q);
}

function mean(type, values) {
  requireType(type, [T.NumberType, T.TimeDeltaType], 'Mean', 'Number or TimeDelta');
  const data = nonNull(values);
  if (!data.length) return null;
  const total = sum(type, values);
  if (type instanceof T.TimeDeltaType) return divideTimedelta(total, data.length);
  return total.div(Decimal.fromInt(data.length));
}

function median(type, values) {
  requireType(type, [T.NumberType], 'Percentiles', 'Number');
  const data = nonNull(values).sort(compare);
  if (!data.length) return null;
  const k = data.length * 0.5;
  const low = Math.max(1, Math.ceil(k));
  const high = Math.min(data.length, Math.floor(k + 1));
  if (low === high) return data[low - 1];
  return data[low - 1].add(data[high - 1]).div(Decimal.fromInt(2));
}

function variance(type, values) {
  requireType(type, [T.NumberType], 'Variance', 'Number');
  const data = nonNull(values);
  if (!data.length) return null;
  const m = mean(type, values);
  const squares = data.reduce((acc, n) => {
    const d = n.sub(m);
    return acc.add(d.mul(d));
  }, Decimal.fromInt(0));
  return squares.div(Decimal.fromInt(data.length - 1));
}

function stdev(type, values) {
  requireType(type, [T.NumberType], 'StDev', 'Number');
  const v = variance(type, values);
  return v === null ? null : v.sqrt();
}

function maxLength(type, values) {
  requireType(type, [T.TextType], 'MaxLength', 'Text');
  const lengths = nonNull(values).map((v) => [...v].length);
  return Decimal.fromInt(lengths.length ? Math.max(...lengths) : 0);
}

const AGGREGATIONS = {
  nulls: (type, values) => values.includes(null),
  nonnulls: (type, values) => nonNull(values).length,
  min: (type, values) => extreme(type, values, -1),
  max: (type, values) => extreme(type, values, 1),
  sum,
  mean,
  median,
  stdev,
  len: maxLength,
  maxprecision: (type, values) => {
    requireType(type, [T.NumberType], 'MaxPrecision', 'Number');
    return maxPrecision(nonNull(values));
  },
};

/**
 * Runs the agate aggregation csvstat names `op` on a column, after its type validation.
 * @param {string} op one of nulls, nonnulls, min, max, sum, mean, median, stdev, len, maxprecision
 * @param {object} type the column's agate data type
 * @param {Array} values the column's values
 * @returns {*} a Decimal, number (Python int), boolean, date or timedelta value, or null
 */
function aggregate(op, type, values) {
  return AGGREGATIONS[op](type, values);
}

/**
 * len(Column.values_distinct()).
 * @param {Array} values the column's values
 * @returns {number}
 */
function countDistinct(values) {
  return new Set(values.map(equalityKey)).size;
}

/**
 * Counter(values).most_common(n): [value, count] pairs by decreasing count, first-seen first among equals; the
 * value kept for a group of equal values is the first one seen.
 * @param {Array} values
 * @param {number} n
 * @returns {Array<[*, number]>}
 */
function mostCommon(values, n) {
  const counts = new Map();
  for (const v of values) {
    const key = equalityKey(v);
    if (counts.has(key)) counts.get(key)[1] += 1;
    else counts.set(key, [v, 1]);
  }
  const ranked = [...counts.values()].sort((a, b) => b[1] - a[1]);
  return n <= 0 ? [] : ranked.slice(0, n);
}

module.exports = { aggregate, countDistinct, mostCommon };
