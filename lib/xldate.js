'use strict';
// Spreadsheet serial dates: openpyxl 3.1.5 utils.datetime (from_excel, from_ISO8601) and xlrd 2.0.2
// xldate.xldate_as_datetime, on Python datetime arithmetic (proleptic Gregorian ordinals, timedelta rounding).

const { pyError } = require('./pyerrors');
const { PyDate, PyDateTime, PyTimeDelta } = require('./types');
const { daysInMonth, ymdToOrd, ordToYmd } = require('./pydatetime');

const US_PER_DAY = 86400000000n;
const MAX_ORDINAL = 3652059;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** A Python datetime.time value; str() and isoformat() give "HH:MM:SS[.ffffff]". */
class PyTime {
  /**
   * @param {number} h
   * @param {number} mi
   * @param {number} s
   * @param {number} [us]
   */
  constructor(h, mi, s, us = 0) {
    Object.assign(this, { h, mi, s, us });
    this.kind = 'time';
  }

  /** @returns {string} str(time) */
  pyStr() {
    const r = `${pad(this.h)}:${pad(this.mi)}:${pad(this.s)}`;
    return this.us ? `${r}.${pad(this.us, 6)}` : r;
  }
}

/** Python round() of a float to an integer (half to even). */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** The day-count limits of a datetime.timedelta (a C int, then +-999999999). */
function checkDays(days) {
  if (days > 2147483647n || days < -2147483648n) throw pyError('OverflowError', 'Python int too large to convert to C int');
  if (days > 999999999n || days < -999999999n) {
    throw pyError('OverflowError', `days=${days}; must have magnitude <= 999999999`);
  }
}

/** C round(): halves away from zero. */
function cRound(x) {
  return Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
}

/**
 * datetime(epoch) + timedelta(microseconds=us) as a PyDateTime.
 * @param {number[]} epoch [y, m, d]
 * @param {bigint} us offset in microseconds
 * @returns {PyDateTime}
 * @throws {Error} pyName OverflowError for a timedelta or date out of range
 */
function addToEpoch(epoch, us) {
  let days = us / US_PER_DAY;
  let rem = us % US_PER_DAY;
  if (rem < 0n) {
    rem += US_PER_DAY;
    days -= 1n;
  }
  checkDays(days);
  const ord = ymdToOrd(...epoch) + Number(days);
  if (ord < 1 || ord > MAX_ORDINAL) throw pyError('OverflowError', 'date value out of range');
  const [y, m, d] = ordToYmd(ord);
  const r = Number(rem);
  const secs = Math.floor(r / 1e6);
  return new PyDateTime(y, m, d, Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60, r % 1e6);
}

/**
 * Microseconds of datetime.timedelta(**parts), following CPython's accumulation of each float argument and its
 * final round-half-even of the leftover fraction.
 * @param {Array<[number, number]>} parts [value, microseconds per unit] pairs
 * @returns {bigint}
 */
function timedeltaMicros(parts) {
  let sum = 0n;
  let leftover = 0;
  for (const [value, factor] of parts) {
    const ip = Math.trunc(value);
    sum += BigInt(ip) * BigInt(factor);
    const prod = (value - ip) * factor;
    const ip2 = Math.trunc(prod);
    sum += BigInt(ip2);
    leftover += prod - ip2;
  }
  if (leftover) {
    let whole = cRound(leftover);
    if (Math.abs(whole - leftover) === 0.5) {
      const odd = sum % 2n !== 0n ? 1 : 0;
      whole = 2 * cRound((leftover + odd) * 0.5) - odd;
    }
    sum += BigInt(whole);
  }
  return sum;
}

function daysToMicros(value) {
  return timedeltaMicros([[value, 86400000000]]);
}

/** Python divmod(x, 1) for a float. */
function divmod1(x) {
  let mod = x % 1;
  let div = x - mod;
  if (mod && mod < 0) {
    mod += 1;
    div -= 1;
  }
  return [div, mod];
}

const WINDOWS_EPOCH = [1899, 12, 30];
const MAC_EPOCH = [1904, 1, 1];

/**
 * openpyxl.utils.datetime.from_excel: serial number to datetime, time or timedelta.
 * @param {number} value serial (int or float value as a JS number)
 * @param {number[]} epoch WINDOWS_EPOCH or MAC_EPOCH
 * @param {boolean} timedelta the cell's format is a duration format
 * @returns {PyDateTime|PyTime|PyTimeDelta} a time for a value in [0, 1), a timedelta for a duration format
 * @throws {Error} pyName ValueError for a NaN, OverflowError for a value out of datetime's or timedelta's range
 */
function fromExcel(value, epoch, timedelta) {
  if (timedelta) {
    let us = daysToMicros(value);
    checkDays(us >= 0n ? us / US_PER_DAY : -((-us + US_PER_DAY - 1n) / US_PER_DAY));
    const micro = ((us % 1000000n) + 1000000n) % 1000000n;
    if (micro) {
      const totalSeconds = Number(us) / 1e6;
      const secs = Math.floor(totalSeconds);
      const ms = BigInt(roundHalfEven(Number(micro) / 1000)) * 1000n;
      us = BigInt(secs) * 1000000n + ms;
    }
    return new PyTimeDelta(Number(us));
  }
  const [day, fraction] = divmod1(value);
  const diffMs = roundHalfEven(fraction * 86400 * 1000);
  if (value >= 0 && value < 1 && diffMs < 86400000) {
    const secs = Math.floor(diffMs / 1000);
    return new PyTime(Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60, (diffMs % 1000) * 1000);
  }
  let d = day;
  if (value > 0 && value < 60 && epoch === WINDOWS_EPOCH) d += 1;
  if (!Number.isFinite(d)) throw pyError('ValueError', 'cannot convert float NaN to integer');
  return addToEpoch(epoch, BigInt(d) * US_PER_DAY + BigInt(diffMs) * 1000n);
}

const ISO_REGEX = /^(?<date>(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}))?T?(?<time>(?<hour>\d{2}):(?<minute>\d{2})(:(?<second>\d{2})(?<microsecond>\.\d{1,3})?)?)?Z?/;
const ISO_DURATION = /^PT((?<hours>\d+)H)?((?<minutes>\d+)M)?((?<seconds>\d+(\.\d{1,3})?)S)?/;

function checkDate(y, m, d) {
  if (y < 1 || y > 9999) throw pyError('ValueError', `year ${y} is out of range`);
  if (m < 1 || m > 12) throw pyError('ValueError', 'month must be in 1..12');
  if (d < 1 || d > daysInMonth(y, m)) throw pyError('ValueError', 'day is out of range for month');
}

function checkTime(h, mi, s) {
  if (h > 23) throw pyError('ValueError', 'hour must be in 0..23');
  if (mi > 59) throw pyError('ValueError', 'minute must be in 0..59');
  if (s > 59) throw pyError('ValueError', 'second must be in 0..59');
}

/**
 * openpyxl.utils.datetime.from_ISO8601 for cells of type "d".
 * @param {string} s cell text
 * @returns {PyDateTime|PyDate|PyTime|PyTimeDelta|null} null for empty text
 * @throws {Error} pyName ValueError for text that is not an ISO 8601 value or has a field out of range
 */
function fromISO8601(s) {
  if (!s) return null;
  const m = ISO_REGEX.exec(s);
  if (m && m.slice(1).some((g) => g)) {
    const g = m.groups;
    const num = (k) => (g[k] ? parseInt(g[k], 10) : 0);
    const us = g.microsecond ? Math.trunc(parseFloat(g.microsecond) * 1000000) : 0;
    if (!g.date) {
      checkTime(num('hour'), num('minute'), num('second'));
      return new PyTime(num('hour'), num('minute'), num('second'), us);
    }
    checkDate(num('year'), num('month'), num('day'));
    if (!g.time) return new PyDate(num('year'), num('month'), num('day'));
    checkTime(num('hour'), num('minute'), num('second'));
    return new PyDateTime(num('year'), num('month'), num('day'), num('hour'), num('minute'), num('second'), us);
  }
  const d = ISO_DURATION.exec(s);
  if (d && d.slice(1).some((x) => x)) {
    const g = d.groups;
    const f = (k) => (g[k] ? parseFloat(g[k]) : 0);
    return new PyTimeDelta(Number(timedeltaMicros([[f('hours'), 3600e6], [f('minutes'), 60e6], [f('seconds'), 1e6]])));
  }
  throw pyError('ValueError', `Invalid datetime value ${s}`);
}

/**
 * xlrd.xldate.xldate_as_datetime.
 * @param {number} xldate serial number
 * @param {number} datemode 0 for the 1900 system, 1 for 1904
 * @returns {PyDateTime}
 * @throws {Error} pyName OverflowError for a serial number out of datetime's range
 */
function xldateAsDatetime(xldate, datemode) {
  let epoch;
  if (datemode) epoch = [1904, 1, 1];
  else if (xldate < 60) epoch = [1899, 12, 31];
  else epoch = [1899, 12, 30];
  const days = Math.trunc(xldate);
  const fraction = xldate - days;
  const ms = Math.trunc(roundHalfEven(fraction * 86400000.0));
  return addToEpoch(epoch, BigInt(days) * US_PER_DAY + BigInt(ms) * 1000n);
}

module.exports = {
  PyTime, timedeltaMicros, addToEpoch, fromExcel, fromISO8601, xldateAsDatetime, WINDOWS_EPOCH, MAC_EPOCH,
};
