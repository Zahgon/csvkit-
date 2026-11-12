'use strict';
// Port of CPython 3.11's `re` for str patterns: Lib/re/_parser.py (the parse tree and every re.error), the parts of
// Lib/re/_compiler.py that fix matching semantics (case folding, charsets, look-behind widths), and a backtracking
// matcher over the parse tree that follows Modules/_sre/sre_lib.h (CPython, PSF licence).

const { pyError } = require('./pyerrors');
const U = require('./unicode-data');
const { pyRepr } = require('./pystr');
const { inRanges, lookupName, pyInt } = require('./pyunicode');

const MAXREPEAT = 4294967295;
const MAXGROUPS = 1073741823;

const SRE_FLAG_TEMPLATE = 1;
const SRE_FLAG_IGNORECASE = 2;
const SRE_FLAG_LOCALE = 4;
const SRE_FLAG_MULTILINE = 8;
const SRE_FLAG_DOTALL = 16;
const SRE_FLAG_UNICODE = 32;
const SRE_FLAG_VERBOSE = 64;
const SRE_FLAG_DEBUG = 128;
const SRE_FLAG_ASCII = 256;

const FLAGS = {
  i: SRE_FLAG_IGNORECASE, L: SRE_FLAG_LOCALE, m: SRE_FLAG_MULTILINE, s: SRE_FLAG_DOTALL, x: SRE_FLAG_VERBOSE,
  a: SRE_FLAG_ASCII, t: SRE_FLAG_TEMPLATE, u: SRE_FLAG_UNICODE,
};
const TYPE_FLAGS = SRE_FLAG_ASCII | SRE_FLAG_LOCALE | SRE_FLAG_UNICODE;
const GLOBAL_FLAGS = SRE_FLAG_DEBUG | SRE_FLAG_TEMPLATE;

const SPECIAL_CHARS = '.\\[{()*+?^$|';
const REPEAT_CHARS = '*+?{';
const DIGITS = '0123456789';
const OCTDIGITS = '01234567';
const HEXDIGITS = '0123456789abcdefABCDEF';
const WHITESPACE = ' \t\n\r\x0b\f';
const REPEAT_CODES = new Set(['MIN_REPEAT', 'MAX_REPEAT', 'POSSESSIVE_REPEAT']);
const UNIT_CODES = new Set(['ANY', 'RANGE', 'IN', 'LITERAL', 'NOT_LITERAL', 'CATEGORY']);

const ESCAPES = {
  '\\a': ['LITERAL', 7], '\\b': ['LITERAL', 8], '\\f': ['LITERAL', 12], '\\n': ['LITERAL', 10],
  '\\r': ['LITERAL', 13], '\\t': ['LITERAL', 9], '\\v': ['LITERAL', 11], '\\\\': ['LITERAL', 92],
};
const CATEGORIES = {
  '\\A': ['AT', 'AT_BEGINNING_STRING'], '\\b': ['AT', 'AT_BOUNDARY'], '\\B': ['AT', 'AT_NON_BOUNDARY'],
  '\\d': ['IN', [['CATEGORY', 'DIGIT']]], '\\D': ['IN', [['CATEGORY', 'NOT_DIGIT']]],
  '\\s': ['IN', [['CATEGORY', 'SPACE']]], '\\S': ['IN', [['CATEGORY', 'NOT_SPACE']]],
  '\\w': ['IN', [['CATEGORY', 'WORD']]], '\\W': ['IN', [['CATEGORY', 'NOT_WORD']]],
  '\\Z': ['AT', 'AT_END_STRING'],
};

// re._casefix._EXTRA_CASES: lowercase characters that match other lowercase characters case-insensitively.
const EXTRA_CASES = new Map(Object.entries({
  0x69: [0x131], 0x73: [0x17f], 0xb5: [0x3bc], 0x131: [0x69], 0x17f: [0x73], 0x345: [0x3b9, 0x1fbe],
  0x390: [0x1fd3], 0x3b0: [0x1fe3], 0x3b2: [0x3d0], 0x3b5: [0x3f5], 0x3b8: [0x3d1], 0x3b9: [0x345, 0x1fbe],
  0x3ba: [0x3f0], 0x3bc: [0xb5], 0x3c0: [0x3d6], 0x3c1: [0x3f1], 0x3c2: [0x3c3], 0x3c3: [0x3c2], 0x3c6: [0x3d5],
  0x3d0: [0x3b2], 0x3d1: [0x3b8], 0x3d5: [0x3c6], 0x3d6: [0x3c0], 0x3f0: [0x3ba], 0x3f1: [0x3c1], 0x3f5: [0x3b5],
  0x432: [0x1c80], 0x434: [0x1c81], 0x43e: [0x1c82], 0x441: [0x1c83], 0x442: [0x1c84, 0x1c85], 0x44a: [0x1c86],
  0x463: [0x1c87], 0x1c80: [0x432], 0x1c81: [0x434], 0x1c82: [0x43e], 0x1c83: [0x441], 0x1c84: [0x442, 0x1c85],
  0x1c85: [0x442, 0x1c84], 0x1c86: [0x44a], 0x1c87: [0x463], 0x1c88: [0xa64b], 0x1e61: [0x1e9b],
  0x1e9b: [0x1e61], 0x1fbe: [0x345, 0x3b9], 0x1fd3: [0x390], 0x1fe3: [0x3b0], 0xa64b: [0x1c88], 0xfb05: [0xfb06],
  0xfb06: [0xfb05],
}).map(([k, v]) => [Number(k), v]));

/** re.error: the message, with " at position N" (and line and column for a multi-line pattern) when known. */
class ReError extends Error {
  /**
   * @param {string} msg
   * @param {string} [pattern] the pattern, to locate the error
   * @param {number} [pos] the code point position of the error in the pattern
   */
  constructor(msg, pattern, pos) {
    let text = msg;
    if (pattern !== undefined && pos !== undefined) {
      text = `${msg} at position ${pos}`;
      const chars = Array.from(pattern);
      if (chars.includes('\n')) {
        const before = chars.slice(0, pos);
        const lineno = before.filter((c) => c === '\n').length + 1;
        const colno = pos - before.lastIndexOf('\n');
        text = `${text} (line ${lineno}, column ${colno})`;
      }
    }
    super(text);
    this.pyName = 're.error';
  }
}

const plen = (s) => Array.from(s).length;
const isDigitToken = (t) => t !== null && t.length === 1 && DIGITS.includes(t);
const isOctToken = (t) => t !== null && t.length === 1 && OCTDIGITS.includes(t);

let lowerMap = null;
function uniLower(c) {
  if (lowerMap === null) {
    lowerMap = new Map();
    for (let i = 0; i < U.LOWER.length; i += 2) lowerMap.set(U.LOWER[i], U.LOWER[i + 1]);
  }
  const l = lowerMap.get(c);
  return l === undefined ? c : l;
}
function uniUpper(c) {
  const u = Array.from(String.fromCodePoint(c).toUpperCase());
  return u.length === 1 ? u[0].codePointAt(0) : c;
}
const uniIsCased = (c) => inRanges(U.CASED, c);
const asciiLower = (c) => (c >= 65 && c <= 90 ? c + 32 : c);
const asciiIsCased = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const asciiIsWord = (c) => (c >= 48 && c <= 57) || asciiIsCased(c) || c === 95;
const asciiIsSpace = (c) => c === 32 || (c >= 9 && c <= 13);
const uniIsWord = (c) => inRanges(U.WORD, c);

const CATEGORY_TESTS = {
  unicode: {
    DIGIT: (c) => inRanges(U.DECIMAL, c), NOT_DIGIT: (c) => !inRanges(U.DECIMAL, c),
    SPACE: (c) => inRanges(U.SPACE, c), NOT_SPACE: (c) => !inRanges(U.SPACE, c),
    WORD: uniIsWord, NOT_WORD: (c) => !uniIsWord(c),
  },
  ascii: {
    DIGIT: (c) => c >= 48 && c <= 57, NOT_DIGIT: (c) => !(c >= 48 && c <= 57),
    SPACE: asciiIsSpace, NOT_SPACE: (c) => !asciiIsSpace(c),
    WORD: asciiIsWord, NOT_WORD: (c) => !asciiIsWord(c),
  },
};

// ---------------------------------------------------------------- parser (Lib/re/_parser.py)

/** _parser.State: the flags, groups and group names gathered while parsing one pattern. */
class State {
  constructor() {
    this.flags = 0;
    this.groupdict = new Map();
    this.groupwidths = [null];
    this.lookbehindgroups = null;
    this.grouprefpos = new Map();
  }
  /** @returns {number} the number of groups opened so far, plus one for group 0 */
  get groups() { return this.groupwidths.length; }
  /**
   * State.opengroup.
   * @param {string|null} name the group name, or null for an unnamed group
   * @returns {number} the new group's number
   * @throws {ReError} for too many groups or a name already used
   */
  opengroup(name) {
    const gid = this.groups;
    this.groupwidths.push(null);
    if (this.groups > MAXGROUPS) throw new ReError('too many groups');
    if (name !== null) {
      const ogid = this.groupdict.get(name);
      if (ogid !== undefined) {
        throw new ReError(`redefinition of group name ${pyRepr(name)} as group ${gid}; was group ${ogid}`);
      }
      this.groupdict.set(name, gid);
    }
    return gid;
  }
  /**
   * State.closegroup: records a finished group's width.
   * @param {number} gid
   * @param {SubPattern} p the group's content
   * @returns {void}
   */
  closegroup(gid, p) { this.groupwidths[gid] = p.getwidth(); }
  /**
   * @param {number} gid
   * @returns {boolean} whether the group exists and is closed
   */
  checkgroup(gid) { return gid < this.groups && this.groupwidths[gid] !== null; }
  /**
   * State.checklookbehindgroup: inside a lookbehind, a backreference must name a closed group defined before it.
   * @param {number} gid
   * @param {Tokenizer} source for the error position
   * @returns {void}
   * @throws {ReError} for a reference to an open group or to one defined in the same lookbehind
   */
  checklookbehindgroup(gid, source) {
    if (this.lookbehindgroups !== null) {
      if (!this.checkgroup(gid)) throw source.error('cannot refer to an open group');
      if (gid >= this.lookbehindgroups) {
        throw source.error('cannot refer to group defined in the same lookbehind subpattern');
      }
    }
  }
}

/** _parser.SubPattern: a parsed (sub)pattern as a list of [opcode, argument] items. */
class SubPattern {
  /**
   * @param {State} state the pattern's parse state
   * @param {Array} [data] the items
   */
  constructor(state, data = []) {
    this.state = state;
    this.data = data;
    this.width = null;
  }
  /** @returns {number} the number of items */
  get length() { return this.data.length; }
  /**
   * SubPattern.getwidth, cached.
   * @returns {number[]} [minimum, maximum] match width, capped at MAXREPEAT - 1 and MAXREPEAT
   */
  getwidth() {
    if (this.width !== null) return this.width;
    let lo = 0;
    let hi = 0;
    for (const [op, av] of this.data) {
      let w = [0, 0];
      if (op === 'BRANCH') {
        w = [MAXREPEAT - 1, 0];
        for (const b of av[1]) {
          const [l, h] = b.getwidth();
          w = [Math.min(w[0], l), Math.max(w[1], h)];
        }
      } else if (op === 'ATOMIC_GROUP') {
        w = av.getwidth();
      } else if (op === 'SUBPATTERN') {
        w = av[3].getwidth();
      } else if (REPEAT_CODES.has(op)) {
        const [i, j] = av[2].getwidth();
        w = [i * av[0], j * av[1]];
      } else if (UNIT_CODES.has(op)) {
        w = [1, 1];
      } else if (op === 'GROUPREF') {
        w = this.state.groupwidths[av];
      } else if (op === 'GROUPREF_EXISTS') {
        const [i, j] = av[1].getwidth();
        if (av[2] !== null) {
          const [l, h] = av[2].getwidth();
          w = [Math.min(i, l), Math.max(j, h)];
        } else {
          w = [0, j];
        }
      }
      lo += w[0];
      hi += w[1];
    }
    this.width = [Math.min(lo, MAXREPEAT - 1), Math.min(hi, MAXREPEAT)];
    return this.width;
  }
}

/** _parser.Tokenizer: the pattern string read token by token (a character, or a backslash and the character after it). */
class Tokenizer {
  /**
   * @param {string} string the pattern
   * @throws {ReError} for a pattern ending in a lone backslash
   */
  constructor(string) {
    this.string = string;
    this.chars = Array.from(string);
    this.index = 0;
    this.next = null;
    this.advance();
  }
  /**
   * Tokenizer.__next: reads the next token into `next` (null at the end).
   * @returns {void}
   * @throws {ReError} "bad escape (end of pattern)" for a trailing backslash
   */
  advance() {
    let index = this.index;
    let char = this.chars[index];
    if (char === undefined) {
      this.next = null;
      return;
    }
    if (char === '\\') {
      index += 1;
      if (index >= this.chars.length) {
        throw new ReError('bad escape (end of pattern)', this.string, this.chars.length - 1);
      }
      char += this.chars[index];
    }
    this.index = index + 1;
    this.next = char;
  }
  /**
   * @param {string} char
   * @returns {boolean} whether the next token is char, consuming it if so
   * @throws {ReError} as advance()
   */
  match(char) {
    if (char === this.next) {
      this.advance();
      return true;
    }
    return false;
  }
  /**
   * @returns {string|null} the next token, consumed
   * @throws {ReError} as advance()
   */
  get() {
    const t = this.next;
    this.advance();
    return t;
  }
  /**
   * @param {number} n the most characters to read
   * @param {string} charset the characters accepted
   * @returns {string} the run of accepted characters read
   */
  getwhile(n, charset) {
    let result = '';
    for (let k = 0; k < n; k++) {
      const c = this.next;
      if (c === null || c.length !== 1 || !charset.includes(c)) break;
      result += c;
      this.advance();
    }
    return result;
  }
  /**
   * Reads a name up to its terminator, e.g. a group name up to ">".
   * @param {string} terminator
   * @param {string} name what the name is, for the error message
   * @returns {string}
   * @throws {ReError} for an empty or unterminated name
   */
  getuntil(terminator, name) {
    let result = '';
    for (;;) {
      const c = this.next;
      this.advance();
      if (c === null) {
        if (!result) throw this.error(`missing ${name}`);
        throw this.error(`missing ${terminator}, unterminated name`, plen(result));
      }
      if (c === terminator) {
        if (!result) throw this.error(`missing ${name}`, 1);
        break;
      }
      result += c;
    }
    return result;
  }
  /** @returns {number} the position of the next token, in code points */
  tell() { return this.index - (this.next === null ? 0 : plen(this.next)); }
  /**
   * @param {number} index a position tell() returned
   * @returns {void}
   */
  seek(index) {
    this.index = index;
    this.advance();
  }
  /**
   * @param {string} msg
   * @param {number} [offset] how far before the next token the error lies
   * @returns {ReError} the error, for the caller to throw
   */
  error(msg, offset = 0) { return new ReError(msg, this.string, this.tell() - offset); }
  /**
   * @param {string} name
   * @param {number} offset the characters after the name, for the error position
   * @returns {void}
   * @throws {ReError} for a name that is not an identifier
   */
  checkgroupname(name, offset) {
    if (!isIdentifier(name)) throw this.error(`bad character in group name ${pyRepr(name)}`, plen(name) + offset);
  }
}

function isIdentifier(s) {
  return /^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(s);
}

function hexEscape(source, escape, digits) {
  const full = escape + source.getwhile(digits, HEXDIGITS);
  if (full.length !== digits + 2) throw source.error(`incomplete escape ${full}`, full.length);
  const v = parseInt(full.slice(2), 16);
  if (v > 0x10ffff) throw source.error(`bad escape ${full}`, full.length);
  return ['LITERAL', v];
}

function namedEscape(source) {
  if (!source.match('{')) throw source.error('missing {');
  const charname = source.getuntil('}', 'character name');
  const cp = lookupName(charname);
  if (cp < 0) throw source.error(`undefined character name ${pyRepr(charname)}`, plen(charname) + 4);
  return ['LITERAL', cp];
}

// The escapes both contexts share: \x \u \U \N; null when the escape is not one of them.
function commonEscape(source, escape) {
  const c = escape.slice(1);
  if (c === 'x') return hexEscape(source, escape, 2);
  if (c === 'u') return hexEscape(source, escape, 4);
  if (c === 'U') return hexEscape(source, escape, 8);
  if (c === 'N') return namedEscape(source);
  return null;
}

function plainEscape(source, escape) {
  const c = escape.slice(1);
  if (!DIGITS.includes(c) && plen(escape) === 2) {
    if (/^[a-zA-Z]$/.test(c)) throw source.error(`bad escape ${escape}`, 2);
    return ['LITERAL', c.codePointAt(0)];
  }
  throw source.error(`bad escape ${escape}`, plen(escape));
}

function classEscape(source, escape) {
  if (ESCAPES[escape]) return ESCAPES[escape];
  const cat = CATEGORIES[escape];
  if (cat && cat[0] === 'IN') return cat;
  const common = commonEscape(source, escape);
  if (common) return common;
  if (OCTDIGITS.includes(escape.slice(1))) {
    const full = escape + source.getwhile(2, OCTDIGITS);
    const v = parseInt(full.slice(1), 8);
    if (v > 0o377) throw source.error(`octal escape value ${full} outside of range 0-0o377`, full.length);
    return ['LITERAL', v];
  }
  return plainEscape(source, escape);
}

function escapeCode(source, escape, state) {
  if (CATEGORIES[escape]) return CATEGORIES[escape];
  if (ESCAPES[escape]) return ESCAPES[escape];
  const common = commonEscape(source, escape);
  if (common) return common;
  const c = escape.slice(1);
  if (c === '0') return ['LITERAL', parseInt(escape.slice(1) + source.getwhile(2, OCTDIGITS), 8)];
  if (isDigitToken(c)) {
    // octal escape *or* decimal group reference
    if (isDigitToken(source.next)) {
      escape += source.get();
      if (OCTDIGITS.includes(escape[1]) && OCTDIGITS.includes(escape[2]) && isOctToken(source.next)) {
        escape += source.get();
        const v = parseInt(escape.slice(1), 8);
        if (v > 0o377) throw source.error(`octal escape value ${escape} outside of range 0-0o377`, escape.length);
        return ['LITERAL', v];
      }
    }
    const group = parseInt(escape.slice(1), 10);
    if (group < state.groups) {
      if (!state.checkgroup(group)) throw source.error('cannot refer to an open group', escape.length);
      state.checklookbehindgroup(group, source);
      return ['GROUPREF', group];
    }
    throw source.error(`invalid group reference ${group}`, escape.length - 1);
  }
  return plainEscape(source, escape);
}

function itemEquals(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => itemEquals(x, b[i]));
  return false;
}

function uniq(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = JSON.stringify(it);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseSub(source, state, verbose, nested, ctx) {
  const items = [];
  for (;;) {
    items.push(parseSeq(source, state, verbose, nested + 1, !nested && !items.length, ctx));
    if (!source.match('|')) break;
    if (!nested) verbose = state.flags & SRE_FLAG_VERBOSE;
  }
  if (items.length === 1) return items[0];
  const subpattern = new SubPattern(state);
  // move a prefix common to every alternative out of the branch
  for (;;) {
    let prefix = null;
    const common = items.every((item) => {
      if (!item.length) return false;
      if (prefix === null) prefix = item.data[0];
      return itemEquals(item.data[0], prefix);
    });
    if (!common) break;
    for (const item of items) item.data.shift();
    subpattern.data.push(prefix);
  }
  // a branch of single characters becomes a character set
  const set = [];
  const single = items.every((item) => {
    if (item.length !== 1) return false;
    const [op, av] = item.data[0];
    if (op === 'LITERAL') set.push([op, av]);
    else if (op === 'IN' && av[0][0] !== 'NEGATE') set.push(...av);
    else return false;
    return true;
  });
  subpattern.data.push(single ? ['IN', uniq(set)] : ['BRANCH', [null, items]]);
  return subpattern;
}

const SET_OPS = { '-': 'difference', '&': 'intersection', '~': 'symmetric difference', '|': 'union' };

function parseSet(source, subpattern, ctx) {
  const here = source.tell() - 1;
  let set = [];
  if (source.next === '[') ctx.warn('FutureWarning', `Possible nested set at position ${source.tell()}`);
  const negate = source.match('^');
  for (;;) {
    const first = source.get();
    if (first === null) throw source.error('unterminated character set', source.tell() - here);
    if (first === ']' && set.length) break;
    let code1;
    if (first[0] === '\\' && first.length > 1) {
      code1 = classEscape(source, first);
    } else {
      if (set.length && '-&~|'.includes(first) && source.next === first) {
        ctx.warn('FutureWarning', `Possible set ${SET_OPS[first]} at position ${source.tell() - 1}`);
      }
      code1 = ['LITERAL', first.codePointAt(0)];
    }
    if (source.match('-')) {
      const that = source.get();
      if (that === null) throw source.error('unterminated character set', source.tell() - here);
      if (that === ']') {
        if (code1[0] === 'IN') code1 = code1[1][0];
        set.push(code1, ['LITERAL', 45]);
        break;
      }
      let code2;
      if (that[0] === '\\' && that.length > 1) {
        code2 = classEscape(source, that);
      } else {
        if (that === '-') ctx.warn('FutureWarning', `Possible set difference at position ${source.tell() - 2}`);
        code2 = ['LITERAL', that.codePointAt(0)];
      }
      const span = plen(first) + 1 + plen(that);
      if (code1[0] !== 'LITERAL' || code2[0] !== 'LITERAL' || code2[1] < code1[1]) {
        throw source.error(`bad character range ${first}-${that}`, span);
      }
      set.push(['RANGE', [code1[1], code2[1]]]);
    } else {
      if (code1[0] === 'IN') code1 = code1[1][0];
      set.push(code1);
    }
  }
  set = uniq(set);
  if (set.length === 1 && set[0][0] === 'LITERAL') {
    subpattern.data.push(negate ? ['NOT_LITERAL', set[0][1]] : set[0]);
  } else {
    if (negate) set.unshift(['NEGATE', null]);
    subpattern.data.push(['IN', set]);
  }
}

function parseRepeat(source, subpattern, that) {
  const here = source.tell();
  let min = 0;
  let max = MAXREPEAT;
  if (that === '?') max = 1;
  else if (that === '+') min = 1;
  else if (that === '{') {
    if (source.next === '}') {
      subpattern.data.push(['LITERAL', 123]);
      return;
    }
    let lo = '';
    let hi = '';
    while (isDigitToken(source.next)) lo += source.get();
    if (source.match(',')) {
      while (isDigitToken(source.next)) hi += source.get();
    } else {
      hi = lo;
    }
    if (!source.match('}')) {
      subpattern.data.push(['LITERAL', 123]);
      source.seek(here);
      return;
    }
    if (lo) {
      min = Number(lo);
      if (min >= MAXREPEAT) throw pyError('OverflowError', 'the repetition number is too large');
    }
    if (hi) {
      max = Number(hi);
      if (max >= MAXREPEAT) throw pyError('OverflowError', 'the repetition number is too large');
      if (max < min) throw source.error('min repeat greater than max repeat', source.tell() - here);
    }
  }
  const last = subpattern.data[subpattern.data.length - 1];
  if (!last || last[0] === 'AT') throw source.error('nothing to repeat', source.tell() - here + 1);
  if (REPEAT_CODES.has(last[0])) throw source.error('multiple repeat', source.tell() - here + 1);
  let item = new SubPattern(subpattern.state, [last]);
  if (last[0] === 'SUBPATTERN') {
    const [group, addFlags, delFlags, p] = last[1];
    if (group === null && !addFlags && !delFlags) item = p;
  }
  let op = 'MAX_REPEAT';
  if (source.match('?')) op = 'MIN_REPEAT';
  else if (source.match('+')) op = 'POSSESSIVE_REPEAT';
  subpattern.data[subpattern.data.length - 1] = [op, [min, max, item]];
}

function parseFlags(source, state, char) {
  let addFlags = 0;
  let delFlags = 0;
  const isFlag = (ch) => ch !== null && Object.prototype.hasOwnProperty.call(FLAGS, ch);
  const isAlpha = (ch) => /^\p{L}+$/u.test(ch);
  if (char !== '-') {
    for (;;) {
      const flag = FLAGS[char];
      if (char === 'L') throw source.error("bad inline flags: cannot use 'L' flag with a str pattern");
      addFlags |= flag;
      if ((flag & TYPE_FLAGS) && (addFlags & TYPE_FLAGS) !== flag) {
        throw source.error("bad inline flags: flags 'a', 'u' and 'L' are incompatible");
      }
      char = source.get();
      if (char === null) throw source.error('missing -, : or )');
      if (char === ')' || char === '-' || char === ':') break;
      if (!isFlag(char)) throw source.error(isAlpha(char) ? 'unknown flag' : 'missing -, : or )', plen(char));
    }
  }
  if (char === ')') {
    state.flags |= addFlags;
    return null;
  }
  if (addFlags & GLOBAL_FLAGS) throw source.error('bad inline flags: cannot turn on global flag', 1);
  if (char === '-') {
    char = source.get();
    if (char === null) throw source.error('missing flag');
    if (!isFlag(char)) throw source.error(isAlpha(char) ? 'unknown flag' : 'missing flag', plen(char));
    for (;;) {
      const flag = FLAGS[char];
      if (flag & TYPE_FLAGS) throw source.error("bad inline flags: cannot turn off flags 'a', 'u' and 'L'");
      delFlags |= flag;
      char = source.get();
      if (char === null) throw source.error('missing :');
      if (char === ':') break;
      if (!isFlag(char)) throw source.error(isAlpha(char) ? 'unknown flag' : 'missing :', plen(char));
    }
  }
  if (delFlags & GLOBAL_FLAGS) throw source.error('bad inline flags: cannot turn off global flag', 1);
  if (addFlags & delFlags) throw source.error('bad inline flags: flag turned on and off', 1);
  return [addFlags, delFlags];
}

function parseConditional(source, state, verbose, nested, start, ctx) {
  const condname = source.getuntil(')', 'group name');
  let condgroup;
  if (isIdentifier(condname)) {
    source.checkgroupname(condname, 1);
    condgroup = state.groupdict.get(condname);
    if (condgroup === undefined) throw source.error(`unknown group name ${pyRepr(condname)}`, plen(condname) + 1);
  } else {
    condgroup = pyInt(condname);
    if (condgroup === null || condgroup < 0) {
      throw source.error(`bad character in group name ${pyRepr(condname)}`, plen(condname) + 1);
    }
    if (!condgroup) throw source.error('bad group number', plen(condname) + 1);
    if (condgroup >= MAXGROUPS) throw source.error(`invalid group reference ${condgroup}`, plen(condname) + 1);
    if (!state.grouprefpos.has(condgroup)) state.grouprefpos.set(condgroup, source.tell() - plen(condname) - 1);
  }
  state.checklookbehindgroup(condgroup, source);
  const itemYes = parseSeq(source, state, verbose, nested + 1, false, ctx);
  let itemNo = null;
  if (source.match('|')) {
    itemNo = parseSeq(source, state, verbose, nested + 1, false, ctx);
    if (source.next === '|') throw source.error('conditional backref with more than two branches');
  }
  if (!source.match(')')) throw source.error('missing ), unterminated subpattern', source.tell() - start);
  return ['GROUPREF_EXISTS', [condgroup, itemYes, itemNo]];
}

function parseLookaround(source, state, verbose, nested, start, char, ctx) {
  let dir = 1;
  let outerLookbehind;
  if (char === '<') {
    char = source.get();
    if (char === null) throw source.error('unexpected end of pattern');
    if (char !== '=' && char !== '!') throw source.error(`unknown extension ?<${char}`, plen(char) + 2);
    dir = -1;
    outerLookbehind = state.lookbehindgroups;
    if (outerLookbehind === null) state.lookbehindgroups = state.groups;
  }
  const p = parseSub(source, state, verbose, nested + 1, ctx);
  if (dir < 0 && outerLookbehind === null) state.lookbehindgroups = null;
  if (!source.match(')')) throw source.error('missing ), unterminated subpattern', source.tell() - start);
  return [char === '=' ? 'ASSERT' : 'ASSERT_NOT', [dir, p]];
}

// Parses "(...)" after its "(": appends the item and returns false, or returns true for global flags.
function parseGroup(source, state, verbose, nested, first, subpattern, ctx) {
  const start = source.tell() - 1;
  let capture = true;
  let atomic = false;
  let name = null;
  let addFlags = 0;
  let delFlags = 0;
  if (source.match('?')) {
    let char = source.get();
    if (char === null) throw source.error('unexpected end of pattern');
    if (char === 'P') {
      if (source.match('<')) {
        name = source.getuntil('>', 'group name');
        source.checkgroupname(name, 1);
      } else if (source.match('=')) {
        const ref = source.getuntil(')', 'group name');
        source.checkgroupname(ref, 1);
        const gid = state.groupdict.get(ref);
        if (gid === undefined) throw source.error(`unknown group name ${pyRepr(ref)}`, plen(ref) + 1);
        if (!state.checkgroup(gid)) throw source.error('cannot refer to an open group', plen(ref) + 1);
        state.checklookbehindgroup(gid, source);
        subpattern.data.push(['GROUPREF', gid]);
        return false;
      } else {
        char = source.get();
        if (char === null) throw source.error('unexpected end of pattern');
        throw source.error(`unknown extension ?P${char}`, plen(char) + 2);
      }
    } else if (char === ':') {
      capture = false;
    } else if (char === '#') {
      for (;;) {
        if (source.next === null) throw source.error('missing ), unterminated comment', source.tell() - start);
        if (source.get() === ')') break;
      }
      return false;
    } else if (char === '=' || char === '!' || char === '<') {
      subpattern.data.push(parseLookaround(source, state, verbose, nested, start, char, ctx));
      return false;
    } else if (char === '(') {
      subpattern.data.push(parseConditional(source, state, verbose, nested, start, ctx));
      return false;
    } else if (char === '>') {
      capture = false;
      atomic = true;
    } else if (Object.prototype.hasOwnProperty.call(FLAGS, char) || char === '-') {
      const flags = parseFlags(source, state, char);
      if (flags === null) {
        if (!first || subpattern.length) {
          throw source.error('global flags not at the start of the expression', source.tell() - start);
        }
        return true;
      }
      [addFlags, delFlags] = flags;
      capture = false;
    } else {
      throw source.error(`unknown extension ?${char}`, plen(char) + 1);
    }
  }
  let group = null;
  if (capture) {
    try {
      group = state.opengroup(name);
    } catch (e) {
      if (!(e instanceof ReError)) throw e;
      throw source.error(e.message, plen(name) + 1);
    }
  }
  const subVerbose = (verbose || (addFlags & SRE_FLAG_VERBOSE)) && !(delFlags & SRE_FLAG_VERBOSE);
  const p = parseSub(source, state, subVerbose, nested + 1, ctx);
  if (!source.match(')')) throw source.error('missing ), unterminated subpattern', source.tell() - start);
  if (group !== null) state.closegroup(group, p);
  subpattern.data.push(atomic ? ['ATOMIC_GROUP', p] : ['SUBPATTERN', [group, addFlags, delFlags, p]]);
  return false;
}

function parseSeq(source, state, verbose, nested, first, ctx) {
  const subpattern = new SubPattern(state);
  for (;;) {
    let that = source.next;
    if (that === null || that === '|' || that === ')') break;
    source.get();
    if (verbose) {
      if (WHITESPACE.includes(that)) continue;
      if (that === '#') {
        do that = source.get(); while (that !== null && that !== '\n');
        continue;
      }
    }
    if (that[0] === '\\' && that.length > 1) {
      subpattern.data.push(escapeCode(source, that, state));
    } else if (!SPECIAL_CHARS.includes(that)) {
      subpattern.data.push(['LITERAL', that.codePointAt(0)]);
    } else if (that === '[') {
      parseSet(source, subpattern, ctx);
    } else if (REPEAT_CHARS.includes(that)) {
      parseRepeat(source, subpattern, that);
    } else if (that === '.') {
      subpattern.data.push(['ANY', null]);
    } else if (that === '(') {
      if (parseGroup(source, state, verbose, nested, first, subpattern, ctx)) verbose = state.flags & SRE_FLAG_VERBOSE;
    } else if (that === '^') {
      subpattern.data.push(['AT', 'AT_BEGINNING']);
    } else {
      subpattern.data.push(['AT', 'AT_END']);
    }
  }
  // unpack non-capturing groups without flags
  for (let i = subpattern.data.length - 1; i >= 0; i--) {
    const [op, av] = subpattern.data[i];
    if (op === 'SUBPATTERN' && av[0] === null && !av[1] && !av[2]) subpattern.data.splice(i, 1, ...av[3].data);
  }
  return subpattern;
}

function parse(str, flags, ctx) {
  const source = new Tokenizer(str);
  const state = new State();
  state.flags = flags;
  const p = parseSub(source, state, flags & SRE_FLAG_VERBOSE, 0, ctx);
  if (state.flags & SRE_FLAG_LOCALE) throw pyError('ValueError', 'cannot use LOCALE flag with a str pattern');
  if (!(state.flags & SRE_FLAG_ASCII)) state.flags |= SRE_FLAG_UNICODE;
  else if (state.flags & SRE_FLAG_UNICODE) throw pyError('ValueError', 'ASCII and UNICODE flags are incompatible');
  if (source.next !== null) throw source.error('unbalanced parenthesis');
  for (const [g, pos] of state.grouprefpos) {
    if (g >= state.groups) throw new ReError(`invalid group reference ${g}`, str, pos);
  }
  return p;
}

// ---------------------------------------------------------------- compiler and matcher (_compiler.py, sre_lib.h)

function combineFlags(flags, addFlags, delFlags) {
  if (addFlags & TYPE_FLAGS) flags &= ~TYPE_FLAGS;
  return (flags | addFlags) & ~delFlags;
}

function caseFns(flags) {
  if (!(flags & SRE_FLAG_IGNORECASE)) return null;
  if (flags & SRE_FLAG_UNICODE) return { iscased: uniIsCased, tolower: uniLower, fixes: EXTRA_CASES };
  return { iscased: asciiIsCased, tolower: asciiLower, fixes: null };
}

// _optimize_charset: a BMP map of the (case-folded) members plus a tail of categories and non-BMP items; with
// IGNORECASE and a cased member, sre tests the lowercased character against it.
function charsetTest(charset, flags) {
  const cf = caseFns(flags);
  const charmap = new Uint8Array(0x10000);
  const tail = [];
  let negate = false;
  let hascased = false;
  const mark = (v) => {
    charmap[v] = 1;
    if (cf && cf.fixes && cf.fixes.has(v)) for (const k of cf.fixes.get(v)) charmap[k] = 1;
  };
  for (const [op, av] of charset) {
    if (op === 'LITERAL') {
      const v = cf ? cf.tolower(av) : av;
      if (v >= 0x10000) {
        if (cf) hascased = true;
        tail.push((c) => c === av);
      } else {
        mark(v);
        if (cf && cf.iscased(av)) hascased = true;
      }
    } else if (op === 'RANGE') {
      const [a, b] = av;
      let overflow = false;
      for (let i = a; i <= b && !overflow; i++) {
        const v = cf ? cf.tolower(i) : i;
        if (v >= 0x10000) overflow = true;
        else mark(v);
      }
      if (overflow && cf) {
        hascased = true;
        tail.push((c) => (a <= c && c <= b) || (a <= uniUpper(c) && uniUpper(c) <= b));
      } else if (overflow) {
        tail.push((c) => a <= c && c <= b);
      } else if (cf) {
        for (let i = a; i <= b && !hascased; i++) hascased = cf.iscased(i);
      }
    } else if (op === 'NEGATE') {
      negate = true;
    } else {
      tail.push(CATEGORY_TESTS[flags & SRE_FLAG_UNICODE ? 'unicode' : 'ascii'][av]);
    }
  }
  const member = (c) => (c < 0x10000 && charmap[c] === 1) || tail.some((t) => t(c));
  const fold = cf && hascased ? cf.tolower : null;
  if (fold) return negate ? (c) => !member(fold(c)) : (c) => member(fold(c));
  return negate ? (c) => !member(c) : member;
}

function literalTest(op, av, flags) {
  const cf = caseFns(flags);
  let test;
  if (!cf || !cf.iscased(av)) {
    test = (c) => c === av;
  } else {
    const lo = cf.tolower(av);
    if (cf.fixes && cf.fixes.has(lo)) {
      const set = new Set([lo, ...cf.fixes.get(lo)]);
      test = (c) => set.has(cf.tolower(c));
    } else {
      test = (c) => cf.tolower(c) === lo;
    }
  }
  return op === 'NOT_LITERAL' ? (c) => !test(c) : test;
}

// The one-character predicate of an item sre repeats with REPEAT_ONE (_compiler._simple), or null.
function unitTest(p, flags) {
  if (p.data.length !== 1) return null;
  const [op, av] = p.data[0];
  if (op === 'SUBPATTERN') return av[0] === null ? unitTest(av[3], combineFlags(flags, av[1], av[2])) : null;
  if (op === 'LITERAL' || op === 'NOT_LITERAL') return literalTest(op, av, flags);
  if (op === 'ANY') return flags & SRE_FLAG_DOTALL ? () => true : (c) => c !== 10;
  if (op === 'IN') return charsetTest(av, flags);
  return null;
}

/**
 * The matcher behind a compiled pattern, in place of sre's engine. Every node is a function (i, k): it matches at
 * code point index i and calls the continuation k(end) for each way it can match, in sre's order, returning true
 * as soon as a continuation does.
 */
class Matcher {
  /**
   * @param {SubPattern} pattern the parsed pattern
   * @param {number} flags the pattern's flags after inline flags were applied
   */
  constructor(pattern, flags) {
    this.s = [];
    this.groups = pattern.state.groups;
    this.marks0 = [];
    this.marks1 = [];
    this.root = this.seq(pattern, flags);
  }

  /** @returns {Array} a copy of the group marks, for restoreMarks() */
  saveMarks() { return [this.marks0.slice(), this.marks1.slice()]; }
  /**
   * @param {Array} saved what saveMarks() returned
   * @returns {void}
   */
  restoreMarks(saved) { [this.marks0, this.marks1] = [saved[0].slice(), saved[1].slice()]; }
  /**
   * @param {number} g
   * @returns {boolean} whether group g took part in the match so far
   */
  groupSet(g) {
    const a = this.marks0[g];
    const b = this.marks1[g];
    return a >= 0 && b >= a;
  }

  /**
   * The end of a node's first match at i; the marks that match set are kept.
   * @param {Function} node
   * @param {number} i
   * @returns {number} the end, or -1
   */
  first(node, i) {
    let end = -1;
    node(i, (j) => {
      end = j;
      return true;
    });
    return end;
  }

  /**
   * A sequence; runs of single-character items become one node, which keeps the continuation chain short.
   * @param {SubPattern} p
   * @param {number} flags
   * @returns {Function} the node
   */
  seq(p, flags) {
    const nodes = [];
    let run = [];
    const flush = () => {
      if (run.length) nodes.push(this.units(run));
      run = [];
    };
    for (const item of p.data) {
      const test = unitTest(new SubPattern(null, [item]), flags);
      if (test) {
        run.push(test);
      } else {
        flush();
        nodes.push(this.item(item, flags));
      }
    }
    flush();
    if (!nodes.length) return (i, k) => k(i);
    let chain = nodes[nodes.length - 1];
    for (let n = nodes.length - 2; n >= 0; n--) {
      const node = nodes[n];
      const next = chain;
      chain = (i, k) => node(i, (j) => next(j, k));
    }
    return chain;
  }

  /**
   * @param {Array<function(number): boolean>} tests one-character tests
   * @param {number} i
   * @returns {boolean} whether the tests all pass from i
   */
  unitsMatch(tests, i) {
    if (i + tests.length > this.s.length) return false;
    for (let j = 0; j < tests.length; j++) if (!tests[j](this.s[i + j])) return false;
    return true;
  }

  /**
   * @param {Array<function(number): boolean>} tests one-character tests
   * @returns {Function} the node matching them in a row
   */
  units(tests) {
    return (i, k) => this.unitsMatch(tests, i) && k(i + tests.length);
  }

  /**
   * The node of one parsed item, by its opcode.
   * @param {Array} item [opcode, argument]
   * @param {number} flags
   * @returns {Function}
   * @throws {ReError} for a repeat under the TEMPLATE flag, and the errors of the nodes it builds
   */
  item([op, av], flags) {
    switch (op) {
      case 'AT': return this.at(av, flags);
      case 'BRANCH': {
        const alts = av[1].map((b) => this.seq(b, flags));
        return (i, k) => alts.some((alt) => alt(i, k));
      }
      case 'SUBPATTERN': return this.subpattern(av, flags);
      case 'ATOMIC_GROUP': {
        const body = this.seq(av, flags);
        return (i, k) => {
          const saved = this.saveMarks();
          const j = this.first(body, i);
          if (j >= 0 && k(j)) return true;
          this.restoreMarks(saved);
          return false;
        };
      }
      case 'MAX_REPEAT': case 'MIN_REPEAT': case 'POSSESSIVE_REPEAT':
        if (flags & SRE_FLAG_TEMPLATE) throw new ReError(`internal: unsupported template operator ${op}`);
        return this.repeat(op, av, flags);
      case 'GROUPREF': return this.groupref(av, flags);
      case 'GROUPREF_EXISTS': {
        const yes = this.seq(av[1], flags);
        const no = av[2] ? this.seq(av[2], flags) : (i, k) => k(i);
        return (i, k) => (this.groupSet(av[0]) ? yes : no)(i, k);
      }
      default: return this.assertion(op, av, flags);
    }
  }

  /**
   * A parenthesised subpattern, with its inline flags; a capturing one sets its group's marks.
   * @param {Array} sub [group number or null, flags added, flags removed, pattern]
   * @param {number} flags
   * @returns {Function}
   */
  subpattern([group, addFlags, delFlags, p], flags) {
    const body = this.seq(p, combineFlags(flags, addFlags, delFlags));
    if (!group) return body;
    return (i, k) => {
      const old0 = this.marks0[group];
      this.marks0[group] = i;
      const ok = body(i, (j) => {
        const old1 = this.marks1[group];
        this.marks1[group] = j;
        if (k(j)) return true;
        this.marks1[group] = old1;
        return false;
      });
      if (!ok) this.marks0[group] = old0;
      return ok;
    };
  }

  /**
   * A lookahead or lookbehind (ASSERT, ASSERT_NOT).
   * @param {string} op
   * @param {Array} sub [direction, pattern]
   * @param {number} flags
   * @returns {Function}
   * @throws {ReError} "look-behind requires fixed-width pattern"
   */
  assertion(op, [dir, p], flags) {
    let back = 0;
    if (dir < 0) {
      const [lo, hi] = p.getwidth();
      if (lo !== hi) throw new ReError('look-behind requires fixed-width pattern');
      back = lo;
    }
    const body = this.seq(p, flags);
    return (i, k) => {
      const saved = this.saveMarks();
      const found = i - back >= 0 && this.first(body, i - back) >= 0;
      if (op === 'ASSERT_NOT') {
        this.restoreMarks(saved);
        return !found && k(i);
      }
      if (found && k(i)) return true;
      this.restoreMarks(saved);
      return false;
    };
  }

  /**
   * An anchor: ^, $, \A, \Z, \b or \B, by flags.
   * @param {string} where the AT code
   * @param {number} flags
   * @returns {Function}
   */
  at(where, flags) {
    const multiline = flags & SRE_FLAG_MULTILINE;
    const isWord = flags & SRE_FLAG_UNICODE ? uniIsWord : asciiIsWord;
    // sre never finds a word boundary (or its absence) in an empty string
    const boundary = (i) => {
      const s = this.s;
      return (i > 0 && isWord(s[i - 1])) !== (i < s.length && isWord(s[i]));
    };
    const tests = {
      AT_BEGINNING: multiline ? (i) => i === 0 || this.s[i - 1] === 10 : (i) => i === 0,
      AT_BEGINNING_STRING: (i) => i === 0,
      AT_END: multiline
        ? (i) => i === this.s.length || this.s[i] === 10
        : (i) => i === this.s.length || (i === this.s.length - 1 && this.s[i] === 10),
      AT_END_STRING: (i) => i === this.s.length,
      AT_BOUNDARY: (i) => this.s.length > 0 && boundary(i),
      AT_NON_BOUNDARY: (i) => this.s.length > 0 && !boundary(i),
    };
    const test = tests[where];
    return (i, k) => test(i) && k(i);
  }

  /**
   * A backreference; with IGNORECASE the characters compare lowered.
   * @param {number} g
   * @param {number} flags
   * @returns {Function}
   */
  groupref(g, flags) {
    const cf = caseFns(flags);
    const fold = cf ? cf.tolower : (c) => c;
    return (i, k) => {
      if (!this.groupSet(g)) return false;
      const a = this.marks0[g];
      const len = this.marks1[g] - a;
      if (i + len > this.s.length) return false;
      for (let n = 0; n < len; n++) if (fold(this.s[i + n]) !== fold(this.s[a + n])) return false;
      return k(i + len);
    };
  }

  /**
   * A repeat (MAX_REPEAT, MIN_REPEAT or POSSESSIVE_REPEAT), through repeatOne() or repeatFixed() when the item
   * allows.
   * @param {string} op
   * @param {Array} rep [min, max, item]
   * @param {number} flags
   * @returns {Function}
   */
  repeat(op, [min, max, item], flags) {
    const limit = max === MAXREPEAT ? Infinity : max;
    const test = unitTest(item, flags);
    if (test) return this.repeatOne(op, min, limit, test);
    const fixed = this.fixedWidthBody(item, flags);
    if (fixed) return this.repeatFixed(op, min, limit, ...fixed);
    const body = this.seq(item, flags);
    // sre stops repeating once an iteration beyond the minimum matched the empty string (MAX_UNTIL, MIN_UNTIL)
    if (op === 'MAX_REPEAT') {
      const rep = (i, n, last, k) => {
        if (n < min) return body(i, (j) => rep(j, n + 1, last, k));
        if (n < limit && i !== last) {
          const saved = this.saveMarks();
          if (body(i, (j) => rep(j, n + 1, i, k))) return true;
          this.restoreMarks(saved);
        }
        return k(i);
      };
      return (i, k) => rep(i, 0, -1, k);
    }
    if (op === 'MIN_REPEAT') {
      const rep = (i, n, last, k) => {
        if (n < min) return body(i, (j) => rep(j, n + 1, last, k));
        if (k(i)) return true;
        if (n >= limit || i === last) return false;
        return body(i, (j) => rep(j, n + 1, i, k));
      };
      return (i, k) => rep(i, 0, -1, k);
    }
    // POSSESSIVE_REPEAT: each iteration takes its first match and is never revisited
    return (i, k) => {
      const saved = this.saveMarks();
      let p = i;
      let n = 0;
      for (; n < min; n++) {
        p = this.first(body, p);
        if (p < 0) {
          this.restoreMarks(saved);
          return false;
        }
      }
      let last = -1;
      while (n < limit && p !== last) {
        last = p;
        const j = this.first(body, p);
        if (j < 0) break;
        p = j;
        n++;
      }
      if (k(p)) return true;
      this.restoreMarks(saved);
      return false;
    };
  }

  /**
   * When the repeated item is a run of single-character items, possibly inside one group, its iterations match
   * deterministically and are counted without recursion.
   * @param {SubPattern} item
   * @param {number} flags
   * @returns {Array|null} [tests, group number or null], or null for any other item
   */
  fixedWidthBody(item, flags) {
    let group = null;
    let body = item;
    let bodyFlags = flags;
    if (item.data.length === 1 && item.data[0][0] === 'SUBPATTERN') {
      const [g, addFlags, delFlags, p] = item.data[0][1];
      [group, body, bodyFlags] = [g, p, combineFlags(flags, addFlags, delFlags)];
    }
    const tests = body.data.map((it) => unitTest(new SubPattern(null, [it]), bodyFlags));
    return tests.length && tests.every((t) => t) ? [tests, group] : null;
  }

  /**
   * A repeat of a fixed run of single-character tests, counted without recursion.
   * @param {string} op
   * @param {number} min
   * @param {number} limit the maximum, Infinity for MAXREPEAT
   * @param {Array<function(number): boolean>} tests
   * @param {number|null} group the group around the run, which spans the last iteration
   * @returns {Function}
   */
  repeatFixed(op, min, limit, tests, group) {
    const w = tests.length;
    const count = (i, upto) => {
      let n = 0;
      while (n < upto && this.unitsMatch(tests, i + n * w)) n++;
      return n;
    };
    // k after n iterations, with the group (if any) spanning the last one
    const tail = (i, n, k) => {
      if (!group || n === 0) return k(i + n * w);
      const [old0, old1] = [this.marks0[group], this.marks1[group]];
      [this.marks0[group], this.marks1[group]] = [i + (n - 1) * w, i + n * w];
      if (k(i + n * w)) return true;
      [this.marks0[group], this.marks1[group]] = [old0, old1];
      return false;
    };
    if (op === 'MAX_REPEAT') {
      return (i, k) => {
        for (let n = count(i, limit); n >= min; n--) if (tail(i, n, k)) return true;
        return false;
      };
    }
    if (op === 'MIN_REPEAT') {
      return (i, k) => {
        let n = count(i, min);
        if (n < min) return false;
        for (;;) {
          if (tail(i, n, k)) return true;
          if (n >= limit || !this.unitsMatch(tests, i + n * w)) return false;
          n++;
        }
      };
    }
    return (i, k) => {
      const n = count(i, limit);
      return n >= min && tail(i, n, k);
    };
  }

  /**
   * A repeat of one single-character test (sre's REPEAT_ONE and MIN_REPEAT_ONE).
   * @param {string} op
   * @param {number} min
   * @param {number} limit the maximum, Infinity for MAXREPEAT
   * @param {function(number): boolean} test
   * @returns {Function}
   */
  repeatOne(op, min, limit, test) {
    const count = (i, upto) => {
      let n = 0;
      while (n < upto && i + n < this.s.length && test(this.s[i + n])) n++;
      return n;
    };
    if (op === 'MAX_REPEAT') {
      return (i, k) => {
        for (let n = count(i, limit); n >= min; n--) if (k(i + n)) return true;
        return false;
      };
    }
    if (op === 'MIN_REPEAT') {
      return (i, k) => {
        let n = count(i, min);
        if (n < min) return false;
        for (;;) {
          if (k(i + n)) return true;
          if (n >= limit || i + n >= this.s.length || !test(this.s[i + n])) return false;
          n++;
        }
      };
    }
    return (i, k) => {
      const n = count(i, limit);
      return n >= min && k(i + n);
    };
  }

  /**
   * The first match starting at `from` or later.
   * @param {number} from a code point index
   * @param {boolean} mustAdvance whether an empty match at `from` is skipped (finditer after an empty match)
   * @returns {number[]|null} [start, end], or null
   * @throws {RangeError} when the recursion exhausts the stack (compile() then reruns the search on a worker)
   */
  find(from, mustAdvance) {
    // a failed attempt leaves the marks as it found them, so they are reset once per search
    this.marks0 = new Array(this.groups).fill(-1);
    this.marks1 = new Array(this.groups).fill(-1);
    for (let start = from; start <= this.s.length; start++) {
      let end = -1;
      const ok = this.root(start, (j) => {
        if (mustAdvance && start === from && j === start) return false;
        end = j;
        return true;
      });
      if (ok) return [start, end];
    }
    return null;
  }

  /**
   * Pattern.search(string) is not None.
   * @param {string} string
   * @returns {boolean}
   * @throws {RangeError} as find()
   */
  search(string) {
    this.s = Array.from(string, (ch) => ch.codePointAt(0));
    return this.find(0, false) !== null;
  }

  /**
   * Pattern.finditer(string), each match as its groups.
   * @param {string} string
   * @returns {Array<Array<string|null>>} [whole match, group 1, ...] per match, null for a group that did not take part
   * @throws {RangeError} as find()
   */
  finditer(string) {
    this.s = Array.from(string, (ch) => ch.codePointAt(0));
    const text = (a, b) => {
      let out = '';
      for (let i = a; i < b; i += 4096) out += String.fromCodePoint(...this.s.slice(i, Math.min(b, i + 4096)));
      return out;
    };
    const matches = [];
    let pos = 0;
    let mustAdvance = false;
    while (pos <= this.s.length) {
      const found = this.find(pos, mustAdvance);
      if (found === null) break;
      const groups = [text(found[0], found[1])];
      for (let g = 1; g < this.groups; g++) groups.push(this.groupSet(g) ? text(this.marks0[g], this.marks1[g]) : null);
      matches.push(groups);
      mustAdvance = found[1] === found[0];
      pos = found[1];
    }
    return matches;
  }
}

const SPECIAL_ESCAPES = new Set('()[]{}?*+-|^$\\.&~# \t\n\r\v\f');

/**
 * re.escape(pattern).
 * @param {string} pattern literal text
 * @returns {string} the text with every character that is special in a pattern backslash-escaped
 */
function escape(pattern) {
  return Array.from(pattern, (ch) => (SPECIAL_ESCAPES.has(ch) ? `\\${ch}` : ch)).join('');
}

/**
 * re.compile(pattern, flags) for a str pattern.
 * @param {string} pattern the Python regular expression
 * @param {{warn: function(string, string): void}} ctx receives each warning re.compile emits (category, message)
 * @param {number} [flags] re flags (see FLAG)
 * @returns {{search: function(string): boolean, finditer: function(string): Array, groupindex: Map}} search(s)
 *   says whether the pattern matches anywhere in s; finditer(s) lists the successive matches, each as
 *   [whole match, group 1, ...] with null for a group that did not take part
 * @throws {ReError|Error} re.error, OverflowError or ValueError, as re.compile raises them
 */
function compile(pattern, ctx, flags = 0) {
  const p = parse(pattern, flags, ctx);
  const matcher = new Matcher(p, p.state.flags);
  const search = (s) => {
    try {
      return matcher.search(s);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return deepSearch(pattern, flags, s);
    }
  };
  return { search, finditer: (s) => matcher.finditer(s), groupindex: p.state.groupdict };
}

// sre backtracks without using the C stack; this matcher recurses once per iteration of a repeated group, which can
// exhaust the main thread's stack on a very long string. Such a search is rerun, synchronously, on a worker thread
// with a much larger stack.
const DEEP_STACK_MB = 512;
let deepWorker = null;

function deepSearch(pattern, flags, string) {
  const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
  if (deepWorker === null) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(__filename, {
      workerData: { pyreSearch: { port: port2, signal } },
      transferList: [port2],
      resourceLimits: { stackSizeMb: DEEP_STACK_MB },
    });
    worker.unref();
    deepWorker = { port: port1, signal };
  }
  Atomics.store(deepWorker.signal, 0, 0);
  deepWorker.port.postMessage({ pattern, flags, string });
  Atomics.wait(deepWorker.signal, 0, 0);
  const { message } = receiveMessageOnPort(deepWorker.port);
  if (message.error) throw new RangeError(message.error);
  return message.found;
}

function serveDeepSearches({ port, signal }) {
  port.on('message', ({ pattern, flags, string }) => {
    try {
      const p = parse(pattern, flags, { warn: () => {} });
      port.postMessage({ found: new Matcher(p, p.state.flags).search(string) });
    } catch (e) {
      port.postMessage({ error: e.message });
    }
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });
}

const FLAG = { IGNORECASE: SRE_FLAG_IGNORECASE, MULTILINE: SRE_FLAG_MULTILINE, DOTALL: SRE_FLAG_DOTALL };

module.exports = { compile, escape, FLAG, ReError };

const workerThreads = require('node:worker_threads');

if (!workerThreads.isMainThread && workerThreads.workerData && workerThreads.workerData.pyreSearch) {
  serveDeepSearches(workerThreads.workerData.pyreSearch);
}
