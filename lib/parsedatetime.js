'use strict';
// Port of parsedatetime 2.6 (Apache-2.0): Calendar.nlp(), parse() and parseDT() in VERSION_CONTEXT_STYLE with the
// default Constants (no PyICU, so the en_US locale of pdt_locales/base.py), and parsedatetime.context.pdtContext.
// Struct times are 9-item arrays [year, month, day, hour, minute, second, weekday, yearday, isdst].

const { PyDateTime, PyTimeDelta, daysInMonth, localtime, mktime } = require('./pydatetime');
const { pyError } = require('./pyerrors');
const { SPACE, BOUNDARY: B, pyStrip, pyRepr } = require('./pystr');
const { strToInt, strToFloat } = require('./pyunicode');
const { pyFloatRepr } = require('./pycsv');

// pdtContext accuracy flags.
const ACU = {
  YEAR: 1, MONTH: 2, WEEK: 4, DAY: 8, HALFDAY: 16, HOUR: 32, MIN: 64, SEC: 128, NOW: 256,
};
const ACU_DATE = ACU.YEAR | ACU.MONTH | ACU.WEEK | ACU.DAY;
const ACU_TIME = ACU.HALFDAY | ACU.HOUR | ACU.MIN | ACU.SEC | ACU.NOW;
const ACCURACY_REVERSE_MAPPING = {
  year: ACU.YEAR, years: ACU.YEAR, month: ACU.MONTH, months: ACU.MONTH, week: ACU.WEEK, weeks: ACU.WEEK,
  day: ACU.DAY, days: ACU.DAY, halfday: ACU.HALFDAY, morning: ACU.HALFDAY, afternoon: ACU.HALFDAY,
  evening: ACU.HALFDAY, night: ACU.HALFDAY, tonight: ACU.HALFDAY, midnight: ACU.HALFDAY, hour: ACU.HOUR,
  hours: ACU.HOUR, min: ACU.MIN, minute: ACU.MIN, mins: ACU.MIN, minutes: ACU.MIN, sec: ACU.SEC, second: ACU.SEC,
  secs: ACU.SEC, seconds: ACU.SEC, now: ACU.NOW,
};

/** parsedatetime.context.pdtContext: which date and time parts a parse determined. */
class PdtContext {
  constructor() { this.accuracy = 0; }

  /**
   * pdtContext.updateAccuracy: adds accuracy flags, given as numbers or as names such as 'month'.
   * @param {...(number|string)} accuracy
   * @returns {void}
   * @throws {Error} pyName KeyError for an unknown name
   */
  updateAccuracy(...accuracy) {
    for (let acc of accuracy) {
      if (typeof acc !== 'number') acc = lookup(ACCURACY_REVERSE_MAPPING, acc);
      this.accuracy |= acc;
    }
  }

  /**
   * @param {PdtContext} context a nested context whose accuracy is merged in
   * @returns {void}
   */
  update(context) { this.updateAccuracy(context.accuracy); }

  /** @returns {boolean} whether a date part was parsed */
  get hasDate() { return Boolean(this.accuracy & ACU_DATE); }

  /** @returns {boolean} whether a time part was parsed */
  get hasTime() { return Boolean(this.accuracy & ACU_TIME); }

  /** @returns {boolean} whether anything was parsed */
  get hasDateOrTime() { return Boolean(this.accuracy); }
}

// dict[key], raising KeyError like Python.
function lookup(table, key) {
  if (!Object.hasOwn(table, key)) throw pyError('KeyError', pyRepr(key));
  return table[key];
}

// int(s) for the digit strings the patterns capture.
function pyInt(s) {
  if (s === null) {
    throw pyError('TypeError', "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'");
  }
  return strToInt(s);
}

// --- en_US locale data (pdt_locales/base.py and en_US.py) and the Constants built from it ---

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SHORT_WEEKDAYS = ['mon', 'tues|tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'];
const SHORT_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUMBERS = {
  zero: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20,
};
const UNITS = {
  seconds: ['second', 'seconds', 'sec', 'secs', 's'],
  minutes: ['minute', 'minutes', 'min', 'mins', 'm'],
  hours: ['hour', 'hours', 'hr', 'h'],
  days: ['day', 'days', 'dy', 'd'],
  weeks: ['week', 'weeks', 'wk', 'w'],
  months: ['month', 'months', 'mth'],
  years: ['year', 'years', 'yr', 'y'],
};
const MODIFIERS = {
  from: 1, before: -1, after: 1, ago: -1, prior: -1, prev: -1, last: -1, next: 1, previous: -1, 'end of': 0, this: 0,
  eod: 1, eom: 1, eoy: 1,
};
const DAY_OFFSETS = { tomorrow: 1, today: 0, yesterday: -1 };
const RE_SOURCES = {
  noon: { hr: 12, mn: 0, sec: 0 },
  afternoon: { hr: 13, mn: 0, sec: 0 },
  lunch: { hr: 12, mn: 0, sec: 0 },
  morning: { hr: 6, mn: 0, sec: 0 },
  breakfast: { hr: 8, mn: 0, sec: 0 },
  dinner: { hr: 19, mn: 0, sec: 0 },
  evening: { hr: 18, mn: 0, sec: 0 },
  midnight: { hr: 0, mn: 0, sec: 0 },
  night: { hr: 21, mn: 0, sec: 0 },
  tonight: { hr: 21, mn: 0, sec: 0 },
  eod: { hr: 17, mn: 0, sec: 0 },
};
const NOW = ['now', 'right now'];
const MERIDIAN = ['AM', 'PM'];
const DP_ORDER = ['m', 'd', 'y'];
const YEAR_PARSE_STYLE = 1;
const DOW_PARSE_STYLE = 1;
const CURRENT_DOW_PARSE_STYLE = false;
const BIRTHDAY_EPOCH = 50;
const START_HOUR = 9;

// _initSymbols(): the am and pm spellings.
const [AM, PM] = MERIDIAN.map((xm) => {
  const lxm = xm.toLowerCase();
  return [xm, xm[0], `${xm[0]}.${xm[1]}.`, lxm, lxm[0], `${lxm[0]}.${lxm[1]}.`];
});

const splitBars = (list) => list.flatMap((d) => d.split('|'));
const escape = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const reJoin = (list) => list.map(escape).join('|');

function buildOffsets(lists, indexStart) {
  const offsets = {};
  for (const list of lists) {
    list.forEach((key, i) => {
      for (const k of key.split('|')) offsets[k] = indexStart + i;
    });
  }
  return offsets;
}
const WEEKDAY_OFFSETS = buildOffsets([WEEKDAYS, SHORT_WEEKDAYS], 0);
const MONTH_OFFSETS = buildOffsets([MONTHS, SHORT_MONTHS], 1);

const RV = {
  timeseparator: ':',
  daysuffix: 'rd|st|nd|th',
  meridian: 'am|pm|a\\.m\\.|p\\.m\\.|a|p',
  qunits: 'h|m|s|d|w|y',
  months: reJoin(splitBars(MONTHS)),
  shortmonths: reJoin(splitBars(SHORT_MONTHS)),
  days: reJoin(splitBars(WEEKDAYS)),
  shortdays: reJoin(splitBars(SHORT_WEEKDAYS)),
  dayoffsets: reJoin(Object.keys(DAY_OFFSETS)),
  numbers: reJoin(Object.keys(NUMBERS)),
  decimal_mark: '\\.',
  units: reJoin(Object.values(UNITS).flat().sort((a, b) => b.length - a.length)),
  modifiers: reJoin(Object.keys(MODIFIERS)),
  sources: reJoin(Object.keys(RE_SOURCES)),
  timecomponents: reJoin([':', ...MERIDIAN]),
};

// The Constants regular expressions, translated from Python (re.IGNORECASE | re.VERBOSE) for the iu flags.
const S = `[${SPACE}]`;
const D = '\\p{Nd}';
const LEAD = `([${SPACE}(\\["'-]|^)`;
const DATE_SEPS = '/\\.\\-\\.';
const NOT_TIME = `(?!${S}*(?:${RV.timecomponents}))`;
const cre = (source) => new RegExp(source, 'iud');
const CRE = {
  UNITS: cre(`${B}(?<qty>-?(?:${D}+(?:${RV.decimal_mark}${D}+|)|(?:${RV.numbers})${B})${S}*(?<units>${RV.units}))${B}`),
  QUNITS: cre(`${B}(?<qty>-?(?:${D}+(?:${RV.decimal_mark}${D}+|)|(?:${RV.numbers})${S}+)${S}*`
    + `(?<qunits>${RV.qunits}))${B}`),
  MODIFIER: cre(`${B}(?:${RV.modifiers})${B}`),
  TIMEHMS: cre(`${LEAD}(?<hours>${D}${D}?)(?<tsep>${RV.timeseparator}|)(?<minutes>${D}${D})`
    + `(?:\\k<tsep>(?<seconds>${D}${D}(?:[\\.,]${D}+)?))?${B}`),
  TIMEHMS2: cre(`${LEAD}(?<hours>${D}${D}?)(?:(?<tsep>${RV.timeseparator}|)(?<minutes>${D}${D}?)`
    + `(?:\\k<tsep>(?<seconds>${D}${D}?(?:[\\.,]${D}+)?))?)?${S}*(?<meridian>${RV.meridian})${B}`),
  DATE: cre(`${LEAD}(?<date>${D}${D}?[${DATE_SEPS}]${D}${D}?(?:[${DATE_SEPS}]${D}${D}(?:${D}${D})?)?`
    + `|${D}{4}[${DATE_SEPS}]${D}${D}?[${DATE_SEPS}]${D}${D}?)${B}`),
  DATE2: cre(`[${DATE_SEPS}]`),
  DAY: cre(`${B}(?:${RV.dayoffsets})${B}`),
  DAY2: cre(`(?<day>${D}${D}?)(?<suffix>${RV.daysuffix})?`),
  TIME: cre(`${B}(?:${RV.sources})${B}`),
  WEEKDAY: cre(`${B}(?:${RV.days}|${RV.shortdays})${B}`),
  NUMBER: new RegExp(`(${B}(?:${RV.numbers})${B}|${D}+(?:${RV.decimal_mark}${D}+|))`, 'giud'),
  UNITS_ONLY: cre(`${B}(${RV.units})${B}`),
  NLP_PREFIX: cre(`${B}(?<nlp_prefix>(on)(${S})+1|(at|in)(${S})+2|(in)(${S})+3)`),
  REMAINING: cre(`${S}+`),
};

// RE_DATE3 repeats a three-way alternation {1,3} times and ends with the conditional (?(mthname)|$-^). Python keeps
// each group's capture from the last iteration that set it, which JavaScript does not, so the repetition is driven
// here: each alternative matches at most one way at a given position, and the iterations backtrack greedily.
const DATE3_ALTERNATIVES = [
  `(?:^|${S}+)(?<mthname>${RV.months}|${RV.shortmonths})${B}`,
  `(?:^|${S}+)(?<day>[1-9]|[012]${D}|3[01])(?<suffix>${RV.daysuffix}|)${B}${NOT_TIME}`,
  `,?${S}+(?<year>${D}${D}(?:${D}${D}|))${B}${NOT_TIME}`,
].map((source) => new RegExp(source, 'iudy'));

/** A Python re.Match over a JavaScript exec() result made with the d (indices) flag. */
class Match {
  /** @param {RegExpExecArray} m an exec() result with indices */
  constructor(m) { this.m = m; }

  /**
   * @param {number|string} [g] a group number or name
   * @returns {number[]} [start, end], [-1, -1] for a group that did not take part
   */
  span(g = 0) {
    const ix = typeof g === 'number' ? this.m.indices[g] : this.m.indices.groups[g];
    return ix ? [ix[0], ix[1]] : [-1, -1];
  }

  /**
   * @param {number|string} [g]
   * @returns {number}
   */
  start(g = 0) { return this.span(g)[0]; }

  /**
   * @param {number|string} [g]
   * @returns {number}
   */
  end(g = 0) { return this.span(g)[1]; }

  /**
   * @param {number|string} [g]
   * @returns {string|null} the group's text, null for a group that did not take part
   */
  group(g = 0) {
    const v = typeof g === 'number' ? this.m[g] : this.m.groups[g];
    return v === undefined ? null : v;
  }
}

function search(re, s) {
  const m = re.exec(s);
  return m ? new Match(m) : null;
}

// re.match(): anchored at the start of the string.
function matchStart(re, s) {
  const m = search(re, s);
  return m && m.start() === 0 ? m : null;
}

/** The CRE_DATE3 match with Python's group semantics; its whole match is the 'date' group. */
class Date3Match {
  /**
   * @param {string} s the searched text
   * @param {number} start
   * @param {number} end
   * @param {Object<string, {start: number, end: number, text: string}>} groups the groups that took part
   */
  constructor(s, start, end, groups) {
    Object.assign(this, { s, startPos: start, endPos: end, groups });
  }

  /**
   * @param {number|string} [g]
   * @returns {number} -1 for a group that did not take part
   */
  start(g = 0) { return g === 0 || g === 'date' ? this.startPos : (this.groups[g] ? this.groups[g].start : -1); }

  /**
   * @param {number|string} [g]
   * @returns {number} -1 for a group that did not take part
   */
  end(g = 0) { return g === 0 || g === 'date' ? this.endPos : (this.groups[g] ? this.groups[g].end : -1); }

  /**
   * @param {number|string} [g]
   * @returns {string|null}
   */
  group(g = 0) {
    if (g === 0 || g === 'date') return this.s.slice(this.startPos, this.endPos);
    return this.groups[g] ? this.groups[g].text : null;
  }
}

function date3Iterations(s, pos, count, groups) {
  for (const re of DATE3_ALTERNATIVES) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) continue;
    const g = { ...groups };
    for (const [name, ix] of Object.entries(m.indices.groups)) {
      if (ix) g[name] = { start: ix[0], end: ix[1], text: m.groups[name] };
    }
    const end = pos + m[0].length;
    if (count < 3) {
      const r = date3Iterations(s, end, count + 1, g);
      if (r) return r;
    }
    if (g.mthname) return { end, groups: g };
  }
  return null;
}

function searchDate3(s) {
  for (let pos = 0; pos <= s.length; pos++) {
    const r = date3Iterations(s, pos, 1, {});
    if (r) return new Date3Match(s, pos, r.end, r.groups);
  }
  return null;
}

// Python's re.sub() helpers used by parse() and nlp().
const W = '[\\p{L}\\p{N}_]';
const PARSE_SUBS = [
  [new RegExp(`(${W})\\.(${S})`, 'gu'), '$1$2'],
  [new RegExp(`(${W})['"](${S}|$)`, 'gu'), '$1 $2'],
  [new RegExp(`(${S}|^)['"](${W})`, 'gu'), '$1 $2'],
];
const NLP_SUBS = [
  new RegExp(`(${W})(\\.)(${S})`, 'gu'),
  new RegExp(`(${W})('|")(${S}|$)`, 'gu'),
  new RegExp(`(${S}|^)('|")(${W})`, 'gu'),
];

// time.struct_time helpers.
const tuple = (yr, mth, dy, hr, mn, sec, wd, yd, isdst) => [yr, mth, dy, hr, mn, sec, wd, yd, isdst];
const toDatetime = (t) => new PyDateTime(t[0], t[1], t[2], t[3], t[4], t[5]);
const days = (n) => PyTimeDelta.make({ days: typeof n === 'number' && Number.isInteger(n) ? BigInt(n) : n });

// Constants.getSource()
function getSource(sourceKey, sourceTime) {
  if (!Object.hasOwn(RE_SOURCES, sourceKey)) return null;
  const [yr, mth, dy, hr, mn, sec, wd, yd, isdst] = sourceTime;
  const src = RE_SOURCES[sourceKey];
  const pick = (k, d) => (k in src ? src[k] : d);
  return tuple(pick('yr', yr), pick('mth', mth), pick('dy', dy), pick('hr', hr), pick('mn', mn), pick('sec', sec),
    wd, yd, isdst);
}

function extractTime(m) {
  if (!m) return [0, 0, 0];
  const hours = m.group('hours');
  if (!hours) return [0, 0, 0];
  const minutes = pyInt(m.group('minutes'));
  let seconds = m.group('seconds');
  seconds = seconds ? pyInt(seconds.replace(/,/g, '.').split('.')[0]) : 0;
  return [pyInt(hours), minutes, seconds];
}

function popTimeAccuracy(m, ctx) {
  if (!m) return;
  if (m.group('hours')) ctx.updateAccuracy(ACU.HOUR);
  if (m.group('minutes')) ctx.updateAccuracy(ACU.MIN);
  if (m.group('seconds')) ctx.updateAccuracy(ACU.SEC);
}

function calculateDOWDelta(wd, wkdy, offset, style, currentDayStyle) {
  const diffBase = wkdy - wd;
  if (offset === 2) {
    if (wkdy * style > wd * style || (currentDayStyle && wkdy === wd)) offset = 0;
    else if (style === -1 || style === 1) offset = style;
    else offset = 0;
  }
  let diff = diffBase + 7 * offset;
  if (style === 1 && diff < -7) diff += 7;
  else if (style === -1 && diff > 7) diff -= 7;
  return diff;
}

function quantityToReal(quantity) {
  if (!quantity) return 1.0;
  try {
    return strToFloat(quantity.replace(/,/g, '.'));
  } catch (e) {
    if (e.pyName !== 'ValueError') throw e;
  }
  return Object.hasOwn(NUMBERS, quantity) ? NUMBERS[quantity] : 0.0;
}

/** parsedatetime.Calendar(version=VERSION_CONTEXT_STYLE) with the default en_US constants. */
class Calendar {
  /** Creates a calendar with an empty context stack. */
  constructor() { this.ctxStack = []; }

  /**
   * Calendar.currentContext: the innermost open context.
   * @returns {PdtContext}
   * @throws {Error} pyName RuntimeError when no context is open
   */
  get currentContext() {
    if (!this.ctxStack.length) throw pyError('RuntimeError', 'context stack is empty');
    return this.ctxStack[this.ctxStack.length - 1];
  }

  /**
   * Calendar.context(): runs fn in a new context and merges it into the enclosing one. An exception leaves the
   * context on the stack, as the Python context manager does.
   * @param {function(PdtContext): *} fn
   * @returns {*} what fn returns
   */
  withContext(fn) {
    const ctx = new PdtContext();
    this.ctxStack.push(ctx);
    const result = fn(ctx);
    this.ctxStack.pop();
    if (this.ctxStack.length) this.currentContext.update(ctx);
    return result;
  }

  /**
   * Calendar._buildTime: source moved by quantity units; an OverflowError leaves it unchanged.
   * @param {number[]} source the struct_time to start from
   * @param {string|null} quantity the quantity text, e.g. "3" or "a"
   * @param {string} modifier unused, as in the original
   * @param {string} units the unit word as written
   * @returns {number[]} the struct_time
   * @throws {Error} pyName ValueError for a quantity datetime cannot use
   */
  buildTime(source, quantity, modifier, units) {
    const ctx = this.currentContext;
    quantity = quantity === null ? '' : pyStrip(quantity);
    const qty = quantityToReal(quantity);
    const start = toDatetime(source);
    let target = start;
    let realunit = units;
    for (const [key, values] of Object.entries(UNITS)) {
      if (values.includes(units)) {
        realunit = key;
        break;
      }
    }
    try {
      if (realunit === 'years' || realunit === 'months') {
        target = this.inc(start, realunit === 'months' ? qty : null, realunit === 'years' ? qty : null);
      } else if (['days', 'hours', 'minutes', 'seconds', 'weeks'].includes(realunit)) {
        target = start.plus(PyTimeDelta.make({ [realunit]: qty }));
      }
      ctx.updateAccuracy(realunit);
    } catch (e) {
      if (e.pyName !== 'OverflowError') throw e;
    }
    return target.timetuple();
  }

  /**
   * Calendar.parseDate: a numeric date such as "5/23" or "2024-05-23", read in the en_US month-day-year order.
   * @param {string} dateString
   * @param {number[]} sourceTime the struct_time that supplies the missing fields
   * @returns {number[]} the struct_time, or time.localtime() for an invalid date
   * @throws {Error} pyName ValueError or TypeError for a captured field int() cannot read
   */
  parseDate(dateString, sourceTime) {
    let [yr, mth, dy, hr, mn, sec, wd, yd, isdst] = sourceTime;
    let v1 = -1;
    let v2 = -1;
    let v3 = -1;
    const accuracy = [];
    let s = dateString;
    let m = search(CRE.DATE2, s);
    if (m) {
      v1 = pyInt(s.slice(0, m.start()));
      s = s.slice(m.start() + 1);
    }
    m = search(CRE.DATE2, s);
    if (m) {
      v2 = pyInt(s.slice(0, m.start()));
      v3 = pyInt(s.slice(m.start() + 1));
    } else {
      v2 = pyInt(pyStrip(s));
    }
    const v = [v1, v2, v3];
    const d = { m: mth, d: dy, y: yr };
    const order = v1 <= 31 ? DP_ORDER : ['y', 'm', 'd'];
    for (let i = 0; i < 3; i++) {
      if (v[i] >= 0) {
        d[order[i]] = v[i];
        accuracy.push({ m: ACU.MONTH, d: ACU.DAY, y: ACU.YEAR }[order[i]]);
      }
    }
    if (v3 === -1 && (mth > d.m || (mth === d.m && dy > d.d))) yr = d.y + YEAR_PARSE_STYLE;
    else yr = d.y;
    mth = d.m;
    dy = d.d;
    if (yr < BIRTHDAY_EPOCH) yr += 2000;
    else if (yr < 100) yr += 1900;
    return this.withContext((ctx) => {
      if (mth > 0 && mth <= 12 && dy > 0 && dy <= daysInMonth(yr, mth)) {
        ctx.updateAccuracy(...accuracy);
        return tuple(yr, mth, dy, hr, mn, sec, wd, yd, isdst);
      }
      return localtime();
    });
  }

  /**
   * Calendar.parseDateText: a date with a month name, such as "May 23rd, 2024".
   * @param {string} dateString
   * @param {number[]} sourceTime the struct_time that supplies the missing fields
   * @returns {number[]} the struct_time, or time.localtime() for an invalid day
   * @throws {Error} pyName AttributeError when the text has no month-name date, as the original's unguarded
   *   match.group() raises
   */
  parseDateText(dateString, sourceTime) {
    let [yr, mth, dy, hr, mn, sec, wd, yd, isdst] = sourceTime;
    const currentMth = mth;
    const currentDy = dy;
    const accuracy = [];
    const m = searchDate3(dateString.toLowerCase());
    if (!m) throw pyError('AttributeError', "'NoneType' object has no attribute 'group'");
    mth = lookup(MONTH_OFFSETS, m.group('mthname'));
    accuracy.push('month');
    if (m.group('day') !== null) {
      dy = pyInt(m.group('day'));
      accuracy.push('day');
    } else dy = 1;
    if (m.group('year') !== null) {
      yr = pyInt(m.group('year'));
      accuracy.push('year');
      if (yr < BIRTHDAY_EPOCH) yr += 2000;
      else if (yr < 100) yr += 1900;
    } else if (mth < currentMth || (mth === currentMth && dy < currentDy)) yr += YEAR_PARSE_STYLE;
    return this.withContext((ctx) => {
      if (dy > 0 && dy <= daysInMonth(yr, mth)) {
        ctx.updateAccuracy(...accuracy);
        return tuple(yr, mth, dy, hr, mn, sec, wd, yd, isdst);
      }
      return localtime();
    });
  }

  /**
   * Calendar._evalModifier: applies "next", "last", "this", "end of" and the like to the unit or weekday after it.
   * @param {string} modifier
   * @param {string} chunk1 the text before the modifier
   * @param {string} chunk2 the text after it
   * @param {number[]} sourceTime
   * @returns {Array} [the text left to parse, the new struct_time]
   * @throws {Error} pyName KeyError for an unknown modifier, ValueError or OverflowError when the result leaves
   *   datetime's range
   */
  evalModifier(modifier, chunk1, chunk2, sourceTime) {
    const ctx = this.currentContext;
    const offset = lookup(MODIFIERS, modifier);
    let [yr, mth, dy, hr, mn, sec, wd, yd, isdst] = sourceTime;
    const m = search(CRE.REMAINING, chunk2);
    let unit;
    if (m) {
      unit = chunk2.slice(0, m.start());
      chunk2 = chunk2.slice(m.start() + 1);
    } else {
      unit = chunk2;
      chunk2 = '';
    }
    // MODIFIERS holds only -1, 0 and 1, so the offset == 2 branches of the original never run.
    if (UNITS.months.includes(unit)) {
      if (offset === 0) {
        dy = daysInMonth(yr, mth);
        sourceTime = tuple(yr, mth, dy, START_HOUR, 0, 0, wd, yd, isdst);
      } else {
        sourceTime = this.inc(new PyDateTime(yr, mth, 1, START_HOUR, 0, 0), offset, null).timetuple();
      }
      ctx.updateAccuracy(ACU.MONTH);
    } else if (UNITS.weeks.includes(unit)) {
      if (offset === 0) {
        sourceTime = new PyDateTime(yr, mth, dy, 17, 0, 0).plus(days(4 - wd)).timetuple();
      } else {
        sourceTime = new PyDateTime(yr, mth, dy, START_HOUR, 0, 0)
          .plus(PyTimeDelta.make({ weeks: BigInt(offset) })).timetuple();
      }
      ctx.updateAccuracy(ACU.WEEK);
    } else if (UNITS.days.includes(unit)) {
      if (offset === 0) {
        sourceTime = tuple(yr, mth, dy, 17, 0, 0, wd, yd, isdst);
        ctx.updateAccuracy(ACU.HALFDAY);
      } else {
        sourceTime = new PyDateTime(yr, mth, dy, START_HOUR, 0, 0).plus(days(offset)).timetuple();
      }
      ctx.updateAccuracy(ACU.DAY);
    } else if (UNITS.hours.includes(unit)) {
      if (offset === 0) sourceTime = tuple(yr, mth, dy, hr, 0, 0, wd, yd, isdst);
      else {
        sourceTime = new PyDateTime(yr, mth, dy, hr, 0, 0).plus(PyTimeDelta.make({ hours: BigInt(offset) }))
          .timetuple();
      }
      ctx.updateAccuracy(ACU.HOUR);
    } else if (UNITS.years.includes(unit)) {
      if (offset === 0) sourceTime = tuple(yr, 12, 31, hr, mn, sec, wd, yd, isdst);
      else sourceTime = tuple(yr + offset, 1, 1, START_HOUR, 0, 0, wd, yd, isdst);
      ctx.updateAccuracy(ACU.YEAR);
    } else if (modifier === 'eom') {
      sourceTime = tuple(yr, mth, daysInMonth(yr, mth), START_HOUR, 0, 0, wd, yd, isdst);
      ctx.updateAccuracy(ACU.DAY);
    } else if (modifier === 'eoy') {
      sourceTime = tuple(yr, 12, daysInMonth(yr, 12), START_HOUR, 0, 0, wd, yd, isdst);
      ctx.updateAccuracy(ACU.MONTH);
    } else if (matchStart(CRE.WEEKDAY, unit)) {
      const wkdyText = matchStart(CRE.WEEKDAY, unit).group();
      if (modifier === 'eod') {
        ctx.updateAccuracy(ACU.HOUR);
        [sourceTime] = this.parse(wkdyText, sourceTime);
        const sTime = getSource(modifier, sourceTime);
        if (sTime !== null) {
          sourceTime = sTime;
          ctx.updateAccuracy(ACU.HALFDAY);
        }
      } else {
        const relativeModifier = !['this', 'next', 'last', 'prior', 'previous'].includes(modifier);
        const dowOffset = relativeModifier ? 0 : offset;
        const wkdy = lookup(WEEKDAY_OFFSETS, wkdyText);
        const diff = calculateDOWDelta(wd, wkdy, dowOffset, DOW_PARSE_STYLE, CURRENT_DOW_PARSE_STYLE);
        const start = new PyDateTime(yr, mth, dy, START_HOUR, 0, 0);
        let target = start.plus(days(diff));
        if (chunk1 !== '' && relativeModifier) {
          const [t, subctx] = this.parse(chunk1, sourceTime);
          if (subctx.hasDateOrTime) {
            const delta = mktime(t) - mktime(sourceTime);
            target = start.plus(days(diff)).plus(PyTimeDelta.make({ seconds: delta * offset }));
            chunk1 = '';
          }
        }
        sourceTime = target.timetuple();
      }
      ctx.updateAccuracy(ACU.DAY);
    } else if (chunk1 === '' && chunk2 === '' && matchStart(CRE.TIME, unit)) {
      const [t] = this.parse(unit, null);
      sourceTime = toDatetime(t).plus(days(offset)).timetuple();
    } else {
      unit = pyStrip(unit);
      if (unit) {
        let [t, subctx] = this.parse(`${unit} ${chunk2}`, sourceTime);
        if (subctx.hasDate) {
          const u = unit.toLowerCase();
          if (MONTHS.includes(u) || SHORT_MONTHS.includes(u)) {
            t = this.inc(toDatetime(t), null, offset).timetuple();
          } else if (WEEKDAYS.includes(u)) {
            throw pyError('TypeError', 'can only concatenate tuple (not "datetime.timedelta") to tuple');
          }
        }
        if (subctx.hasDateOrTime) {
          sourceTime = t;
          chunk2 = '';
        }
      }
      chunk1 = pyStrip(chunk1);
      if (chunk1) {
        const numbers = [...chunk1.matchAll(CRE.NUMBER)];
        if (numbers.length) {
          const n = new Match(numbers[numbers.length - 1]);
          const qty = quantityToReal(n.group()) * offset;
          chunk1 = `${chunk1.slice(0, n.start())}${pyFloatRepr(qty)}${chunk1.slice(n.end())}`;
        }
        const [t, subctx] = this.parse(chunk1, sourceTime);
        chunk1 = '';
        if (subctx.hasDateOrTime) sourceTime = t;
      }
      const sTime = getSource(modifier, sourceTime);
      if (sTime !== null) {
        sourceTime = sTime;
        ctx.updateAccuracy(ACU.HALFDAY);
      }
    }
    return [`${chunk1} ${chunk2}`, sourceTime];
  }

  // _evalDT() returns sourceTime unchanged whenever it is set, which parse() guarantees, so the _eval* methods
  // below start from sourceTime directly.

  /**
   * Calendar._evalUnits and _evalQUnits: "3 days", "5h" and the like, relative to sourceTime.
   * @param {string} datetimeString
   * @param {number[]} sourceTime
   * @param {'units'|'qunits'} group which unit pattern applies
   * @returns {number[]} the struct_time
   * @throws {Error} pyName UnboundLocalError when the pattern does not match, as the original
   */
  evalUnits(datetimeString, sourceTime, group) {
    const s = pyStrip(datetimeString);
    const m = search(group === 'units' ? CRE.UNITS : CRE.QUNITS, s);
    if (!m) {
      throw pyError('UnboundLocalError', "cannot access local variable 'quantity' where it is not associated with a value");
    }
    return this.buildTime(sourceTime, s.slice(0, m.start(group)), '', m.group(group));
  }

  /**
   * Calendar._evalDayStr: "today", "tomorrow", "yesterday" and the like.
   * @param {string} datetimeString
   * @param {number[]} sourceTime
   * @returns {number[]} the struct_time
   * @throws {Error} pyName OverflowError when the result leaves datetime's range
   */
  evalDayStr(datetimeString, sourceTime) {
    const s = pyStrip(datetimeString);
    const [yr, mth, dy] = sourceTime;
    const offset = Object.hasOwn(DAY_OFFSETS, s) ? DAY_OFFSETS[s] : 0;
    this.currentContext.updateAccuracy(ACU.DAY);
    return new PyDateTime(yr, mth, dy, START_HOUR, 0, 0).plus(days(offset)).timetuple();
  }

  /**
   * Calendar._evalWeekday: a weekday name, as the next such day.
   * @param {string} datetimeString
   * @param {number[]} sourceTime
   * @returns {number[]} the struct_time
   * @throws {Error} pyName KeyError for a name that is not a weekday, OverflowError when the result leaves
   *   datetime's range
   */
  evalWeekday(datetimeString, sourceTime) {
    const s = pyStrip(datetimeString);
    const [yr, mth, dy, hr, mn, sec, wd] = sourceTime;
    const start = new PyDateTime(yr, mth, dy, hr, mn, sec);
    const wkdy = lookup(WEEKDAY_OFFSETS, s);
    const qty = calculateDOWDelta(wd, wkdy, 2, DOW_PARSE_STYLE, CURRENT_DOW_PARSE_STYLE);
    this.currentContext.updateAccuracy(ACU.DAY);
    return start.plus(days(qty)).timetuple();
  }

  /**
   * Calendar._evalTimeStr: "now", "noon", "midnight" and the like.
   * @param {string} datetimeString
   * @param {number[]} sourceTime
   * @returns {number[]} the struct_time
   */
  evalTimeStr(datetimeString, sourceTime) {
    const s = pyStrip(datetimeString);
    if (NOW.includes(s)) this.currentContext.updateAccuracy(ACU.NOW);
    else {
      const sTime = getSource(s, sourceTime);
      if (sTime) sourceTime = sTime;
      this.currentContext.updateAccuracy(ACU.HALFDAY);
    }
    return sourceTime;
  }

  /**
   * Calendar._evalMeridian: a time with am or pm.
   * @param {string} datetimeString
   * @param {number[]} sourceTime
   * @returns {number[]} the struct_time
   * @throws {Error} pyName ValueError or TypeError for a captured field int() cannot read
   */
  evalMeridian(datetimeString, sourceTime) {
    const s = pyStrip(datetimeString);
    let [yr, mth, dy, hr, mn, sec, wd, yd, isdst] = sourceTime;
    const m = search(CRE.TIMEHMS2, s);
    if (m) {
      const dt = pyStrip(s.slice(0, m.start('meridian')));
      if ([...dt].length <= 2) {
        hr = pyInt(dt);
        mn = 0;
        sec = 0;
      } else [hr, mn, sec] = extractTime(m);
      if (hr === 24) hr = 0;
      const meridian = m.group('meridian').toLowerCase();
      if (AM.includes(meridian) && hr === 12) hr = 0;
      if (PM.includes(meridian) && hr < 12) hr += 12;
    }
    if (hr < 24 && mn < 60 && sec < 60) {
      sourceTime = tuple(yr, mth, dy, hr, mn, sec, wd, yd, isdst);
      popTimeAccuracy(m, this.currentContext);
    }
    return sourceTime;
  }

  /**
   * Calendar._evalTimeStd: a 24-hour time such as "17:30:05".
   * @param {string} datetimeString
   * @param {number[]} sourceTime
   * @returns {number[]} the struct_time
   * @throws {Error} pyName ValueError or TypeError for a captured field int() cannot read
   */
  evalTimeStd(datetimeString, sourceTime) {
    const s = pyStrip(datetimeString);
    let [yr, mth, dy, hr, mn, sec, wd, yd, isdst] = sourceTime;
    const m = search(CRE.TIMEHMS, s);
    if (m) [hr, mn, sec] = extractTime(m);
    if (hr === 24) hr = 0;
    if (hr < 24 && mn < 60 && sec < 60) {
      sourceTime = tuple(yr, mth, dy, hr, mn, sec, wd, yd, isdst);
      popTimeAccuracy(m, this.currentContext);
    }
    return sourceTime;
  }

  /**
   * Calendar._UnitsTrapped: whether a units match is really a day with a suffix, such as "1st" or "3rd".
   * @param {string} s
   * @param {object} m the units match
   * @param {string} key the match group of the unit
   * @returns {boolean}
   */
  static unitsTrapped(s, m, key) {
    const m2 = search(CRE.DAY2, s);
    if (!m2) return false;
    const t = `${m2.group('day')}${m.group(key)}`;
    return m.start(key) === m2.start('suffix') && m.start('qty') === m2.start('day') && m.group('qty') === t;
  }

  /**
   * Calendar._partialParseModifier. Like every _partialParse* step it returns [text left to parse, struct_time,
   * whether this step matched].
   * @param {string} s
   * @param {number[]} sourceTime
   * @returns {Array}
   * @throws {Error} as evalModifier()
   */
  partialParseModifier(s, sourceTime) {
    let parseStr = null;
    let chunk1 = '';
    let chunk2 = '';
    const m = search(CRE.MODIFIER, s);
    if (m) {
      if (m.group() !== s) {
        parseStr = m.group();
        chunk1 = pyStrip(s.slice(0, m.start()));
        chunk2 = pyStrip(s.slice(m.end()));
      } else parseStr = s;
    }
    if (parseStr) [s, sourceTime] = this.evalModifier(parseStr, chunk1, chunk2, sourceTime);
    return [s, sourceTime, Boolean(parseStr)];
  }

  /**
   * Calendar._partialParseUnits and _partialParseQUnits.
   * @param {string} s
   * @param {number[]} sourceTime
   * @param {'units'|'qunits'} group
   * @returns {Array} [text left to parse, struct_time, whether this step matched]
   * @throws {Error} as evalUnits()
   */
  partialParseUnits(s, sourceTime, group) {
    let parseStr = null;
    const m = search(group === 'units' ? CRE.UNITS : CRE.QUNITS, s);
    if (m && !Calendar.unitsTrapped(s, m, group)) {
      if (m.group('qty') !== s) {
        parseStr = m.group('qty');
        let chunk1 = pyStrip(s.slice(0, m.start('qty')));
        const chunk2 = pyStrip(s.slice(m.end('qty')));
        if (chunk1.slice(-1) === '-') {
          parseStr = `-${parseStr}`;
          chunk1 = chunk1.slice(0, -1);
        }
        s = `${chunk1} ${chunk2}`;
      } else {
        parseStr = s;
        s = '';
      }
    }
    if (parseStr) sourceTime = this.evalUnits(parseStr, sourceTime, group);
    return [s, sourceTime, Boolean(parseStr)];
  }

  /**
   * Calendar._partialParseDateStr: a date with a month name.
   * @param {string} s
   * @param {number[]} sourceTime
   * @returns {Array} [text left to parse, struct_time, whether this step matched]
   * @throws {Error} as parseDateText()
   */
  partialParseDateStr(s, sourceTime) {
    let parseStr = null;
    const m = searchDate3(s);
    if (m) {
      if (m.group('date') !== s) {
        const mStart = m.start('date');
        let mEnd = m.end('date');
        let fTime = false;
        let mm = search(CRE.TIMEHMS2, s);
        const mYear = m.group('year');
        if (mm && mYear !== null) fTime = true;
        else {
          mm = search(CRE.TIMEHMS, s);
          if (mm && mYear === null) fTime = true;
        }
        if (fTime) {
          const hoursStart = mm.start('hours');
          if (hoursStart < m.end('year')) mEnd = hoursStart;
        }
        parseStr = s.slice(mStart, mEnd);
        s = `${s.slice(0, mStart)} ${s.slice(mEnd)}`;
      } else {
        parseStr = s;
        s = '';
      }
    }
    if (parseStr) sourceTime = this.parseDateText(pyStrip(parseStr), sourceTime);
    return [s, sourceTime, Boolean(parseStr)];
  }

  /**
   * The shape _partialParseDateStd, _partialParseDayStr and _partialParseTimeStr share: find the pattern, cut the
   * match out of the text and evaluate it.
   * @param {string} s
   * @param {number[]} sourceTime
   * @param {object} re the compiled pattern
   * @param {string} groupName the group holding the matched text
   * @param {function(string, number[]): number[]} evaluate the _eval* step for the match
   * @param {boolean} [extraMatch] evaluate the whole text even without a match
   * @returns {Array} [text left to parse, struct_time, whether this step matched]
   * @throws {Error} whatever evaluate raises
   */
  partialParseSimple(s, sourceTime, re, groupName, evaluate, extraMatch = false) {
    let parseStr = null;
    const m = search(re, s);
    if (m || extraMatch) {
      if (m && m.group(groupName) !== s) {
        parseStr = m.group(groupName);
        s = `${s.slice(0, m.start(groupName))} ${s.slice(m.end(groupName))}`;
      } else {
        parseStr = s;
        s = '';
      }
    }
    if (parseStr) sourceTime = evaluate(parseStr, sourceTime);
    return [s, sourceTime, Boolean(parseStr)];
  }

  /**
   * Calendar._partialParseWeekday.
   * @param {string} s
   * @param {number[]} sourceTime
   * @returns {Array} [text left to parse, struct_time, whether this step matched]
   * @throws {Error} as evalWeekday()
   */
  partialParseWeekday(s, sourceTime) {
    let parseStr = null;
    const ctx = this.currentContext;
    const m = search(CRE.WEEKDAY, s);
    if (m && !Object.hasOwn(DAY_OFFSETS, s)) {
      const gv = m.group();
      if (gv !== s) {
        parseStr = gv;
        s = `${s.slice(0, m.start())} ${s.slice(m.end())}`;
      } else {
        parseStr = s;
        s = '';
      }
    }
    if (parseStr && !ctx.hasDate) sourceTime = this.evalWeekday(parseStr, sourceTime);
    return [s, sourceTime, Boolean(parseStr)];
  }

  /**
   * Calendar._partialParseMeridian.
   * @param {string} s
   * @param {number[]} sourceTime
   * @returns {Array} [text left to parse, struct_time, whether this step matched]
   * @throws {Error} as evalMeridian()
   */
  partialParseMeridian(s, sourceTime) {
    let parseStr = null;
    const m = search(CRE.TIMEHMS2, s);
    if (m) {
      if (m.group('minutes') !== null) {
        parseStr = m.group('seconds') !== null
          ? `${m.group('hours')}:${m.group('minutes')}:${m.group('seconds')}`
          : `${m.group('hours')}:${m.group('minutes')}`;
      } else parseStr = m.group('hours');
      parseStr += ` ${m.group('meridian')}`;
      s = `${s.slice(0, m.start())} ${s.slice(m.end())}`;
    }
    if (parseStr) sourceTime = this.evalMeridian(parseStr, sourceTime);
    return [s, sourceTime, Boolean(parseStr)];
  }

  /**
   * Calendar._partialParseTimeStd.
   * @param {string} s
   * @param {number[]} sourceTime
   * @returns {Array} [text left to parse, struct_time, whether this step matched]
   * @throws {Error} as evalTimeStd()
   */
  partialParseTimeStd(s, sourceTime) {
    let parseStr = null;
    const m = search(CRE.TIMEHMS, s);
    if (m) {
      const last = m.group('seconds') !== null ? 'seconds' : 'minutes';
      parseStr = m.group('seconds') !== null
        ? `${m.group('hours')}:${m.group('minutes')}:${m.group('seconds')}`
        : `${m.group('hours')}:${m.group('minutes')}`;
      s = `${s.slice(0, m.start('hours'))} ${s.slice(m.end(last))}`;
    }
    if (parseStr) sourceTime = this.evalTimeStd(parseStr, sourceTime);
    return [s, sourceTime, Boolean(parseStr)];
  }

  /**
   * Calendar.parse(datetimeString, sourceTime) in VERSION_CONTEXT_STYLE.
   * @param {string} datetimeString
   * @param {PyDateTime|number[]|null} sourceTime
   * @returns {[number[], PdtContext]} the struct_time and the context
   */
  parse(datetimeString, sourceTime) {
    for (const [re, rep] of PARSE_SUBS) datetimeString = datetimeString.replace(re, rep);
    if (sourceTime instanceof PyDateTime) sourceTime = sourceTime.timetuple();
    else if (!sourceTime) sourceTime = localtime();
    const methods = [
      (s, t) => this.partialParseModifier(s, t),
      (s, t) => this.partialParseUnits(s, t, 'units'),
      (s, t) => this.partialParseUnits(s, t, 'qunits'),
      (s, t) => this.partialParseDateStr(s, t),
      (s, t) => this.partialParseSimple(s, t, CRE.DATE, 'date', (p, st) => this.parseDate(pyStrip(p), st)),
      (s, t) => this.partialParseSimple(s, t, CRE.DAY, 0, (p, st) => this.evalDayStr(p, st)),
      (s, t) => this.partialParseWeekday(s, t),
      (s, t) => this.partialParseSimple(s, t, CRE.TIME, 0, (p, st) => this.evalTimeStr(p, st), NOW.includes(s)),
      (s, t) => this.partialParseMeridian(s, t),
      (s, t) => this.partialParseTimeStd(s, t),
    ];
    const ctx = this.withContext((context) => {
      let s = pyStrip(datetimeString.toLowerCase());
      while (s) {
        let matched = false;
        for (const method of methods) {
          const [retS, retTime, ok] = method(s, sourceTime);
          if (ok) {
            s = pyStrip(retS);
            sourceTime = retTime;
            matched = true;
            break;
          }
        }
        if (!matched) s = '';
      }
      return context;
    });
    return [sourceTime, ctx];
  }

  /**
   * Calendar.parseDT(datetimeString, sourceTime) with tzinfo None.
   * @param {string} datetimeString
   * @param {PyDateTime} sourceTime
   * @returns {[PyDateTime, PdtContext]}
   */
  parseDT(datetimeString, sourceTime) {
    const [t, ctx] = this.parse(datetimeString, sourceTime.timetuple());
    return [toDatetime(t), ctx];
  }

  /**
   * Calendar.inc(source, month, year): add (possibly fractional) months and years.
   * @param {PyDateTime} source
   * @param {number|null} month
   * @param {number|null} year
   * @returns {PyDateTime}
   * @throws {Error} pyName ValueError for a NaN count, OverflowError for an infinite one or a year outside 1 to 9999
   */
  inc(source, month, year) {
    let yr = source.y;
    let mth = source.mo;
    let dy = source.d;
    month = month === null ? 0 : month;
    month += (year === null ? 0 : year) * 12;
    let subMi = 0.0;
    let maxDay = 0;
    if (month) {
      if (Number.isNaN(month)) throw pyError('ValueError', 'cannot convert float NaN to integer');
      if (!Number.isFinite(month)) throw pyError('OverflowError', 'cannot convert float infinity to integer');
      const mi = Math.trunc(month);
      subMi = month - mi;
      let y = Math.trunc(mi / 12.0);
      const m = mi - y * 12;
      mth += m;
      if (mth < 1) {
        y -= 1;
        mth += 12;
      } else if (mth > 12) {
        y += 1;
        mth -= 12;
      }
      yr += y;
      maxDay = daysInMonth(yr, mth);
      if (dy > maxDay) dy = maxDay;
    }
    if (yr > 9999 || yr < 1) throw pyError('OverflowError', 'year is out of range');
    let d = new PyDateTime(yr, mth, dy, source.h, source.mi, source.s, source.us);
    if (subMi) d = d.plus(PyTimeDelta.make({ days: subMi * maxDay }));
    return d;
  }

  /**
   * Calendar.nlp(inputString, sourceTime): every date/time expression found, or null.
   * @param {string} inputString
   * @param {PyDateTime} sourceTime
   * @returns {Array|null} entries [datetime, context, start, end, matched text]
   */
  nlp(inputString, sourceTime) {
    const orig = inputString;
    inputString = inputString.replace(NLP_SUBS[0], '$1 $3').toLowerCase();
    inputString = inputString.replace(NLP_SUBS[1], '$1 $3');
    inputString = inputString.replace(NLP_SUBS[2], '$1 $3');
    let startpos = 0;
    const matches = [];
    while (startpos < inputString.length) {
      const leftmost = [0, 0, null, 0, null];
      const rest = inputString.slice(startpos);
      const consider = (start, end, text, flag, type) => {
        if (leftmost[1] === 0 || leftmost[0] > start + startpos) {
          leftmost.splice(0, 5, start + startpos, end + startpos, text, flag, type);
          return true;
        }
        return false;
      };
      let m = search(CRE.MODIFIER, rest);
      if (m) consider(m.start(), m.end(), m.group(), 0, 'modifier');
      for (const [re, key] of [[CRE.UNITS, 'units'], [CRE.QUNITS, 'qunits']]) {
        m = search(re, rest);
        if (m && !Calendar.unitsTrapped(rest, m, key) && consider(m.start('qty'), m.end('qty'), m.group('qty'), 3, key)) {
          const qtyStart = [...rest.slice(0, m.start('qty'))].length;
          if (qtyStart > 0 && [...inputString][qtyStart - 1] === '-') {
            leftmost[0] -= 1;
            leftmost[2] = `-${leftmost[2]}`;
          }
        }
      }
      m = searchDate3(rest);
      if (m) consider(m.start('date'), m.end('date'), m.group('date'), 1, 'dateStr');
      m = search(CRE.DATE, rest);
      if (m) consider(m.start('date'), m.end('date'), m.group('date'), 1, 'dateStd');
      m = search(CRE.DAY, rest);
      if (m) consider(m.start(), m.end(), m.group(), 1, 'dayStr');
      m = search(CRE.WEEKDAY, rest);
      if (m && !Object.hasOwn(DAY_OFFSETS, rest)) consider(m.start(), m.end(), m.group(), 1, 'weekdy');
      m = search(CRE.TIME, rest);
      if (m) consider(m.start(), m.end(), m.group(), 2, 'timeStr');
      m = search(CRE.TIMEHMS2, rest);
      if (m && consider(m.start('hours'), m.end('meridian'), null, 2, 'meridian')) {
        leftmost[2] = inputString.slice(leftmost[0], leftmost[1]);
      }
      m = search(CRE.TIMEHMS, rest);
      if (m) {
        const end = m.group('seconds') !== null ? m.end('seconds') : m.end('minutes');
        if (consider(m.start('hours'), end, null, 2, 'timeStd')) leftmost[2] = inputString.slice(leftmost[0], leftmost[1]);
      }
      if (matches.length && matches[matches.length - 1][3] === 0) {
        m = search(CRE.UNITS_ONLY, rest);
        if (m && pyStrip(rest.slice(0, m.start())) === '') consider(m.start(), m.end(), m.group(), 3, 'unitsOnly');
      }
      startpos = leftmost[1];
      if (startpos === 0) startpos = inputString.length;
      else {
        if (leftmost[3] > 0) {
          m = search(CRE.NLP_PREFIX, `${inputString.slice(0, leftmost[0])} ${leftmost[3]}`);
          if (m) {
            leftmost[0] = m.start('nlp_prefix');
            leftmost[2] = inputString.slice(leftmost[0], leftmost[1]);
          }
        }
        matches.push(leftmost);
      }
    }
    const proximity = [];
    const emit = (from, to, text) => {
      const [parsed, flags] = this.parse(text, sourceTime);
      proximity.push([toDatetime(parsed), flags, from, to, text]);
    };
    if (matches.length > 1) {
      let fromIndex = 0;
      let date = matches[0][3] === 1;
      let time = matches[0][3] === 2;
      let units = matches[0][3] === 3;
      for (let i = 1; i < matches.length; i++) {
        const endOfPrevious = matches[i - 1][1];
        const begOfCurrent = matches[i][0];
        if (pyStrip(orig.slice(endOfPrevious, begOfCurrent).toLowerCase()) !== '') {
          if (date || time || units) {
            emit(matches[fromIndex][0], matches[i - 1][1], orig.slice(matches[fromIndex][0], matches[i - 1][1]));
          }
          fromIndex = i;
          date = matches[i][3] === 1;
          time = matches[i][3] === 2;
          units = matches[i][3] === 3;
        } else {
          if (matches[i][3] === 1) date = true;
          if (matches[i][3] === 2) time = true;
          if (matches[i][3] === 3) units = true;
        }
      }
      if (date || time || units) {
        const last = matches[matches.length - 1][1];
        emit(matches[fromIndex][0], last, orig.slice(matches[fromIndex][0], last));
      }
    } else if (matches.length === 0) {
      return null;
    } else {
      if (matches[0][3] === 0) return null;
      const [parsed, flags] = this.parse(matches[0][2], sourceTime);
      proximity.push([toDatetime(parsed), flags, matches[0][0], matches[0][1], orig.slice(matches[0][0], matches[0][1])]);
    }
    return proximity;
  }
}

module.exports = { Calendar };
