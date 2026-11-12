'use strict';
// Port of the parts of CPython 3.11's datetime and time modules (Modules/_datetimemodule.c, Lib/datetime.py,
// Modules/timemodule.c) that agate and its parsers use: date, datetime, timedelta and fixed-offset timezone
// values with their arithmetic, validation errors and str()/isoformat(), plus time.localtime() and time.mktime().

const { pyError } = require('./pyerrors');

const MINYEAR = 1;
const MAXYEAR = 9999;
const MAX_DELTA_DAYS = 999999999;
const US_PER_SECOND = 1000000n;
const US_PER_DAY = 86400000000n;
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * calendar.isleap(y)
 * @param {number} y
 * @returns {boolean}
 */
function isLeap(y) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }

/**
 * Number of days in a month (calendar.monthrange()[1]).
 * @param {number} y
 * @param {number} m 1..12
 * @returns {number}
 */
function daysInMonth(y, m) { return m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m]; }

function daysBeforeYear(y) {
  const z = y - 1;
  return z * 365 + Math.floor(z / 4) - Math.floor(z / 100) + Math.floor(z / 400);
}

/**
 * date(y, m, d).toordinal(): the proleptic Gregorian ordinal, 1 for 0001-01-01.
 * @param {number} y
 * @param {number} m
 * @param {number} d
 * @returns {number}
 */
function ymdToOrd(y, m, d) {
  return daysBeforeYear(y) + DAYS_BEFORE_MONTH[m] + (m > 2 && isLeap(y) ? 1 : 0) + d;
}

/**
 * date.fromordinal(n) as [year, month, day], for any n >= 1 (years past 9999 included).
 * @param {number} n
 * @returns {number[]}
 */
function ordToYmd(n) {
  n -= 1;
  const n400 = Math.floor(n / 146097);
  n %= 146097;
  let y = n400 * 400 + 1;
  const n100 = Math.floor(n / 36524);
  n %= 36524;
  const n4 = Math.floor(n / 1461);
  n %= 1461;
  const n1 = Math.floor(n / 365);
  n %= 365;
  y += n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return [y - 1, 12, 31];
  const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
  let m = (n + 50) >> 5;
  let preceding = DAYS_BEFORE_MONTH[m] + (m > 2 && leap ? 1 : 0);
  if (preceding > n) {
    m -= 1;
    preceding -= DAYS_IN_MONTH[m] + (m === 2 && leap ? 1 : 0);
  }
  return [y, m, n - preceding + 1];
}

function checkDateFields(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw pyError('TypeError', "'float' object cannot be interpreted as an integer");
  }
  if (y < MINYEAR || y > MAXYEAR) throw pyError('ValueError', `year ${y} is out of range`);
  if (m < 1 || m > 12) throw pyError('ValueError', 'month must be in 1..12');
  if (d < 1 || d > daysInMonth(y, m)) throw pyError('ValueError', 'day is out of range for month');
}

function checkTimeFields(h, mi, s, us) {
  if (![h, mi, s, us].every(Number.isInteger)) {
    throw pyError('TypeError', "'float' object cannot be interpreted as an integer");
  }
  if (h < 0 || h > 23) throw pyError('ValueError', 'hour must be in 0..23');
  if (mi < 0 || mi > 59) throw pyError('ValueError', 'minute must be in 0..59');
  if (s < 0 || s > 59) throw pyError('ValueError', 'second must be in 0..59');
  if (us < 0 || us > 999999) throw pyError('ValueError', 'microsecond must be in 0..999999');
}

/** A datetime.timedelta, stored as an exact count of microseconds. */
class PyTimeDelta {
  /**
   * @param {bigint|number} us Total microseconds (already normalised and range-checked by the factories).
   */
  constructor(us) {
    this.total = BigInt(us);
    this.kind = 'timedelta';
  }

  /**
   * timedelta(microseconds=n) with CPython's day-range check.
   * @param {bigint} us
   * @returns {PyTimeDelta}
   * @throws {Error} pyName OverflowError for more than 999999999 days either way
   */
  static fromMicroseconds(us) {
    let days = us / US_PER_DAY;
    if (us % US_PER_DAY !== 0n && us < 0n) days -= 1n;
    if (days > 2147483647n || days < -2147483648n) throw pyError('OverflowError', 'Python int too large to convert to C int');
    if (days > BigInt(MAX_DELTA_DAYS) || days < -BigInt(MAX_DELTA_DAYS)) {
      throw pyError('OverflowError', `days=${days}; must have magnitude <= ${MAX_DELTA_DAYS}`);
    }
    return new PyTimeDelta(us);
  }

  /**
   * The timedelta(**kwargs) constructor: each argument is a Python int (bigint) or float (number), accumulated
   * exactly as delta_new() does, with the float leftovers rounded half to even.
   * @param {{days?, seconds?, microseconds?, milliseconds?, minutes?, hours?, weeks?}} a
   * @returns {PyTimeDelta}
   * @throws {Error} pyName ValueError for a NaN, OverflowError for an infinity or a result out of range
   */
  static make(a) {
    let sum = 0n;
    let leftover = 0;
    const accum = (num, factor) => {
      if (num === undefined) return;
      if (typeof num === 'bigint') {
        sum += num * factor;
        return;
      }
      if (Number.isNaN(num)) throw pyError('ValueError', 'cannot convert float NaN to integer');
      if (!Number.isFinite(num)) throw pyError('OverflowError', 'cannot convert float infinity to integer');
      const ip = Math.trunc(num);
      sum += BigInt(ip) * factor;
      const frac = num - ip;
      if (frac === 0) return;
      const d = Number(factor) * frac;
      const ip2 = Math.trunc(d);
      sum += BigInt(ip2);
      leftover += d - ip2;
    };
    accum(a.microseconds, 1n);
    accum(a.milliseconds, 1000n);
    accum(a.seconds, US_PER_SECOND);
    accum(a.minutes, 60n * US_PER_SECOND);
    accum(a.hours, 3600n * US_PER_SECOND);
    accum(a.days, US_PER_DAY);
    accum(a.weeks, 7n * US_PER_DAY);
    if (leftover) {
      let whole = cRound(leftover);
      if (Math.abs(whole - leftover) === 0.5) {
        const odd = (sum & 1n) ? 1 : 0;
        whole = 2 * cRound((leftover + odd) * 0.5) - odd;
      }
      sum += BigInt(whole);
    }
    return PyTimeDelta.fromMicroseconds(sum);
  }

  /** @returns {number} total microseconds as a JavaScript number */
  get us() { return Number(this.total); }

  /**
   * timedelta.days
   * @returns {number}
   */
  get days() {
    const q = this.total / US_PER_DAY;
    return Number(this.total % US_PER_DAY !== 0n && this.total < 0n ? q - 1n : q);
  }

  /**
   * timedelta.total_seconds()
   * @returns {number}
   */
  totalSeconds() { return Number(this.total) / 1e6; }

  /**
   * str(timedelta)
   * @returns {string}
   */
  pyStr() {
    const days = BigInt(this.days);
    const rem = this.total - days * US_PER_DAY;
    const us = rem % US_PER_SECOND;
    const secs = Number(rem / US_PER_SECOND);
    let r = `${Math.floor(secs / 3600)}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
    if (us) r += `.${pad(us, 6)}`;
    if (days) r = `${days} day${days === 1n || days === -1n ? '' : 's'}, ${r}`;
    return r;
  }

  /** @returns {boolean} whether -timedelta(hours=24) < self < timedelta(hours=24) */
  withinADay() { return this.total > -US_PER_DAY && this.total < US_PER_DAY; }

  /**
   * repr(timedelta)
   * @returns {string}
   */
  reprString() {
    const days = this.days;
    const rem = this.total - BigInt(days) * US_PER_DAY;
    const parts = [];
    if (days) parts.push(`days=${days}`);
    if (rem / US_PER_SECOND) parts.push(`seconds=${rem / US_PER_SECOND}`);
    if (rem % US_PER_SECOND) parts.push(`microseconds=${rem % US_PER_SECOND}`);
    return `datetime.timedelta(${parts.join(', ') || '0'})`;
  }

  /** @returns {bigint} the sort key, total microseconds */
  key() { return this.total; }
}

// C's round(): halves away from zero.
function cRound(x) {
  const t = Math.trunc(x);
  return Math.abs(x - t) >= 0.5 ? t + Math.sign(x) : t;
}

/** A fixed-offset tzinfo (datetime.timezone, or isodate's FixedOffset which skips the range check). */
class PyTimezone {
  /**
   * @param {PyTimeDelta} offset
   * @param {string|null} [name]
   */
  constructor(offset, name = null) {
    this.offset = offset;
    this.name = name;
  }

  /**
   * datetime.timezone(offset, name), which rejects offsets of a day or more.
   * @param {PyTimeDelta} offset
   * @param {string|null} [name]
   * @returns {PyTimezone}
   * @throws {Error} pyName ValueError for an offset of a day or more
   */
  static checked(offset, name = null) {
    if (!offset.withinADay()) {
      throw pyError('ValueError', 'offset must be a timedelta strictly between -timedelta(hours=24) and '
        + `timedelta(hours=24), not ${offset.reprString()}.`);
    }
    return new PyTimezone(offset, name);
  }

  /**
   * The '+HH:MM[:SS[.ffffff]]' suffix of isoformat(), validating utcoffset() as CPython does.
   * @returns {string}
   * @throws {Error} pyName ValueError for an offset of a day or more (isodate's FixedOffset allows one)
   */
  isoSuffix() {
    if (!this.offset.withinADay()) {
      throw pyError('ValueError', 'offset must be a timedelta strictly between -timedelta(hours=24) and '
        + 'timedelta(hours=24).');
    }
    let t = this.offset.total;
    const sign = t < 0n ? '-' : '+';
    if (t < 0n) t = -t;
    const us = t % US_PER_SECOND;
    const secs = Number(t / US_PER_SECOND);
    let r = `${sign}${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}`;
    if (secs % 60 || us) r += `:${pad(secs % 60)}`;
    if (us) r += `.${pad(us, 6)}`;
    return r;
  }
}

/** A datetime.date. */
class PyDate {
  /**
   * date(y, m, d).
   * @param {number} y
   * @param {number} m
   * @param {number} d
   * @throws {Error} pyName ValueError, like CPython, for a field out of range, TypeError for a non-integer one
   */
  constructor(y, m, d) {
    checkDateFields(y, m, d);
    this.y = y;
    this.m = m;
    this.d = d;
    this.kind = 'date';
  }

  /**
   * date.fromordinal(n)
   * @param {number} n
   * @returns {PyDate}
   * @throws {Error} pyName ValueError for n < 1 or past 9999-12-31
   */
  static fromOrdinal(n) {
    if (n < 1) throw pyError('ValueError', 'ordinal must be >= 1');
    return new PyDate(...ordToYmd(n));
  }

  /**
   * date.toordinal()
   * @returns {number}
   */
  ordinal() { return ymdToOrd(this.y, this.m, this.d); }

  /**
   * date.weekday()
   * @returns {number} 0 for Monday to 6 for Sunday
   */
  weekday() { return (this.ordinal() + 6) % 7; }

  /**
   * date.isocalendar()
   * @returns {number[]} [ISO year, week, weekday]
   */
  isocalendar() {
    let year = this.y;
    let week1 = isoWeek1Monday(year);
    const today = this.ordinal();
    let week = Math.floor((today - week1) / 7);
    let day = (today - week1) % 7;
    if (day < 0) day += 7;
    if (week < 0) {
      year -= 1;
      week1 = isoWeek1Monday(year);
      week = Math.floor((today - week1) / 7);
      day = (today - week1) % 7;
    } else if (week >= 52 && today >= isoWeek1Monday(year + 1)) {
      year += 1;
      week = 0;
    }
    return [year, week + 1, day + 1];
  }

  /**
   * date + timedelta (whole days only matter for dates).
   * @param {PyTimeDelta} delta
   * @returns {PyDate}
   * @throws {Error} pyName OverflowError for a result outside years 1 to 9999
   */
  plus(delta) {
    const n = this.ordinal() + delta.days;
    if (n < 1 || n > ymdToOrd(MAXYEAR, 12, 31)) throw pyError('OverflowError', 'date value out of range');
    return PyDate.fromOrdinal(n);
  }

  /**
   * date.isoformat() and str(date)
   * @returns {string}
   */
  pyStr() { return `${pad(this.y, 4)}-${pad(this.m)}-${pad(this.d)}`; }

  /** @returns {bigint} the sort key, the ordinal */
  key() { return BigInt(this.ordinal()); }
}

function isoWeek1Monday(year) {
  const firstDay = ymdToOrd(year, 1, 1);
  const firstWeekday = (firstDay + 6) % 7;
  let week1Monday = firstDay - firstWeekday;
  if (firstWeekday > 3) week1Monday += 7;
  return week1Monday;
}

/** A datetime.datetime, naive or with a fixed-offset timezone. */
class PyDateTime {
  /**
   * datetime(y, mo, d, h, mi, s, us, tz).
   * @param {number} y
   * @param {number} mo
   * @param {number} d
   * @param {number} [h]
   * @param {number} [mi]
   * @param {number} [s]
   * @param {number} [us]
   * @param {PyTimezone|null} [tz]
   * @throws {Error} pyName ValueError, like CPython, for a field out of range, TypeError for a non-integer one
   */
  constructor(y, mo, d, h = 0, mi = 0, s = 0, us = 0, tz = null) {
    checkDateFields(y, mo, d);
    checkTimeFields(h, mi, s, us);
    Object.assign(this, { y, mo, d, h, mi, s, us, tz });
    this.kind = 'datetime';
  }

  /**
   * datetime.combine(date, time.min)
   * @param {PyDate} date
   * @returns {PyDateTime}
   */
  static fromDate(date) { return new PyDateTime(date.y, date.m, date.d); }

  /**
   * datetime.date()
   * @returns {PyDate}
   */
  date() { return new PyDate(this.y, this.mo, this.d); }

  /**
   * datetime.replace(tzinfo=tz)
   * @param {PyTimezone|null} tz
   * @returns {PyDateTime}
   */
  withTz(tz) { return new PyDateTime(this.y, this.mo, this.d, this.h, this.mi, this.s, this.us, tz); }

  /** @returns {bigint} microseconds from 0001-01-01T00:00 to the wall-clock value */
  wallMicros() {
    return BigInt(ymdToOrd(this.y, this.mo, this.d) - 1) * US_PER_DAY
      + BigInt((this.h * 60 + this.mi) * 60 + this.s) * US_PER_SECOND + BigInt(this.us);
  }

  /**
   * The inverse of wallMicros().
   * @param {bigint} t microseconds since 0001-01-01T00:00, within the datetime range
   * @param {PyTimezone|null} [tz]
   * @returns {PyDateTime}
   */
  static fromWallMicros(t, tz = null) {
    const days = Number(t / US_PER_DAY);
    let rem = t % US_PER_DAY;
    const us = Number(rem % US_PER_SECOND);
    rem = Number(rem / US_PER_SECOND);
    const [y, m, d] = ordToYmd(days + 1);
    return new PyDateTime(y, m, d, Math.floor(rem / 3600), Math.floor((rem % 3600) / 60), rem % 60, us, tz);
  }

  /**
   * datetime + timedelta
   * @param {PyTimeDelta} delta
   * @returns {PyDateTime}
   * @throws {Error} pyName OverflowError for a result outside years 1 to 9999
   */
  plus(delta) {
    const t = this.wallMicros() + delta.total;
    if (t < 0n || t >= BigInt(ymdToOrd(MAXYEAR, 12, 31)) * US_PER_DAY) {
      throw pyError('OverflowError', 'date value out of range');
    }
    return PyDateTime.fromWallMicros(t, this.tz);
  }

  /**
   * datetime - datetime for two naive values.
   * @param {PyDateTime} other
   * @returns {PyTimeDelta}
   * @throws {Error} pyName OverflowError for a difference out of timedelta's range
   */
  minus(other) { return PyTimeDelta.fromMicroseconds(this.wallMicros() - other.wallMicros()); }

  /**
   * datetime.timetuple() (naive, so tm_isdst is -1).
   * @returns {number[]} the 9 struct_time fields
   */
  timetuple() {
    const ord = ymdToOrd(this.y, this.mo, this.d);
    return [this.y, this.mo, this.d, this.h, this.mi, this.s, (ord + 6) % 7, ord - ymdToOrd(this.y, 1, 1) + 1, -1];
  }

  /**
   * datetime.isoformat(sep); str(datetime) uses sep ' '.
   * @param {string} [sep]
   * @returns {string}
   */
  pyStr(sep = 'T') {
    let r = `${pad(this.y, 4)}-${pad(this.mo)}-${pad(this.d)}${sep}${pad(this.h)}:${pad(this.mi)}:${pad(this.s)}`;
    if (this.us) r += `.${pad(this.us, 6)}`;
    if (this.tz) r += this.tz.isoSuffix();
    return r;
  }

  /** @returns {bigint} the sort key: the UTC instant for an aware value, the wall clock for a naive one */
  key() { return this.wallMicros() - (this.tz ? this.tz.offset.total : 0n); }
}

function localDate(ms) {
  const dt = new Date(ms);
  const y = dt.getFullYear();
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const ord = ymdToOrd(y, m, d);
  const jan = new Date(y, 0, 1).getTimezoneOffset();
  const jul = new Date(y, 6, 1).getTimezoneOffset();
  const isdst = jan !== jul && dt.getTimezoneOffset() === Math.min(jan, jul) ? 1 : 0;
  return [y, m, d, dt.getHours(), dt.getMinutes(), dt.getSeconds(), (ord + 6) % 7, ord - ymdToOrd(y, 1, 1) + 1, isdst];
}

/**
 * time.localtime() as a 9-item struct_time array.
 * @returns {number[]}
 */
function localtime() { return localDate(Date.now()); }

/**
 * time.mktime(t): seconds since the epoch of a local-time struct_time (fields are normalised like C mktime).
 * @param {number[]} t
 * @returns {number}
 * @throws {Error} pyName OverflowError for a time the platform cannot represent
 */
function mktime(t) {
  const dt = new Date(0);
  dt.setFullYear(t[0], t[1] - 1, t[2]);
  dt.setHours(t[3], t[4], t[5], 0);
  const ms = dt.getTime();
  if (Number.isNaN(ms)) throw pyError('OverflowError', 'mktime argument out of range');
  return ms / 1000;
}

module.exports = {
  PyDate, PyDateTime, PyTimeDelta, PyTimezone, daysInMonth, isLeap, ymdToOrd, ordToYmd, localtime, mktime,
};
