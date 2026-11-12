'use strict';
// Port of CPython 3.11's Lib/_strptime.py for the C locale (TZ=UTC): datetime.strptime(data_string, format).

const { PyDate, PyDateTime, PyTimeDelta, PyTimezone, isLeap } = require('./pydatetime');
const { pyError } = require('./pyerrors');
const { SPACE, pyRepr } = require('./pystr');
const { asciiDigits } = require('./pyunicode');

const F_WEEKDAY = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const A_WEEKDAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const F_MONTH = ['', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];
const A_MONTH = ['', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const AM_PM = ['am', 'pm'];
const TIMEZONE_NAMES = [['utc', 'gmt'], []];
const LC_DATE_TIME = '%a %b %d %H:%M:%S %Y';
const LC_DATE = '%m/%d/%y';
const LC_TIME = '%H:%M:%S';

// TimeRE's directive patterns in Python syntax; a duplicated group name is reported against this text.
function seqToRE(values, directive) {
  const sorted = [...values].sort((a, b) => b.length - a.length);
  if (!sorted.some((v) => v !== '')) return '';
  return `(?P<${directive}>${sorted.join('|')})`;
}

const DIRECTIVES = {
  d: '(?P<d>3[0-1]|[1-2]\\d|0[1-9]|[1-9]| [1-9])',
  f: '(?P<f>[0-9]{1,6})',
  H: '(?P<H>2[0-3]|[0-1]\\d|\\d)',
  I: '(?P<I>1[0-2]|0[1-9]|[1-9])',
  G: '(?P<G>\\d\\d\\d\\d)',
  j: '(?P<j>36[0-6]|3[0-5]\\d|[1-2]\\d\\d|0[1-9]\\d|00[1-9]|[1-9]\\d|0[1-9]|[1-9])',
  m: '(?P<m>1[0-2]|0[1-9]|[1-9])',
  M: '(?P<M>[0-5]\\d|\\d)',
  S: '(?P<S>6[0-1]|[0-5]\\d|\\d)',
  U: '(?P<U>5[0-3]|[0-4]\\d|\\d)',
  w: '(?P<w>[0-6])',
  u: '(?P<u>[1-7])',
  V: '(?P<V>5[0-3]|0[1-9]|[1-4]\\d|\\d)',
  y: '(?P<y>\\d\\d)',
  Y: '(?P<Y>\\d\\d\\d\\d)',
  z: '(?P<z>[+-]\\d\\d:?[0-5]\\d(:?[0-5]\\d(\\.\\d{1,6})?)?|(?-i:Z))',
  A: seqToRE(F_WEEKDAY, 'A'),
  a: seqToRE(A_WEEKDAY, 'a'),
  B: seqToRE(F_MONTH.slice(1), 'B'),
  b: seqToRE(A_MONTH.slice(1), 'b'),
  p: seqToRE(AM_PM, 'p'),
  Z: seqToRE(TIMEZONE_NAMES.flat(), 'Z'),
  '%': '%',
};
DIRECTIVES.W = DIRECTIVES.U.replace('U', 'W');
DIRECTIVES.c = pattern(LC_DATE_TIME);
DIRECTIVES.x = pattern(LC_DATE);
DIRECTIVES.X = pattern(LC_TIME);

/** A format character after "%" that is not a directive (empty message for a "%" ending the format). */
class BadDirective extends Error {}

/**
 * TimeRE.pattern(format): the Python regular expression source for a strptime format.
 * @param {string} format
 * @returns {string}
 */
function pattern(format) {
  let processed = '';
  format = format.replace(/[\\.^$*+?(){}[\]|]/g, '\\$&').replace(new RegExp(`[${SPACE}]+`, 'gu'), '\\s+');
  while (format.includes('%')) {
    const i = format.indexOf('%') + 1;
    if (i >= format.length) throw new BadDirective();
    const directive = format[i];
    if (!Object.hasOwn(DIRECTIVES, directive)) throw new BadDirective(directive);
    processed += format.slice(0, i - 1) + DIRECTIVES[directive];
    format = format.slice(i + 1);
  }
  return processed + format;
}

// Translates the Python patterns built above (escaped literals, \d, \s, named groups, (?-i:Z)) for the u flag.
function toJs(source) {
  return source.replace(/\\(.)|\(\?P<|\(\?-i:Z\)/gsu, (tok, esc) => {
    if (tok === '(?P<') return '(?<';
    if (tok === '(?-i:Z)') return '(?<zUpper>Z)';
    if (esc === 'd') return '\\p{Nd}';
    if (esc === 's') return `[${SPACE}]`;
    return tok;
  });
}

// Python's re.compile() rejects a group name used twice.
function checkGroupNames(source) {
  const seen = new Map();
  let groups = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] !== '(') continue;
    if (source.startsWith('(?P<', i)) {
      groups++;
      const name = source.slice(i + 4, source.indexOf('>', i));
      if (seen.has(name)) {
        throw pyError('re.error', `redefinition of group name ${pyRepr(name)} as group ${groups}; `
          + `was group ${seen.get(name)} at position ${i + 4}`);
      }
      seen.set(name, groups);
    } else if (source[i + 1] !== '?') groups++;
  }
}

const cache = new Map();

/**
 * TimeRE.compile, cached per format.
 * @param {string} format
 * @returns {RegExp}
 * @throws {Error} pyName ValueError for a stray "%" or a bad directive
 */
function compile(format) {
  if (!cache.has(format)) {
    let source;
    try {
      source = pattern(format);
    } catch (e) {
      if (!(e instanceof BadDirective)) throw e;
      if (e.message === '') throw pyError('ValueError', `stray % in format '${format}'`);
      const bad = e.message === '\\' ? '%' : e.message;
      throw pyError('ValueError', `'${bad}' is a bad directive in format '${format}'`);
    }
    checkGroupNames(source);
    cache.set(format, new RegExp(`^(?:${toJs(source)})`, 'iu'));
  }
  return cache.get(format);
}

function calcJulianFromUW(year, weekOfYear, dayOfWeek, weekStartsMon) {
  let firstWeekday = new PyDate(year, 1, 1).weekday();
  if (!weekStartsMon) {
    firstWeekday = (firstWeekday + 1) % 7;
    dayOfWeek = (dayOfWeek + 1) % 7;
  }
  const week0Length = (7 - firstWeekday) % 7;
  if (weekOfYear === 0) return 1 + dayOfWeek - firstWeekday;
  return 1 + week0Length + 7 * (weekOfYear - 1) + dayOfWeek;
}

function calcJulianFromV(isoYear, isoWeek, isoWeekday) {
  const correction = ((new PyDate(isoYear, 1, 4).weekday() + 1) + 3);
  let ordinal = isoWeek * 7 + isoWeekday - correction;
  if (ordinal < 1) {
    ordinal += new PyDate(isoYear, 1, 1).ordinal();
    isoYear -= 1;
    ordinal -= new PyDate(isoYear, 1, 1).ordinal();
  }
  return [isoYear, ordinal];
}

const toInt = (s) => parseInt(asciiDigits(s), 10);
const indexOrRaise = (list, value) => {
  const i = list.indexOf(value);
  if (i < 0) throw pyError('ValueError', `${pyRepr(value)} is not in list`);
  return i;
};

/**
 * datetime.datetime.strptime(dataString, format) in the C locale.
 * @param {string} dataString
 * @param {string} format
 * @returns {PyDateTime}
 * @throws {Error} pyName ValueError for a bad format, text that does not match it, unconverted data left over, a
 *   field out of range, or an inconsistent combination of ISO week directives
 */
function strptime(dataString, format) {
  const found = compile(format).exec(dataString);
  if (!found || (found.groups && found.groups.zUpper !== undefined && found.groups.zUpper !== 'Z')) {
    throw pyError('ValueError', `time data ${pyRepr(dataString)} does not match format ${pyRepr(format)}`);
  }
  if (found[0].length !== dataString.length) {
    throw pyError('ValueError', `unconverted data remains: ${dataString.slice(found[0].length)}`);
  }
  let isoYear = null;
  let year = null;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let fraction = 0;
  let gmtoff = null;
  let gmtoffFraction = 0;
  let isoWeek = null;
  let weekOfYear = null;
  let weekOfYearStart = null;
  let weekday = null;
  let julian = null;
  const fd = Object.fromEntries(Object.entries(found.groups || {}).filter(([k, v]) => k !== 'zUpper' && v !== undefined));
  for (const key of Object.keys(fd)) {
    const v = fd[key];
    switch (key) {
      case 'y': year = toInt(v); year += year <= 68 ? 2000 : 1900; break;
      case 'Y': year = toInt(v); break;
      case 'G': isoYear = toInt(v); break;
      case 'm': month = toInt(v); break;
      case 'B': month = indexOrRaise(F_MONTH, v.toLowerCase()); break;
      case 'b': month = indexOrRaise(A_MONTH, v.toLowerCase()); break;
      case 'd': day = toInt(v); break;
      case 'H': hour = toInt(v); break;
      case 'I': {
        hour = toInt(v);
        const ampm = (fd.p || '').toLowerCase();
        if (ampm === '' || ampm === AM_PM[0]) {
          if (hour === 12) hour = 0;
        } else if (ampm === AM_PM[1] && hour !== 12) hour += 12;
        break;
      }
      case 'M': minute = toInt(v); break;
      case 'S': second = toInt(v); break;
      case 'f': fraction = parseInt(v.padEnd(6, '0'), 10); break;
      case 'A': weekday = indexOrRaise(F_WEEKDAY, v.toLowerCase()); break;
      case 'a': weekday = indexOrRaise(A_WEEKDAY, v.toLowerCase()); break;
      case 'w': weekday = toInt(v); weekday = weekday === 0 ? 6 : weekday - 1; break;
      case 'u': weekday = toInt(v) - 1; break;
      case 'j': julian = toInt(v); break;
      case 'U': case 'W': weekOfYear = toInt(v); weekOfYearStart = key === 'U' ? 6 : 0; break;
      case 'V': isoWeek = toInt(v); break;
      case 'z': {
        if (v === 'Z') { gmtoff = 0; break; }
        let z = [...asciiDigits(v)];
        if (z[3] === ':') {
          z.splice(3, 1);
          if (z.length > 5) {
            if (z[5] !== ':') throw pyError('ValueError', `Inconsistent use of : in ${v}`);
            z.splice(5, 1);
          }
        }
        z = z.join('');
        gmtoff = parseInt(z.slice(1, 3), 10) * 3600 + parseInt(z.slice(3, 5), 10) * 60 + (parseInt(z.slice(5, 7), 10) || 0);
        const remainder = z.slice(8);
        gmtoffFraction = parseInt(remainder.padEnd(6, '0'), 10);
        if (z.startsWith('-')) {
          gmtoff = -gmtoff;
          gmtoffFraction = -gmtoffFraction;
        }
        break;
      }
      default:
    }
  }
  if (year === null && isoYear !== null) {
    if (isoWeek === null || weekday === null) {
      throw pyError('ValueError', "ISO year directive '%G' must be used with the ISO week directive '%V' and a "
        + "weekday directive ('%A', '%a', '%w', or '%u').");
    }
    if (julian !== null) {
      throw pyError('ValueError', "Day of the year directive '%j' is not compatible with ISO year directive '%G'. "
        + "Use '%Y' instead.");
    }
  } else if (weekOfYear === null && isoWeek !== null) {
    if (weekday === null) {
      throw pyError('ValueError', "ISO week directive '%V' must be used with the ISO year directive '%G' and a "
        + "weekday directive ('%A', '%a', '%w', or '%u').");
    }
    throw pyError('ValueError', "ISO week directive '%V' is incompatible with the year directive '%Y'. Use the ISO "
      + "year '%G' instead.");
  }
  let leapYearFix = false;
  if (year === null && month === 2 && day === 29) {
    year = 1904;
    leapYearFix = true;
  } else if (year === null) year = 1900;
  if (julian === null && weekday !== null) {
    if (weekOfYear !== null) {
      julian = calcJulianFromUW(year, weekOfYear, weekday, weekOfYearStart === 0);
    } else if (isoYear !== null && isoWeek !== null) {
      [year, julian] = calcJulianFromV(isoYear, isoWeek, weekday + 1);
    }
    if (julian !== null && julian <= 0) {
      year -= 1;
      julian += isLeap(year) ? 366 : 365;
    }
  }
  if (julian === null) {
    // _strptime computes the day of the year here; date() raises ValueError for an impossible date.
    julian = new PyDate(year, month, day).ordinal() - new PyDate(year, 1, 1).ordinal() + 1;
  } else {
    ({ y: year, m: month, d: day } = PyDate.fromOrdinal(julian - 1 + new PyDate(year, 1, 1).ordinal()));
  }
  if (leapYearFix) year = 1900;
  let tz = null;
  if (gmtoff !== null) {
    tz = PyTimezone.checked(PyTimeDelta.make({ seconds: BigInt(gmtoff), microseconds: BigInt(gmtoffFraction) }),
      fd.Z || null);
  }
  return new PyDateTime(year, month, day, hour, minute, second, fraction, tz);
}

module.exports = { strptime };
