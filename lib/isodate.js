'use strict';
// Port of isodate.parse_datetime (isodate 0.7, BSD-3-Clause) with parse_date (4-digit years, not expanded),
// parse_time and build_tzinfo.

const { Decimal } = require('./decimal');
const { PyDate, PyDateTime, PyTimeDelta, PyTimezone } = require('./pydatetime');
const { pyError } = require('./pyerrors');

// build_date_regexps(4, False), in isodate's order.
const DATE_REGEXES = [
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})$/,
  /^(?<year>[0-9]{4})(?<month>[0-9]{2})(?<day>[0-9]{2})$/,
  /^(?<year>[0-9]{4})-W(?<week>[0-9]{2})-(?<day>[0-9]{1})$/,
  /^(?<year>[0-9]{4})W(?<week>[0-9]{2})(?<day>[0-9]{1})$/,
  /^(?<year>[0-9]{4})-(?<day>[0-9]{3})$/,
  /^(?<year>[0-9]{4})(?<day>[0-9]{3})$/,
  /^(?<year>[0-9]{4})-W(?<week>[0-9]{2})$/,
  /^(?<year>[0-9]{4})W(?<week>[0-9]{2})$/,
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})$/,
  /^(?<year>[0-9]{4})(?<month>[0-9]{2})$/,
  /^(?<year>[0-9]{4})$/,
  /^(?<century>[0-9]{2})$/,
];

const TZ_REGEX = '(?<tzname>(Z|(?<tzsign>[+-])(?<tzhour>[0-9]{2})(:?(?<tzmin>[0-9]{2}))?)?)';
const TIME_REGEXES = [
  'T?(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2}([,.][0-9]+)?)',
  'T?(?<hour>[0-9]{2})(?<minute>[0-9]{2})(?<second>[0-9]{2}([,.][0-9]+)?)',
  'T?(?<hour>[0-9]{2}):(?<minute>[0-9]{2}([,.][0-9]+)?)',
  'T?(?<hour>[0-9]{2})(?<minute>[0-9]{2}([,.][0-9]+)?)',
  'T?(?<hour>[0-9]{2}([,.][0-9]+)?)',
].map((r) => new RegExp(`^${r}${TZ_REGEX}$`));

const isoError = (msg) => pyError('isodate.isoerror.ISO8601Error', msg);
const int = (s) => parseInt(s, 10);

/**
 * isodate.parse_date(datestring)
 * @param {string} datestring
 * @returns {PyDate}
 */
function parseDate(datestring) {
  for (const pattern of DATE_REGEXES) {
    const match = pattern.exec(datestring);
    if (!match) continue;
    const g = match.groups;
    if ('century' in g) return new PyDate(int(g.century) * 100 + 1, 1, 1);
    if (!('month' in g)) {
      const ret = new PyDate(int(g.year), 1, 1);
      if ('week' in g) {
        const iso = ret.isocalendar();
        const days = 'day' in g ? int(g.day) : 1;
        return ret.plus(PyTimeDelta.make({
          weeks: BigInt(int(g.week) - (iso[1] === 1 ? 1 : 0)), days: BigInt(-iso[2] + days),
        }));
      }
      if ('day' in g) return ret.plus(PyTimeDelta.make({ days: BigInt(int(g.day) - 1) }));
      return ret;
    }
    const day = g.day === undefined ? 1 : int(g.day);
    return new PyDate(int(g.year), int(g.month) || 1, day);
  }
  throw isoError(`Unrecognised ISO 8601 date format: '${datestring}'`);
}

// Decimal.quantize(Decimal('.000001'), rounding=ROUND_FLOOR) for the non-negative values isodate reads.
function floorMicros(d) {
  return d.exp >= -6 ? d : new Decimal(d.sign, d.coef / 10n ** BigInt(-6 - d.exp), -6);
}

const decimalInt = (d) => Number(d.truncate());
const fraction = (d) => d.sub(Decimal.fromInt(d.truncate()));
const MILLION = Decimal.fromInt(1000000);
const SIXTY = Decimal.fromInt(60);

/**
 * isodate.parse_time(timestring) as [hour, minute, second, microsecond, tzinfo].
 * @param {string} timestring
 * @returns {Array}
 */
function parseTime(timestring) {
  for (const pattern of TIME_REGEXES) {
    const match = pattern.exec(timestring);
    if (!match) continue;
    const g = {};
    for (const [k, v] of Object.entries(match.groups)) g[k] = v === undefined ? v : v.replace(/,/g, '.');
    let tz = null;
    if (g.tzname === 'Z') tz = new PyTimezone(PyTimeDelta.make({}));
    else if (g.tzname) {
      const sign = g.tzsign === '-' ? -1n : 1n;
      tz = new PyTimezone(PyTimeDelta.make({ hours: sign * BigInt(g.tzhour), minutes: sign * BigInt(g.tzmin || 0) }));
    }
    let second;
    let minute;
    if ('second' in g) {
      second = floorMicros(Decimal.parse(g.second));
      minute = Decimal.parse(g.minute);
    } else if ('minute' in g) {
      minute = Decimal.parse(g.minute);
      second = floorMicros(fraction(minute).mul(SIXTY));
    } else {
      const hour = Decimal.parse(g.hour);
      minute = fraction(hour).mul(SIXTY);
      second = fraction(minute).mul(SIXTY);
    }
    const microsecond = fraction(second).mul(MILLION).quantize(0);
    return [decimalInt(Decimal.parse(g.hour)), decimalInt(minute), decimalInt(second), decimalInt(microsecond), tz];
  }
  throw isoError(`Unrecognised ISO 8601 time format: '${timestring}'`);
}

/**
 * isodate.parse_datetime(datetimestring)
 * @param {string} datetimestring
 * @returns {PyDateTime}
 * @throws {Error} pyName isodate.isoerror.ISO8601Error for text that is not an ISO 8601 date and time,
 *   ValueError or OverflowError for a field out of range
 */
function parseDatetime(datetimestring) {
  const parts = datetimestring.split('T');
  if (parts.length !== 2) {
    throw isoError(`ISO 8601 time designator 'T' missing. Unable to parse datetime string '${datetimestring}'`);
  }
  const date = parseDate(parts[0]);
  const [h, mi, s, us, tz] = parseTime(parts[1]);
  return new PyDateTime(date.y, date.m, date.d, h, mi, s, us, tz);
}

module.exports = { parseDatetime };
