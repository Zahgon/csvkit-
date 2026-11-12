'use strict';
// Port of the parts of decimal.Decimal (CPython 3.11 Lib/_pydecimal.py, PSF licence) that csvkit and agate use:
// parsing, str(), comparison, +, -, *, /, sqrt, quantize and normalize in the default context (28 digits,
// ROUND_HALF_EVEN, Emax 999999, Emin -999999, InvalidOperation, DivisionByZero and Overflow trapped).

const { pyError } = require('./pyerrors');
const { pyStrip } = require('./pystr');
const { asciiDigits } = require('./pyunicode');

const PREC = 28;
const EMAX = 999999;
const EMIN = -999999;
const ETINY = EMIN - PREC + 1;

/**
 * Raises a trapped decimal signal the way the C decimal module reports it, e.g.
 * `decimal.InvalidOperation: [<class 'decimal.DivisionUndefined'>]`.
 * @param {string} signal the trapped signal class name
 * @param {string} [condition] the condition class listed in the message
 * @returns {never}
 * @throws {Error} pyName decimal.<signal>, always
 */
function raiseSignal(signal, condition = signal) {
  throw pyError(`decimal.${signal}`, `[<class 'decimal.${condition}'>]`);
}

function digitCount(n) {
  return n === 0n ? 1 : n.toString().length;
}

// Rescales coefficient `coef` (times 10**exp) to exponent `newExp`, rounding ROUND_HALF_EVEN.
function rescale(coef, exp, newExp) {
  if (newExp <= exp) return coef * 10n ** BigInt(exp - newExp);
  if (newExp - exp > digitCount(coef)) return 0n;
  const div = 10n ** BigInt(newExp - exp);
  let q = coef / div;
  const r2 = (coef % div) * 2n;
  if (r2 > div || (r2 === div && q % 2n === 1n)) q += 1n;
  return q;
}

/** decimal.Decimal: sign, integer coefficient and exponent, or an infinity or NaN. */
class Decimal {
  /**
   * @param {number} sign 0 or 1
   * @param {bigint} coef the non-negative coefficient (the payload for a NaN)
   * @param {number} exp the exponent
   * @param {null|'inf'|'nan'|'snan'} [special]
   */
  constructor(sign, coef, exp, special = null) {
    this.sign = sign;
    this.coef = coef;
    this.exp = exp;
    this.special = special;
    this.isDecimal = true;
  }

  /**
   * Decimal(str) as CPython's _decimal reads it: surrounding Python whitespace is ignored, every underscore is
   * dropped and Unicode decimal digits count as ASCII ones. Returns null where Python raises InvalidOperation.
   * @param {string} s
   * @returns {Decimal|null}
   */
  static parse(s) {
    let t = pyStrip(String(s)).replace(/_/g, '');
    if (/[^\x01-\x7f\p{Nd}]/u.test(t)) return null;
    t = asciiDigits(t);
    const m = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(t);
    if (!m) {
      const sp = /^([+-])?(?:(inf|infinity)|(s?)nan(\d*))$/i.exec(t);
      if (!sp) return null;
      const sign = sp[1] === '-' ? 1 : 0;
      if (sp[2]) return new Decimal(sign, 0n, 0, 'inf');
      return new Decimal(sign, BigInt(sp[4] || '0'), 0, sp[3] ? 'snan' : 'nan');
    }
    const sign = m[1] === '-' ? 1 : 0;
    const intPart = m[2] !== undefined ? m[2] : '';
    const frac = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    const exp = (m[5] ? parseInt(m[5], 10) : 0) - frac.length;
    return new Decimal(sign, BigInt(intPart + frac), exp);
  }

  /**
   * Decimal(repr(x)) for a Python float x (1000.0 becomes Decimal('1000.0')).
   * @param {number} n
   * @returns {Decimal}
   */
  static fromNumber(n) {
    return Decimal.parse(require('./pycsv').pyFloatRepr(n));
  }

  /**
   * Decimal(int).
   * @param {number|bigint} n an integer
   * @returns {Decimal}
   */
  static fromInt(n) {
    const b = BigInt(n);
    return new Decimal(b < 0n ? 1 : 0, b < 0n ? -b : b, 0);
  }

  /**
   * Rounds (sign, coef, exp) to `prec` significant digits, as Decimal._fix does.
   * @param {number} sign 0 or 1
   * @param {bigint} coef
   * @param {number} exp
   * @param {number} [prec] the precision, 28 by default
   * @returns {Decimal}
   * @throws {Error} pyName decimal.Overflow beyond the context's Emax
   */
  static round(sign, coef, exp, prec = PREC) {
    return new Decimal(sign, coef, exp).fix(prec);
  }

  /** @returns {string} the coefficient's decimal digits */
  get digits() { return this.coef.toString(); }

  /** @returns {boolean} whether this is a finite zero of either sign */
  isZero() { return !this.special && this.coef === 0n; }

  /**
   * Decimal.is_nan().
   * @returns {boolean} whether this is a quiet or signaling NaN
   */
  isNaN() { return this.special === 'nan' || this.special === 'snan'; }

  /**
   * Decimal.adjusted(): the exponent of the most significant digit.
   * @returns {number}
   */
  adjusted() { return this.exp + digitCount(this.coef) - 1; }

  /**
   * Decimal._fix: rounds to `prec` digits and enforces the exponent limits of the default context.
   * @param {number} [prec] the precision, 28 by default
   * @returns {Decimal}
   * @throws {Error} pyName decimal.Overflow beyond the context's Emax
   */
  fix(prec = PREC) {
    if (this.special) return this;
    const etiny = EMIN - prec + 1;
    const etop = EMAX - prec + 1;
    if (this.coef === 0n) {
      const newExp = Math.min(Math.max(this.exp, etiny), EMAX);
      return newExp === this.exp ? this : new Decimal(this.sign, 0n, newExp);
    }
    let expMin = digitCount(this.coef) + this.exp - prec;
    if (expMin > etop) raiseSignal('Overflow');
    expMin = Math.max(expMin, etiny);
    if (this.exp >= expMin) return this;
    let coef = rescale(this.coef, this.exp, expMin);
    let exp = expMin;
    if (digitCount(coef) > prec) {
      coef /= 10n;
      exp += 1;
      if (exp > etop) raiseSignal('Overflow');
    }
    return new Decimal(this.sign, coef, exp);
  }

  /**
   * str(Decimal): Decimal.__str__ with scientific notation for small and large exponents.
   * @returns {string}
   */
  pyStr() {
    const sign = this.sign ? '-' : '';
    if (this.special === 'inf') return `${sign}Infinity`;
    if (this.special) return `${sign}${this.special === 'snan' ? 'sNaN' : 'NaN'}${this.coef ? this.digits : ''}`;
    const int = this.digits;
    const leftdigits = this.exp + int.length;
    const dotplace = this.exp <= 0 && leftdigits > -6 ? leftdigits : 1;
    let intpart;
    let fracpart;
    if (dotplace <= 0) {
      intpart = '0';
      fracpart = `.${'0'.repeat(-dotplace)}${int}`;
    } else if (dotplace >= int.length) {
      intpart = int + '0'.repeat(dotplace - int.length);
      fracpart = '';
    } else {
      intpart = int.slice(0, dotplace);
      fracpart = `.${int.slice(dotplace)}`;
    }
    let exp = '';
    if (leftdigits !== dotplace) {
      const e = leftdigits - dotplace;
      exp = `E${e >= 0 ? '+' : '-'}${Math.abs(e)}`;
    }
    return sign + intpart + fracpart + exp;
  }

  /** @returns {string} str() of the value */
  toString() { return this.pyStr(); }

  /**
   * format(Decimal, 'f'): fixed-point notation showing every digit of the coefficient.
   * @returns {string}
   */
  toFixedString() {
    if (this.special) return this.pyStr();
    const int = this.digits;
    let body;
    if (this.exp >= 0) body = int + '0'.repeat(this.exp);
    else {
      const padded = int.padStart(-this.exp + 1, '0');
      body = `${padded.slice(0, padded.length + this.exp)}.${padded.slice(padded.length + this.exp)}`;
    }
    return (this.sign ? '-' : '') + body;
  }

  /**
   * float(Decimal).
   * @returns {number}
   * @throws {Error} pyName ValueError for a signaling NaN
   */
  toNumber() {
    if (this.special === 'snan') {
      throw pyError('ValueError', 'cannot convert signaling NaN to float');
    }
    if (this.special === 'nan') return NaN;
    if (this.special === 'inf') return this.sign ? -Infinity : Infinity;
    return Number(`${this.sign ? '-' : ''}${this.digits}e${this.exp}`);
  }

  /**
   * int(Decimal): truncates toward zero.
   * @returns {bigint}
   * @throws {Error} pyName OverflowError for an infinity, ValueError for a NaN
   */
  truncate() {
    if (this.special === 'inf') {
      throw pyError('OverflowError', 'cannot convert Infinity to integer');
    }
    if (this.special) {
      throw pyError('ValueError', 'cannot convert NaN to integer');
    }
    const magnitude = this.exp >= 0 ? this.coef * 10n ** BigInt(this.exp) : this.coef / 10n ** BigInt(-this.exp);
    return this.sign ? -magnitude : magnitude;
  }

  /**
   * The value with its sign flipped, unrounded (Decimal.copy_negate).
   * @returns {Decimal}
   */
  neg() { return new Decimal(this.sign ? 0 : 1, this.coef, this.exp, this.special); }

  /**
   * abs(Decimal): a NaN keeps its sign, a finite value is rounded to the context.
   * @returns {Decimal}
   * @throws {Error} pyName decimal.InvalidOperation for a signaling NaN
   */
  abs() {
    const nan = this.checkNans();
    if (nan) return nan;
    return new Decimal(0, this.coef, this.exp, this.special).fix();
  }

  /**
   * Decimal._check_nans: a signaling NaN raises; a quiet NaN operand is the result, its payload cut to the
   * precision's last digits (_fix_nan).
   * @param {Decimal} [other] the second operand of a binary operation
   * @returns {Decimal|null} the NaN result, or null when neither operand is a NaN
   * @throws {Error} pyName decimal.InvalidOperation for a signaling NaN operand
   */
  checkNans(other) {
    const operands = other ? [this, other] : [this];
    if (operands.some((d) => d.special === 'snan')) raiseSignal('InvalidOperation');
    const nan = operands.find((d) => d.special === 'nan');
    if (!nan) return null;
    if (digitCount(nan.coef) <= PREC) return nan;
    return new Decimal(nan.sign, nan.coef % 10n ** BigInt(PREC), 0, 'nan');
  }

  /**
   * Three-way comparison of the values; like `<` and `>` on Decimals, a NaN operand raises InvalidOperation.
   * @param {Decimal} o
   * @returns {number} -1, 0 or 1
   * @throws {Error} pyName decimal.InvalidOperation when either operand is a NaN
   */
  cmp(o) {
    if (this.isNaN() || o.isNaN()) raiseSignal('InvalidOperation');
    const rank = (d) => (d.special === 'inf' ? (d.sign ? -1 : 1) : 0);
    if (rank(this) !== rank(o)) return rank(this) < rank(o) ? -1 : 1;
    if (this.special) return 0;
    if (this.isZero() || o.isZero()) {
      if (this.isZero() && o.isZero()) return 0;
      return this.isZero() ? (o.sign ? 1 : -1) : (this.sign ? -1 : 1);
    }
    if (this.sign !== o.sign) return this.sign ? -1 : 1;
    if (this.adjusted() !== o.adjusted()) return (this.adjusted() < o.adjusted()) === !this.sign ? -1 : 1;
    const [a, b] = Decimal.align(this, o);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * Decimal.__eq__: a NaN equals nothing.
   * @param {Decimal} o
   * @returns {boolean}
   * @throws {Error} pyName decimal.InvalidOperation for a signaling NaN, as cmp()
   */
  equals(o) {
    if (this.isNaN() || o.isNaN()) return false;
    return this.cmp(o) === 0;
  }

  /**
   * Two finite values as signed coefficients over their common (smaller) exponent.
   * @param {Decimal} x
   * @param {Decimal} y
   * @returns {Array} [x's signed coefficient, y's signed coefficient, the common exponent]
   */
  static align(x, y) {
    const e = Math.min(x.exp, y.exp);
    const a = x.coef * 10n ** BigInt(x.exp - e) * (x.sign ? -1n : 1n);
    const b = y.coef * 10n ** BigInt(y.exp - e) * (y.sign ? -1n : 1n);
    return [a, b, e];
  }

  /**
   * Decimal.__add__, rounded to the context.
   * @param {Decimal} o
   * @returns {Decimal}
   * @throws {Error} pyName decimal.InvalidOperation for a signaling NaN or +Infinity plus -Infinity,
   *   decimal.Overflow beyond Emax
   */
  add(o) {
    const nan = this.checkNans(o);
    if (nan) return nan;
    if (this.special === 'inf') {
      if (o.special === 'inf' && this.sign !== o.sign) raiseSignal('InvalidOperation');
      return this;
    }
    if (o.special === 'inf') return o;
    let exp = Math.min(this.exp, o.exp);
    if (this.isZero() && o.isZero()) return new Decimal(this.sign & o.sign, 0n, exp).fix();
    if (this.isZero() || o.isZero()) {
      const other = this.isZero() ? o : this;
      exp = Math.max(exp, other.exp - PREC - 1);
      return new Decimal(other.sign, rescale(other.coef, other.exp, exp), exp).fix();
    }
    // _normalize: an operand entirely below the other's precision only counts as a sticky digit.
    const [big, small] = this.exp < o.exp ? [o, this] : [this, o];
    const floor = big.exp + Math.min(-1, digitCount(big.coef) - PREC - 2);
    const tail = digitCount(small.coef) + small.exp - 1 < floor ? new Decimal(small.sign, 1n, floor) : small;
    const [a, b, e] = Decimal.align(big, tail);
    const s = a + b;
    if (s === 0n) return new Decimal(0, 0n, exp).fix();
    return new Decimal(s < 0n ? 1 : 0, s < 0n ? -s : s, e).fix();
  }

  /**
   * Decimal.__sub__, rounded to the context.
   * @param {Decimal} o
   * @returns {Decimal}
   * @throws {Error} pyName decimal.InvalidOperation or decimal.Overflow, as add()
   */
  sub(o) {
    const nan = this.checkNans(o);
    if (nan) return nan;
    return this.add(o.neg());
  }

  /**
   * Decimal.__mul__, rounded to the context.
   * @param {Decimal} o
   * @returns {Decimal}
   * @throws {Error} pyName decimal.InvalidOperation for a signaling NaN or zero times infinity, decimal.Overflow
   *   beyond Emax
   */
  mul(o) {
    const nan = this.checkNans(o);
    if (nan) return nan;
    const sign = this.sign ^ o.sign;
    if (this.special === 'inf' || o.special === 'inf') {
      if (this.isZero() || o.isZero()) raiseSignal('InvalidOperation');
      return new Decimal(sign, 0n, 0, 'inf');
    }
    return new Decimal(sign, this.coef * o.coef, this.exp + o.exp).fix();
  }

  /**
   * Decimal.__truediv__, rounded to the context.
   * @param {Decimal} o the divisor
   * @returns {Decimal}
   * @throws {Error} pyName decimal.DivisionByZero for x / 0, decimal.InvalidOperation for 0 / 0 (DivisionUndefined),
   *   infinity / infinity or a signaling NaN, decimal.Overflow beyond Emax
   */
  div(o) {
    const nan = this.checkNans(o);
    if (nan) return nan;
    const sign = this.sign ^ o.sign;
    if (this.special === 'inf') {
      if (o.special === 'inf') raiseSignal('InvalidOperation');
      return new Decimal(sign, 0n, 0, 'inf');
    }
    if (o.special === 'inf') return new Decimal(sign, 0n, ETINY);
    if (o.isZero()) {
      if (this.isZero()) raiseSignal('InvalidOperation', 'DivisionUndefined');
      raiseSignal('DivisionByZero');
    }
    let coeff;
    let exp;
    if (this.isZero()) {
      coeff = 0n;
      exp = this.exp - o.exp;
    } else {
      const shift = digitCount(o.coef) - digitCount(this.coef) + PREC + 1;
      exp = this.exp - o.exp - shift;
      const num = shift >= 0 ? this.coef * 10n ** BigInt(shift) : this.coef;
      const den = shift >= 0 ? o.coef : o.coef * 10n ** BigInt(-shift);
      coeff = num / den;
      if (num % den) {
        if (coeff % 5n === 0n) coeff += 1n;
      } else {
        const idealExp = this.exp - o.exp;
        while (exp < idealExp && coeff % 10n === 0n) {
          coeff /= 10n;
          exp += 1;
        }
      }
    }
    return new Decimal(sign, coeff, exp).fix();
  }

  /**
   * Decimal.normalize(): rounds to the context precision and strips trailing zeros.
   * @returns {Decimal}
   * @throws {Error} pyName decimal.InvalidOperation for a signaling NaN, decimal.Overflow beyond Emax
   */
  normalize() {
    const nan = this.checkNans();
    if (nan) return nan;
    const dup = this.fix();
    if (dup.special) return dup;
    if (dup.coef === 0n) return new Decimal(dup.sign, 0n, 0);
    let c = dup.coef;
    let e = dup.exp;
    while (c % 10n === 0n && e < EMAX) {
      c /= 10n;
      e += 1;
    }
    return new Decimal(dup.sign, c, e);
  }

  /**
   * Decimal.quantize(Decimal(10) ** e) with ROUND_HALF_EVEN: rescales to exponent `e`.
   * @param {number} e the target exponent
   * @returns {Decimal}
   * @throws {Error} pyName decimal.InvalidOperation for an infinity or signaling NaN, an exponent outside the
   *   context, or a result needing more digits than the context precision
   */
  quantize(e) {
    if (this.special) {
      const nan = this.checkNans();
      if (nan) return nan;
      raiseSignal('InvalidOperation');
    }
    if (e < ETINY || e > EMAX) raiseSignal('InvalidOperation');
    if (this.coef === 0n) return new Decimal(this.sign, 0n, e).fix();
    if (this.adjusted() > EMAX || this.adjusted() - e + 1 > PREC) raiseSignal('InvalidOperation');
    const ans = new Decimal(this.sign, rescale(this.coef, this.exp, e), e);
    if (ans.adjusted() > EMAX || digitCount(ans.coef) > PREC) raiseSignal('InvalidOperation');
    return ans;
  }

  /**
   * Decimal.scaleb(n): moves the exponent by `n`.
   * @param {number} n
   * @returns {Decimal}
   * @throws {Error} pyName decimal.InvalidOperation for a signaling NaN, decimal.Overflow beyond Emax
   */
  scaleb(n) {
    const nan = this.checkNans();
    if (nan) return nan;
    if (this.special) return this;
    return new Decimal(this.sign, this.coef, this.exp + n).fix();
  }

  /** @returns {boolean} whether this is a finite whole number */
  isInteger() {
    if (this.special) return false;
    if (this.exp >= 0) return true;
    return this.coef % 10n ** BigInt(-this.exp) === 0n;
  }

  /**
   * Decimal.sqrt() in the default context.
   * @returns {Decimal}
   * @throws {Error} pyName decimal.InvalidOperation for a negative value or a signaling NaN
   */
  sqrt() {
    if (this.special) {
      const nan = this.checkNans();
      if (nan) return nan;
      if (this.sign) raiseSignal('InvalidOperation');
      return this;
    }
    if (this.coef === 0n) return new Decimal(this.sign, 0n, Math.floor(this.exp / 2)).fix();
    if (this.sign) raiseSignal('InvalidOperation');
    const prec = PREC + 1;
    const ndigits = digitCount(this.coef);
    let e = Math.floor(this.exp / 2);
    let c = this.coef;
    let l = (ndigits + 1) >> 1;
    if (this.exp & 1) {
      c *= 10n;
      l = (ndigits >> 1) + 1;
    }
    const shift = prec - l;
    let exact = true;
    if (shift >= 0) c *= 100n ** BigInt(shift);
    else {
      const div = 100n ** BigInt(-shift);
      exact = c % div === 0n;
      c /= div;
    }
    e -= shift;
    let n = 10n ** BigInt(prec);
    for (;;) {
      const q = c / n;
      if (n <= q) break;
      n = (n + q) >> 1n;
    }
    if (exact && n * n === c) {
      if (shift >= 0) n /= 10n ** BigInt(shift);
      else n *= 10n ** BigInt(-shift);
      e += shift;
    } else if (n % 5n === 0n) {
      n += 1n;
    }
    return new Decimal(0, n, e).fix();
  }
}

module.exports = { Decimal };
