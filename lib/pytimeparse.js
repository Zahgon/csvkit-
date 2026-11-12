'use strict';
// Port of pytimeparse.timeparse (pytimeparse 1.1.10, MIT): parse a time expression into a number of seconds.

const { Decimal } = require('./decimal');
const { SPACE, pyStrip } = require('./pystr');
const { asciiDigits, isDigit } = require('./pyunicode');

const S = `[${SPACE}]`;
const D = '\\p{Nd}';
const WEEKS = `(?<weeks>[${D}.]+)${S}*(?:w|wks?|weeks?)`;
const DAYS = `(?<days>[${D}.]+)${S}*(?:d|dys?|days?)`;
const HOURS = `(?<hours>[${D}.]+)${S}*(?:h|hrs?|hours?)`;
const MINS = `(?<mins>[${D}.]+)${S}*(?:m|(mins?)|(minutes?))`;
const SECS = `(?<secs>[${D}.]+)${S}*(?:s|secs?|seconds?)`;
const SEPARATORS = '[,/]';
const SECCLOCK = `:(?<secs>${D}{2}(?:\\.${D}+)?)`;
const MINCLOCK = `(?<mins>${D}{1,2}):(?<secs>${D}{2}(?:\\.${D}+)?)`;
const HOURCLOCK = `(?<hours>${D}+):(?<mins>${D}{2}):(?<secs>${D}{2}(?:\\.${D}+)?)`;
const DAYCLOCK = `(?<days>${D}+)[:-](?<hours>${D}{2}):(?<mins>${D}{2}):(?<secs>${D}{2}(?:\\.${D}+)?)`;
const OPT = (x) => `(?:${x})?`;
const OPTSEP = (x) => `(?:${x}${S}*(?:${SEPARATORS}${S}*)?)?`;

const TIMEFORMATS = [
  `${OPTSEP(WEEKS)}${S}*${OPTSEP(DAYS)}${S}*${OPTSEP(HOURS)}${S}*${OPTSEP(MINS)}${S}*${OPT(SECS)}`,
  MINCLOCK,
  `${OPTSEP(WEEKS)}${S}*${OPTSEP(DAYS)}${S}*${HOURCLOCK}`,
  DAYCLOCK,
  SECCLOCK,
];

const COMPILED_SIGN = new RegExp(`^${S}*(?<sign>[+-])?${S}*(?<unsigned>[\\s\\S]*)$`, 'u');
const COMPILED_TIMEFORMATS = TIMEFORMATS.map((f) => new RegExp(`^${S}*${f}${S}*$`, 'iu'));
const MULTIPLIERS = { weeks: 604800, days: 86400, hours: 3600, mins: 60, secs: 1 };

/**
 * pytimeparse.timeparse(sval): the signed number of seconds, as a bigint when every part is an integer (Python int),
 * otherwise a number (Python float); null when the expression is not recognised.
 * @param {string} sval
 * @returns {bigint|number|null}
 */
function timeparse(sval) {
  const signMatch = COMPILED_SIGN.exec(sval).groups;
  const sign = signMatch.sign === '-' ? -1 : 1;
  const unsigned = signMatch.unsigned;
  for (const timefmt of COMPILED_TIMEFORMATS) {
    const match = timefmt.exec(unsigned);
    if (!match || !pyStrip(match[0])) continue;
    const mdict = Object.entries(match.groups).filter(([, v]) => v !== undefined);
    if (mdict.every(([, v]) => isDigit(v))) {
      const total = mdict.reduce((acc, [k, v]) => acc + BigInt(MULTIPLIERS[k]) * BigInt(asciiDigits(v)), 0n);
      return BigInt(sign) * total;
    }
    const secs = match.groups.secs;
    if (secs === undefined || isDigit(secs)) {
      let sum = null;
      let valid = true;
      for (const [k, v] of mdict) {
        if (k === 'secs') continue;
        const dec = Decimal.parse(asciiDigits(v));
        if (dec === null) { valid = false; break; }
        const prod = Decimal.fromInt(MULTIPLIERS[k]).mul(dec);
        sum = sum === null ? prod : sum.add(prod);
      }
      if (!valid) continue;
      const whole = sum === null ? 0n : sum.truncate();
      return BigInt(sign) * (whole + (secs ? BigInt(asciiDigits(secs)) : 0n));
    }
    let sum = 0;
    let valid = true;
    for (const [k, v] of mdict) {
      const f = /^(?:\d+\.?\d*|\.\d+)$/.test(asciiDigits(v)) ? Number(asciiDigits(v)) : NaN;
      if (Number.isNaN(f)) { valid = false; break; }
      sum += MULTIPLIERS[k] * f;
    }
    if (valid) return sign * sum;
  }
  return null;
}

module.exports = { timeparse };
