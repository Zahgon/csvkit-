'use strict';
// Port of agate.data_types (agate 1.14.2, MIT): Boolean, Number, TimeDelta, Date, DateTime and Text, the casts
// agate.TypeTester tries in turn.

const { Decimal } = require('./decimal');
const { Locale, UnknownLocaleError } = require('./babel');
const { Calendar } = require('./parsedatetime');
const { parseDatetime } = require('./isodate');
const { PyDate, PyDateTime, PyTimeDelta } = require('./pydatetime');
const { pyStrip } = require('./pystr');
const { strptime } = require('./strptime');
const { timeparse } = require('./pytimeparse');
const { pyStr: pyStrBase, pyFloatRepr } = require('./pycsv');

const DEFAULT_NULL_VALUES = ['', 'na', 'n/a', 'none', 'null', '.'];
const DEFAULT_TRUE_VALUES = ['yes', 'y', 'true', 't', '1'];
const DEFAULT_FALSE_VALUES = ['no', 'n', 'false', 'f', '0'];
const DEFAULT_CURRENCY_SYMBOLS = ['؋', '$', 'ƒ', '៛', '¥', '₡', '₱', '£', '€', '¢', '﷼', '₪', '₩', '₭', '₮', '₦', '฿',
  '₤', '₫'];

/**
 * agate.exceptions.CastError: a value that a column type cannot cast.
 */
class CastError extends Error {
  /** @param {string} m the message */
  constructor(m) { super(m); this.pyName = 'agate.exceptions.CastError'; }
}

// str() of a value, for the messages agate formats with %s.
const pyStr = (v) => (v instanceof PyDateTime ? v.pyStr(' ') : pyStrBase(v));
const raisedAs = (e, names) => Boolean(e && names.includes(e.pyName));
// Python's `except Exception:`. The port raises every Python exception as an Error with a pyName; SystemExit
// (argparse's ExitError) has none, and an error without one is a fault in the port itself, so neither is caught.
const isPyException = (e) => Boolean(e && e.pyName);

/** agate.DataType */
class DataType {
  /**
   * @param {{nullValues?: string[]}} [options]
   */
  constructor({ nullValues = DEFAULT_NULL_VALUES } = {}) {
    this.nullValues = nullValues.map((v) => v.toLowerCase());
  }

  /**
   * DataType.test(d): whether cast() accepts the value.
   * @param {*} d
   * @returns {boolean}
   */
  test(d) {
    try {
      this.cast(d);
    } catch (e) {
      if (e instanceof CastError) return false;
      throw e;
    }
    return true;
  }
}

// str.strip(chars) for a single character.
function stripChar(s, ch) {
  let a = 0;
  let b = s.length;
  while (a < b && s.startsWith(ch, a)) a += ch.length;
  while (b - ch.length >= a && s.startsWith(ch, b - ch.length)) b -= ch.length;
  return s.slice(a, b);
}

/** agate.Boolean */
class BooleanType extends DataType {
  /** @param {{nullValues?: string[]}} [o] */
  constructor(o) {
    super(o);
    this.name = 'Boolean';
  }

  /**
   * Boolean.cast: True and False, 1 and 0, and the strings "yes", "y", "true", "t", "1" and their "no" counterparts
   * (case-insensitive, commas removed).
   * @param {*} d
   * @returns {boolean|null} null for a null value
   * @throws {CastError} for anything else
   */
  cast(d) {
    if (d === null || d === undefined) return null;
    if (typeof d === 'boolean') return d;
    if (d.pyInt !== undefined || d.isDecimal) {
      const n = d.isDecimal ? d : Decimal.fromInt(d.pyInt);
      if (!n.special && n.cmp(Decimal.fromInt(1)) === 0) return true;
      if (!n.special && n.isZero()) return false;
    }
    if (typeof d === 'string') {
      d = pyStrip(d.replace(/,/g, ''));
      const lower = d.toLowerCase();
      if (this.nullValues.includes(lower)) return null;
      if (DEFAULT_TRUE_VALUES.includes(lower)) return true;
      if (DEFAULT_FALSE_VALUES.includes(lower)) return false;
    }
    throw new CastError(`Can not convert value ${pyStr(d)} to bool.`);
  }
}

const POSITIVE = Decimal.fromInt(1);
const NEGATIVE = Decimal.fromInt(-1);

/** agate.Number */
class NumberType extends DataType {
  /**
   * @param {{locale?: string, noLeadingZeroes?: boolean, nullValues?: string[]}} [o]
   * @throws {UnknownLocaleError} for a locale Babel does not know
   */
  constructor(o = {}) {
    super(o);
    this.name = 'Number';
    this.locale = Locale.parse(o.locale === undefined ? 'en_US' : o.locale);
    this.noLeadingZeroes = o.noLeadingZeroes;
    [this.groupSymbol, this.decimalSymbol] = this.locale.numberSymbols();
  }

  /**
   * Number.cast: numbers as Decimal; strings after stripping "%", one leading "-", currency symbols and the
   * locale's group symbol, with its decimal symbol read as ".".
   * @param {*} d
   * @returns {Decimal|null} null for a null value
   * @throws {CastError} for a string Decimal cannot parse, or with leading zeroes under noLeadingZeroes
   */
  cast(d) {
    if (d === null || d === undefined) return null;
    if (d.isDecimal) return d;
    if (d.isPyFloat) return Decimal.parse(pyFloatRepr(d.value));
    if (d.pyInt !== undefined) return Decimal.fromInt(d.pyInt);
    if (typeof d === 'number') return Decimal.fromNumber(d);
    if (typeof d === 'boolean') return Decimal.fromInt(d ? 1 : 0);
    if (typeof d !== 'string') throw new CastError(`Can not parse value "${pyStr(d)}" as Decimal.`);
    d = pyStrip(d);
    if (this.nullValues.includes(d.toLowerCase())) return null;
    d = stripChar(d, '%');
    let sign = POSITIVE;
    if (d.length > 0 && d[0] === '-') {
      d = d.slice(1);
      sign = NEGATIVE;
    }
    for (const symbol of DEFAULT_CURRENCY_SYMBOLS) d = stripChar(d, symbol);
    d = d.split(this.groupSymbol).join('');
    d = d.split(this.decimalSymbol).join('.');
    const chars = [...d];
    if (this.noLeadingZeroes && chars.length > 1 && chars[0] === '0' && chars[1] !== '.') {
      throw new CastError(`Can not parse value "${d}" as Decimal without leading zeroes`);
    }
    const value = Decimal.parse(d);
    if (value !== null) {
      try {
        return value.mul(sign);
      } catch (e) {
        if (e.pyName !== 'decimal.InvalidOperation') throw e;
      }
    }
    throw new CastError(`Can not parse value "${d}" as Decimal.`);
  }
}

/** agate.Text */
class TextType extends DataType {
  /** @param {{nullValues?: string[]}} [o] */
  constructor(o) {
    super(o);
    this.name = 'Text';
  }

  /**
   * Text.cast: str() of the value.
   * @param {*} d
   * @returns {string|null} null for a null value
   */
  cast(d) {
    if (d === null || d === undefined) return null;
    if (typeof d === 'string' && this.nullValues.includes(pyStrip(d).toLowerCase())) return null;
    return pyStr(d);
  }
}

/** agate.TimeDelta */
class TimeDeltaType extends DataType {
  /** @param {{nullValues?: string[]}} [o] */
  constructor(o) {
    super(o);
    this.name = 'TimeDelta';
  }

  /**
   * TimeDelta.cast through pytimeparse.
   * @param {*} d
   * @returns {PyTimeDelta|null} null for a null value
   * @throws {CastError} for a value pytimeparse cannot read
   */
  cast(d) {
    if (d === null || d === undefined) return null;
    if (d instanceof PyTimeDelta) return d;
    if (typeof d !== 'string') throw new CastError(`Can not parse value "${pyStr(d)}" as timedelta.`);
    d = pyStrip(d);
    if (this.nullValues.includes(d.toLowerCase())) return null;
    const seconds = timeparse(d);
    if (seconds === null) throw new CastError(`Can not parse value "${d}" to as timedelta.`);
    return PyTimeDelta.make({ seconds });
  }
}

// datetime.strptime(d, format) as agate's Date and DateTime casts call it.
function castWithFormat(d, format) {
  try {
    return strptime(d, format);
  } catch (e) {
    if (raisedAs(e, ['ValueError', 'TypeError'])) throw new CastError(`Value "${d}" does not match date format.`);
    throw e;
  }
}

const ZERO_DT = new PyDateTime(1, 1, 1);

/** agate.Date */
class DateType extends DataType {
  /**
   * @param {{dateFormat?: string, nullValues?: string[]}} [o]
   */
  constructor(o = {}) {
    super(o);
    this.name = 'Date';
    this.dateFormat = o.dateFormat || null;
    this.parser = new Calendar();
  }

  /**
   * Date.cast: strptime with dateFormat, else parsedatetime's nlp() must match the whole string as a date without a
   * time.
   * @param {*} d
   * @returns {PyDate|null} null for a null value
   * @throws {CastError} for a value that is not such a date
   */
  cast(d) {
    if (d === null || d === undefined) return null;
    if (d instanceof PyDate) return d;
    if (typeof d !== 'string') throw new CastError(`Can not parse value "${pyStr(d)}" as date.`);
    d = pyStrip(d);
    if (this.nullValues.includes(d.toLowerCase())) return null;
    if (this.dateFormat) return castWithFormat(d, this.dateFormat).date();
    let result;
    try {
      result = this.parser.nlp(d, ZERO_DT);
    } catch (e) {
      if (raisedAs(e, ['TypeError', 'ValueError', 'OverflowError'])) {
        throw new CastError(`Value "${d}" does not match date format.`);
      }
      throw e;
    }
    // Unpacking `(value, ctx, _, _, matched_text), = result` fails unless there is exactly one match.
    if (result === null || result.length !== 1) throw new CastError(`Value "${d}" does not match date format.`);
    const [value, ctx, , , matchedText] = result[0];
    if (matchedText === d && ctx.hasDate && !ctx.hasTime) return value.date();
    throw new CastError(`Can not parse value "${d}" as date.`);
  }
}

/** agate.DateTime */
class DateTimeType extends DataType {
  /**
   * @param {{datetimeFormat?: string, nullValues?: string[]}} [o]
   */
  constructor(o = {}) {
    super(o);
    this.name = 'DateTime';
    this.datetimeFormat = o.datetimeFormat || null;
    const now = new Date();
    this.sourceTime = new PyDateTime(now.getFullYear(), now.getMonth() + 1, now.getDate());
    this.parser = new Calendar();
  }

  /**
   * DateTime.cast: strptime with datetimeFormat; else a date and time (or a date alone, at midnight) that
   * parsedatetime's nlp() matches as the whole string; else isodate.parse_datetime.
   * @param {*} d
   * @returns {PyDateTime|null} null for a null value
   * @throws {CastError} for a value none of those read
   */
  cast(d) {
    if (d === null || d === undefined) return null;
    if (d instanceof PyDateTime) return d;
    if (d instanceof PyDate) return PyDateTime.fromDate(d);
    if (typeof d !== 'string') throw new CastError(`Can not parse value "${pyStr(d)}" as datetime.`);
    d = pyStrip(d);
    if (this.nullValues.includes(d.toLowerCase())) return null;
    if (this.datetimeFormat) return castWithFormat(d, this.datetimeFormat);
    // agate runs `(_, _, _, _, matched_text), = nlp(...)` under `except Exception:`, which also covers the unpacking
    // failing for no match or several. isPyException() is that clause: every Python exception the port raises.
    let matchedText = null;
    try {
      const result = this.parser.nlp(d, this.sourceTime);
      if (result !== null && result.length === 1) [[, , , , matchedText]] = result;
    } catch (e) {
      if (!isPyException(e)) throw e;
    }
    if (matchedText !== null) {
      const [value, ctx] = this.parser.parseDT(d, this.sourceTime);
      if (matchedText === d && ctx.hasDate && ctx.hasTime) return value;
      if (matchedText === d && ctx.hasDate && !ctx.hasTime) return PyDateTime.fromDate(value.date());
    }
    // isodate.parse_datetime under `except Exception: pass`.
    try {
      return parseDatetime(d);
    } catch (e) {
      if (!isPyException(e)) throw e;
    }
    throw new CastError(`Can not parse value "${d}" as datetime.`);
  }
}

module.exports = {
  DEFAULT_NULL_VALUES, CastError, PyDate, PyDateTime, PyTimeDelta, BooleanType, NumberType, TextType, TimeDeltaType,
  DateType, DateTimeType, UnknownLocaleError,
};
