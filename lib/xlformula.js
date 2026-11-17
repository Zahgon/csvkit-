'use strict';
// Port of xlrd 2.0.2's formula.evaluate_name_formula (BSD): the evaluation of a defined name's formula tokens with
// the Operand and Ref3D classes, the cell address and sheet range helpers, constant folding with Python's semantics
// for the int, float, complex, str and list values it folds, the lines xlrd writes to its log file (the debug ones
// from the sixth level of indirection on) and the exceptions xlrd raises for bad or truncated tokens.

const { pyError } = require('./pyerrors');
const { unpack, byteAt } = require('./pystruct');
const { xlrdError, assertionError, unpackStringUpdatePos, unpackUnicodeUpdatePos, hexCharDump } = require('./biffh');
const { pyRepr, pyBytesRepr } = require('./pystr');
const { pyFloatRepr } = require('./pycsv');
const { strToFloat } = require('./pyunicode');
const { FUNC_DEFS, ONAMES, SZDICT, T_ATTR_NAMES } = require('./xlformula-data');

const [oREL, oREF, oUNK, oSTRG, oNUM, oBOOL, oERR, oMSNG] = [-2, -1, 0, 1, 2, 3, 4, 5];
const OKIND = { '-2': 'oREL', '-1': 'oREF', 0: 'oUNK', 1: 'oSTRG', 2: 'oNUM', 3: 'oBOOL', 4: 'oERR', 5: 'oMSNG' };
const LEAF_RANK = 90;
const FUNC_RANK = 90;
const STACK_ALARM_LEVEL = 5;
const STACK_PANIC_LEVEL = 10;
const ERROR_OPCODES = new Set([0x07, 0x08, 0x0A, 0x0B, 0x1C, 0x1D, 0x2F]);
const ERROR_TEXT_FROM_CODE = new Map([
  [0x00, '#NULL!'], [0x07, '#DIV/0!'], [0x0F, '#VALUE!'], [0x17, '#REF!'], [0x1D, '#NAME?'], [0x24, '#NUM!'],
  [0x2A, '#N/A'],
]);

const hex2 = (n) => n.toString(16).padStart(2, '0');
const typeError = (msg) => pyError('TypeError', msg);
const zeroDivision = (msg) => pyError('ZeroDivisionError', msg);
const formulaError = (msg) => pyError('xlrd.formula.FormulaError', msg);

/** Python list[i] for a negative or positive index, raising IndexError outside the list. */
function item(list, i) {
  const k = i < 0 ? i + list.length : i;
  if (k < 0 || k >= list.length) throw pyError('IndexError', 'list index out of range');
  return list[k];
}

/** Python ascii() of a repr text: non-ASCII characters escaped. */
function ascii(text) {
  return text.replace(/[^\x00-\x7f]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff) return `\\x${hex2(cp)}`;
    return cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\U${cp.toString(16).padStart(8, '0')}`;
  });
}

/** A Python complex number (the result of a negative float raised to a fractional power). */
class PyComplex {
  constructor(re, im) {
    this.re = re;
    this.im = im;
  }
}

/**
 * formula.Ref3D: a box of cells, coords (shtxlo, shtxhi, rowxlo, rowxhi, colxlo, colxhi) and their relative flags.
 */
class Ref3D {
  /** @param {number[]} atuple the 6 coords, optionally followed by the 6 relflags */
  constructor(atuple) {
    this.t = atuple;
    this.coords = atuple.slice(0, 6);
    this.relflags = atuple.length > 6 ? atuple.slice(6, 12) : [0, 0, 0, 0, 0, 0];
  }

  repr() {
    const tup = (a) => `(${a.join(', ')})`;
    if (this.relflags.every((f) => f === 0)) return `Ref3D(coords=${tup(this.coords)})`;
    return `Ref3D(coords=${tup(this.coords)}, relflags=${tup(this.relflags)})`;
  }
}

/** formula.Operand: a formula value of a kind (oREF, oNUM, ...), with the rank and text used to rebuild the text. */
class Operand {
  constructor(kind = oUNK, value = null, rank = 0, text = '?') {
    this.kind = kind;
    this.value = value;
    this.rank = rank;
    this.text = text;
  }

  repr() {
    return `Operand(kind=${OKIND[this.kind] || '?Unknown kind?'}, value=${repr(this.value)}, text=${pyRepr(this.text)})`;
  }
}

// Python values: None is null, int a BigInt, float a number, str a string, complex a PyComplex, list an Array.
function typeName(v) {
  if (v === null) return 'NoneType';
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'number') return 'float';
  if (typeof v === 'string') return 'str';
  return v instanceof PyComplex ? 'complex' : 'list';
}

/** repr() of a float without the ".0" xlrd's complex parts drop, signed when asked. */
function shortFloat(x, sign) {
  const s = pyFloatRepr(x).replace(/\.0$/, '');
  return sign && !s.startsWith('-') ? `+${s}` : s;
}

function repr(v) {
  if (v === null) return 'None';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'number') return pyFloatRepr(v);
  if (typeof v === 'string') return pyRepr(v);
  if (v instanceof PyComplex) {
    if (v.re === 0 && !Object.is(v.re, -0)) return `${shortFloat(v.im, false)}j`;
    return `(${shortFloat(v.re, false)}${shortFloat(v.im, true)}j)`;
  }
  if (Array.isArray(v)) return `[${v.map(repr).join(', ')}]`;
  return v.repr();
}

const str = (v) => (typeof v === 'string' ? v : repr(v));
const isNum = (v) => typeof v === 'bigint' || typeof v === 'number' || v instanceof PyComplex;

/** float(int) as Python converts an int operand: OverflowError when it does not fit a double. */
function toFloat(v) {
  if (typeof v !== 'bigint') return v;
  const f = Number(v);
  if (!Number.isFinite(f)) throw pyError('OverflowError', 'int too large to convert to float');
  return f;
}

const toComplex = (v) => (v instanceof PyComplex ? v : new PyComplex(toFloat(v), 0));
const cprod = (a, b) => new PyComplex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const C1 = new PyComplex(1, 0);

/** _Py_c_quot; null where C sets errno EDOM (division by zero). */
function cquot(a, b) {
  const abr = Math.abs(b.re);
  const abi = Math.abs(b.im);
  if (abr >= abi) {
    if (abr === 0) return null;
    const ratio = b.im / b.re;
    const denom = b.re + b.im * ratio;
    return new PyComplex((a.re + a.im * ratio) / denom, (a.im - a.re * ratio) / denom);
  }
  if (abi >= abr) {
    const ratio = b.re / b.im;
    const denom = b.re * ratio + b.im;
    return new PyComplex((a.re * ratio + a.im) / denom, (a.im * ratio - a.re) / denom);
  }
  return new PyComplex(NaN, NaN);
}

/** complex_pow: c_powi for small integral exponents, else _Py_c_pow. */
function complexPow(a, b) {
  let p;
  let edom = false;
  if (b.im === 0 && b.re === Math.floor(b.re) && Math.abs(b.re) <= 100) {
    const powu = (x, n) => {
      let r = C1;
      let q = x;
      for (let mask = 1; mask > 0 && n >= mask; mask <<= 1) {
        if (n & mask) r = cprod(r, q);
        q = cprod(q, q);
      }
      return r;
    };
    p = b.re > 0 ? powu(a, b.re) : cquot(C1, powu(a, -b.re));
    if (!p) {
      edom = true;
      p = new PyComplex(0, 0);
    }
  } else if (b.re === 0 && b.im === 0) {
    p = C1;
  } else if (a.re === 0 && a.im === 0) {
    edom = b.im !== 0 || b.re < 0;
    p = new PyComplex(0, 0);
  } else {
    const vabs = Math.hypot(a.re, a.im);
    let len = Math.pow(vabs, b.re);
    const at = Math.atan2(a.im, a.re);
    let phase = at * b.re;
    if (b.im !== 0) {
      len /= Math.exp(at * b.im);
      phase += b.im * Math.log(vabs);
    }
    p = new PyComplex(len * Math.cos(phase), len * Math.sin(phase));
  }
  if (edom) throw zeroDivision('0.0 to a negative or complex power');
  if (Math.abs(p.re) === Infinity || Math.abs(p.im) === Infinity) throw pyError('OverflowError', 'complex exponentiation');
  return p;
}

/** float_pow, with its special cases, the complex result of a negative base and its errors. */
function floatPow(iv, iw) {
  if (iw === 0) return 1;
  if (Number.isNaN(iv)) return iv;
  if (Number.isNaN(iw)) return iv === 1 ? 1 : iw;
  if (!Number.isFinite(iw)) {
    const v = Math.abs(iv);
    if (v === 1) return 1;
    return (iw > 0) === (v > 1) ? Math.abs(iw) : 0;
  }
  const odd = Math.abs(iw) % 2 === 1;
  if (!Number.isFinite(iv)) {
    if (iw > 0) return odd ? iv : Math.abs(iv);
    return odd ? (iv < 0 ? -0 : 0) : 0;
  }
  if (iv === 0) {
    if (iw < 0) throw zeroDivision('0.0 cannot be raised to a negative power');
    return odd ? iv : 0;
  }
  let negate = false;
  if (iv < 0) {
    if (iw !== Math.floor(iw)) return complexPow(new PyComplex(iv, 0), new PyComplex(iw, 0));
    iv = -iv;
    negate = odd;
  }
  if (iv === 1) return negate ? -1 : 1;
  const ix = Math.pow(iv, iw);
  if (!Number.isFinite(ix)) throw pyError('OverflowError', "(34, 'Numerical result out of range')");
  return negate ? -ix : ix;
}

/** int / int, correctly rounded as long_true_divide rounds it. */
function intTrueDiv(a, b) {
  if (b === 0n) throw zeroDivision('division by zero');
  const lim = 2n ** 53n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  if (x <= lim && y <= lim) return Number(a) / Number(b);
  const bits = (n) => n.toString(2).length;
  const shift = Math.max(0, 55 + bits(y) - bits(x));
  const q = (x << BigInt(shift)) / y;
  const sticky = (x << BigInt(shift)) % y ? 1n : 0n;
  let f = Number(q * 2n + sticky);
  for (let k = shift + 1; k > 0; k -= 1000) f *= 2 ** -Math.min(k, 1000);
  if (!Number.isFinite(f)) throw pyError('OverflowError', 'integer division result too large for a float');
  return (a < 0n) !== (b < 0n) ? -f : f;
}

const OP_SYMS = { add: '+', sub: '-', mul: '*', div: '/', pow: '** or pow()' };

/** A Python binary arithmetic operator (+ - * / **) on folded values. */
function binop(op, a, b) {
  if (isNum(a) && isNum(b)) {
    if (a instanceof PyComplex || b instanceof PyComplex) {
      const [x, y] = [toComplex(a), toComplex(b)];
      if (op === 'add') return new PyComplex(x.re + y.re, x.im + y.im);
      if (op === 'sub') return new PyComplex(x.re - y.re, x.im - y.im);
      if (op === 'mul') return cprod(x, y);
      if (op === 'pow') return complexPow(x, y);
      const r = cquot(x, y);
      if (!r) throw zeroDivision('complex division by zero');
      return r;
    }
    if (typeof a === 'bigint' && typeof b === 'bigint') {
      if (op === 'add') return a + b;
      if (op === 'sub') return a - b;
      if (op === 'mul') return a * b;
      if (op === 'div') return intTrueDiv(a, b);
      return b < 0n ? floatPow(toFloat(a), toFloat(b)) : a ** b;
    }
    const [x, y] = [toFloat(a), toFloat(b)];
    if (op === 'add') return x + y;
    if (op === 'sub') return x - y;
    if (op === 'mul') return x * y;
    if (op === 'pow') return floatPow(x, y);
    if (y === 0) throw zeroDivision('float division by zero');
    return x / y;
  }
  const seq = (v) => typeof v === 'string' || Array.isArray(v);
  if (op === 'add' && seq(a)) {
    if (typeName(a) !== typeName(b)) {
      throw typeError(`can only concatenate ${typeName(a)} (not "${typeName(b)}") to ${typeName(a)}`);
    }
    return a.concat(b);
  }
  if (op === 'mul' && (seq(a) || seq(b))) {
    const [s, n] = seq(a) ? [a, b] : [b, a];
    if (typeof n !== 'bigint') throw typeError(`can't multiply sequence by non-int of type '${typeName(n)}'`);
    if (n >= 2n ** 63n || n < -(2n ** 63n)) throw pyError('OverflowError', "cannot fit 'int' into an index-sized integer");
    const k = n > 0n ? Number(n) : 0;
    return typeof s === 'string' ? s.repeat(k) : Array.from({ length: k }, () => s).flat();
  }
  throw typeError(`unsupported operand type(s) for ${OP_SYMS[op]}: '${typeName(a)}' and '${typeName(b)}'`);
}

/** Python ==. */
function pyEq(a, b) {
  if (isNum(a) && isNum(b)) {
    if (a instanceof PyComplex || b instanceof PyComplex) {
      const [x, y] = a instanceof PyComplex ? [a, b] : [b, a];
      if (y instanceof PyComplex) return x.re === y.re && x.im === y.im;
      return x.im === 0 && x.re == y; // eslint-disable-line eqeqeq
    }
    return a == b; // eslint-disable-line eqeqeq
  }
  if (typeName(a) !== typeName(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (a instanceof Ref3D) return a.t.length === b.t.length && a.t.every((x, i) => x === b.t[i]);
  return a === b;
}

/** Python ordering of two values as a sign (NaN where unordered), or TypeError for types without one. */
function order(a, b, sym) {
  const real = (v) => typeof v === 'bigint' || typeof v === 'number';
  const sign = (x, y) => (x < y ? -1 : x > y ? 1 : x == y ? 0 : NaN); // eslint-disable-line eqeqeq
  if (real(a) && real(b)) return sign(a, b);
  if (typeof a === 'string' && typeof b === 'string') {
    const [x, y] = [[...a], [...b]];
    const i = x.findIndex((c, k) => k >= y.length || c !== y[k]);
    if (i < 0) return sign(x.length, y.length);
    return i >= y.length ? 1 : sign(x[i].codePointAt(0), y[i].codePointAt(0));
  }
  const seqOf = (v) => (Array.isArray(v) ? v : v instanceof Ref3D ? v.t : null);
  const [x, y] = [seqOf(a), seqOf(b)];
  if (x && y && Array.isArray(a) === Array.isArray(b)) {
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (!pyEq(x[i], y[i])) return order(x[i], y[i], sym);
    return sign(x.length, y.length);
  }
  throw typeError(`'${sym}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

const CMP_OPS = {
  '<': (c) => c < 0, '<=': (c) => c <= 0, '>=': (c) => c >= 0, '>': (c) => c > 0,
};

/** A Python comparison operator, as a bool. */
function compare(sym, a, b) {
  if (sym === '==') return pyEq(a, b);
  if (sym === '<>') return !pyEq(a, b);
  return CMP_OPS[sym](order(a, b, sym));
}

/** int(): truncation of a real number; a complex is a TypeError. */
function pyInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  throw typeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`);
}

/** formula.num2strg: str(), without a trailing ".0". */
function num2strg(num) {
  const s = str(num);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

const nop = (x) => x;
const ARITH_ARGS = { [oNUM]: nop, [oSTRG]: strToFloat };
const CMP_ARGS = { [oNUM]: nop, [oSTRG]: nop };
const STRG_ARGS = { [oNUM]: num2strg, [oSTRG]: nop };
const arith = (op) => (x, y) => binop(op, x, y);
const cmp = (sym) => (x, y) => compare(sym, x, y);
// formula.binop_rules: [argument conversions, result kind, function, rank, symbol]
const BINOP_RULES = {
  0x03: [ARITH_ARGS, oNUM, arith('add'), 30, '+'],
  0x04: [ARITH_ARGS, oNUM, arith('sub'), 30, '-'],
  0x05: [ARITH_ARGS, oNUM, arith('mul'), 40, '*'],
  0x06: [ARITH_ARGS, oNUM, arith('div'), 40, '/'],
  0x07: [ARITH_ARGS, oNUM, arith('pow'), 50, '^'],
  0x08: [STRG_ARGS, oSTRG, arith('add'), 20, '&'],
  0x09: [CMP_ARGS, oBOOL, cmp('<'), 10, '<'],
  0x0A: [CMP_ARGS, oBOOL, cmp('<='), 10, '<='],
  0x0B: [CMP_ARGS, oBOOL, cmp('=='), 10, '='],
  0x0C: [CMP_ARGS, oBOOL, cmp('>='), 10, '>='],
  0x0D: [CMP_ARGS, oBOOL, cmp('>'), 10, '>'],
  0x0E: [CMP_ARGS, oBOOL, cmp('<>'), 10, '<>'],
};

function neg(v) {
  if (typeof v === 'bigint' || typeof v === 'number') return -v;
  if (v instanceof PyComplex) return new PyComplex(-v.re, -v.im);
  throw typeError(`bad operand type for unary -: '${typeName(v)}'`);
}

// formula.unop_rules: [function, rank, prefix, suffix]
const UNOP_RULES = {
  0x13: [neg, 70, '-', ''],
  0x12: [nop, 70, '+', ''],
  0x14: [(x) => binop('div', x, 100), 60, '', '%'],
};

/** formula.adjust_cell_addr_biff8 / adjust_cell_addr_biff_le7 with reldelta set, as names use them. */
function adjustCellAddr(rowval, colval, bv) {
  if (bv >= 80) {
    const rowRel = (colval >> 15) & 1;
    const colRel = (colval >> 14) & 1;
    const colx = colval & 0xff;
    return [rowRel && rowval >= 32768 ? rowval - 65536 : rowval, colRel && colx >= 128 ? colx - 256 : colx, rowRel, colRel];
  }
  const rowRel = (rowval >> 15) & 1;
  const colRel = (rowval >> 14) & 1;
  const rowx = rowval & 0x3fff;
  return [rowRel && rowx >= 8192 ? rowx - 16384 : rowx, colRel && colval >= 128 ? colval - 256 : colval, rowRel, colRel];
}

/** formula.get_cell_addr. */
function getCellAddr(data, pos, bv) {
  const [rowval, colval] = bv >= 80 ? unpack('<HH', data.subarray(pos, pos + 4)) : unpack('<HB', data.subarray(pos, pos + 3));
  return adjustCellAddr(rowval, colval, bv);
}

/** formula.get_cell_range_addr. */
function getCellRangeAddr(data, pos, bv) {
  const [r1, r2, c1, c2] = bv >= 80
    ? unpack('<HHHH', data.subarray(pos, pos + 8)) : unpack('<HHBB', data.subarray(pos, pos + 6));
  return [adjustCellAddr(r1, c1, bv), adjustCellAddr(r2, c2, bv)];
}

const tuple = (a) => `(${a.join(', ')})`;

/** formula.get_externsheet_local_range (BIFF8): the sheet range of an EXTERNSHEET reference, negative if not local. */
function getExternsheetLocalRange(bk, refx, blah) {
  const info = bk.externsheetInfo[refx];
  const say = (s) => bk.log(`/// get_externsheet_local_range(refx=${refx}) -> ${s}\n`);
  if (info === undefined) {
    bk.log(`!!! get_externsheet_local_range: refx=${refx}, not in range(${bk.externsheetInfo.length})\n`);
    return [-101, -101];
  }
  const [recordx, first, last] = info;
  if (recordx === bk.supbookAddinsInx) {
    if (blah) say(`addins ${tuple(info)}`);
    if (!(first === 0xFFFE && last === 0xFFFE)) throw assertionError();
    return [-5, -5];
  }
  if (recordx !== bk.supbookLocalsInx) {
    if (blah) say(`external ${tuple(info)}`);
    return [-4, -4];
  }
  if (first === 0xFFFE && last === 0xFFFE) {
    if (blah) say(`unspecified sheet ${tuple(info)}`);
    return [-1, -1];
  }
  if (first === 0xFFFF && last === 0xFFFF) {
    if (blah) say('deleted sheet(s)');
    return [-2, -2];
  }
  const nsheets = bk.allSheetsMap.length;
  if (!(first <= last && last < nsheets)) {
    if (blah) {
      say(tuple(info));
      bk.log(`--- first/last sheet not in range(${nsheets})\n`);
    }
    return [-102, -102];
  }
  return localSheets(bk, first, last);
}

function localSheets(bk, first, last) {
  const [x1, x2] = [bk.allSheetsMap[first], bk.allSheetsMap[last]];
  return x1 >= 0 && x1 <= x2 ? [x1, x2] : [-3, -3];
}

/** formula.get_externsheet_local_range_b57 (BIFF5/7). */
function getExternsheetLocalRangeB57(bk, rawExtshtx, first, last, blah) {
  if (rawExtshtx > 0) {
    if (blah) bk.log(`/// get_externsheet_local_range_b57(raw_extshtx=${rawExtshtx}) -> external\n`);
    return [-4, -4];
  }
  if (first === -1 && last === -1) return [-2, -2];
  const nsheets = bk.allSheetsMap.length;
  if (!(first >= 0 && first <= last && last < nsheets)) {
    if (blah) {
      bk.log(`/// get_externsheet_local_range_b57(${rawExtshtx}, ${first}, ${last}) -> ???\n`);
      bk.log(`--- first/last sheet not in range(${nsheets})\n`);
    }
    return [-103, -103];
  }
  return localSheets(bk, first, last);
}

const SHEET_PLACEHOLDERS = {
  '-1': '?internal; any sheet?', '-2': 'internal; deleted sheet', '-3': 'internal; macro sheet', '-4': '<<external>>',
};

/** formula.quotedsheetname. */
function quotedSheetName(shnames, shx) {
  const shname = shx >= 0 ? item(shnames, shx) : SHEET_PLACEHOLDERS[shx] || `?error ${shx}?`;
  if (shname.includes("'")) return `'${shname.replace(/'/g, "''")}'`;
  return shname.includes(' ') ? `'${shname}'` : shname;
}

/** formula.sheetrange. */
function sheetRange(bk, slo, shi) {
  const shdesc = quotedSheetName(bk.sheetNames, slo);
  return slo !== shi - 1 ? `${shdesc}:${quotedSheetName(bk.sheetNames, shi - 1)}` : shdesc;
}

/** formula.colname. */
function colname(colx) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return colx <= 25 ? alphabet[colx] : alphabet[Math.floor(colx / 26) - 1] + alphabet[colx % 26];
}

/** formula.rangename3d: an absolute 3D reference in A1 style, e.g. Sheet2:Sheet3!$H$6:$J$20. */
function rangename3d(bk, ref3d) {
  const [slo, shi, rlo, rhi, clo, chi] = ref3d.coords;
  const abs = (r, c) => `$${colname(c)}$${r + 1}`;
  const rng = rhi === rlo + 1 && chi === clo + 1 ? abs(rlo, clo) : `${abs(rlo, clo)}:${abs(rhi - 1, chi - 1)}`;
  return `${sheetRange(bk, slo, shi)}!${rng}`;
}

/** formula.rangename3drel with no base cell, so in R1C1 style, e.g. Sheet1!R[-32]C[-13]:R[-23]C[12]. */
function rangename3drel(bk, ref3d) {
  const [slo, shi, rlo, rhi, clo, chi] = ref3d.coords;
  const [, , rlorel, rhirel, clorel, chirel] = ref3d.relflags;
  const part = (x, rel, axis) => {
    if (!rel) return `${axis}${x + 1}`;
    return x ? `${axis}[${x}]` : axis;
  };
  const cell = (r, c, rrel, crel) => {
    if (!rrel && !crel) return `R${r + 1}C${c + 1}`;
    return part(r, rrel, 'R') + part(c, crel, 'C');
  };
  return `${sheetRange(bk, slo, shi)}!${cell(rlo, clo, rlorel, clorel)}:${cell(rhi - 1, chi - 1, rhirel, chirel)}`;
}

/** BaseObject.dump of a Name, as xlrd logs a name with problems while debugging. */
function dumpName(bk, nobj, header, footer) {
  const attrs = [
    ['any_err', String(nobj.anyErr)], ['any_external', '0'], ['any_rel', nobj.anyRel ? 'True' : 'False'],
    ['basic_formula_len', nobj.basicFormulaLen], ['binary', nobj.binary], ['book', bk.objectRepr],
    ['builtin', nobj.builtin], ['complex', nobj.complex], ['evaluated', 1], ['excel_sheet_index', nobj.excelSheetIndex],
    ['extn_sheet_num', nobj.extnSheetNum], ['func', nobj.func], ['funcgroup', nobj.funcgroup], ['hidden', nobj.hidden],
    ['macro', nobj.macro], ['name', pyRepr(nobj.name)], ['name_index', nobj.nameIndex],
    ['option_flags', nobj.optionFlags], ['raw_formula', pyBytesRepr(nobj.rawFormula)], ['result', repr(nobj.result)],
    ['scope', nobj.scope], ['stack', repr(nobj.stack)], ['vbasic', nobj.vbasic],
  ];
  bk.log(`${header}\n${attrs.map(([a, v]) => `${a}: ${ascii(String(v))}\n`).join('')}${footer}\n`);
}

/**
 * formula.evaluate_name_formula: evaluates a defined name's formula (recursing into the names it refers to) and
 * sets the name's stack, result, any_rel, any_err, any_external and evaluated.
 * @param {object} bk the Book (biffVersion, encoding, log, nameObjList, sheetNames, allSheetsMap, externsheetInfo,
 *   externsheetTypeB57, supbookLocalsInx, supbookAddinsInx)
 * @param {object} nobj the Name (rawFormula, basicFormulaLen, name, scope, macro, binary, ...)
 * @param {number} namex the name's index in bk.nameObjList
 * @param {boolean} blah log the evaluation steps
 * @param {number} level the depth of indirection
 * @returns {void}
 * @throws {Error} pyName xlrd.formula.FormulaError for tokens a name formula may not hold, xlrd.biffh.XLRDError for
 *   more than 10 levels of indirection, AssertionError, struct.error, IndexError and KeyError for malformed
 *   tokens, and the TypeError, ValueError, ZeroDivisionError or OverflowError of folding constants
 */
function evaluateNameFormula(bk, nobj, namex, blah = false, level = 0) {
  if (level > STACK_ALARM_LEVEL) blah = true;
  const data = nobj.rawFormula;
  const fmlalen = nobj.basicFormulaLen;
  const bv = bk.biffVersion;
  const log = (s = '') => bk.log(`${s}\n`);
  if (blah) {
    log(`::: evaluate_name_formula ${namex} ${pyRepr(nobj.name)} ${fmlalen} ${bv} ${pyBytesRepr(data)} level=${level}`);
    hexCharDump(data, 0, fmlalen, bk.log);
  }
  if (level > STACK_PANIC_LEVEL) throw xlrdError('Excessive indirect references in NAME formula');
  const sztab = SZDICT.get(bv);
  let pos = 0;
  let stack = [];
  let anyRel = 0;
  let anyErr = 0;
  const unkOpnd = new Operand(oUNK);
  const errorOpnd = new Operand(oERR);
  const paren = (o, rank) => (o.rank < rank ? `(${o.text})` : o.text);
  const top = (n) => (n ? stack.slice(-n) : stack.slice());
  const need = (n) => {
    if (stack.length < n) throw assertionError();
  };

  const doBinop = (opcd) => {
    need(2);
    const bop = stack.pop();
    const aop = stack.pop();
    const [argdict, resultKind, func, rank, sym] = BINOP_RULES[opcd];
    const resop = new Operand(resultKind, null, rank, paren(aop, rank) + sym + paren(bop, rank));
    const [bconv, aconv] = [argdict[bop.kind], argdict[aop.kind]];
    if (bconv && aconv && bop.value !== null && aop.value !== null) {
      const bval = bconv(bop.value);
      const result = func(aconv(aop.value), bval);
      resop.value = resultKind === oBOOL ? (result ? 1n : 0n) : result;
    }
    stack.push(resop);
  };

  // tIsect, tList and tRange: the box functions of tIsect and tRange, and the rank and symbol of each.
  const doRefop = (opcode) => {
    const name = { 0x0F: 'tIsect', 0x10: 'tList', 0x11: 'tRange' }[opcode];
    if (blah) log(`${name} pre ${repr(stack)}`);
    need(2);
    const bop = stack.pop();
    const aop = stack.pop();
    const sym = { 0x0F: ' ', 0x10: ',', 0x11: ':' }[opcode];
    const res = new Operand(oREF, null, opcode === 0x0F ? 0 : 80, paren(aop, 80) + sym + paren(bop, 80));
    const one = (o) => {
      if (o.value.length !== 1) throw assertionError();
      return o.value[0];
    };
    const box = (a, b) => {
      const f = opcode === 0x0F ? [Math.max, Math.min] : [Math.min, Math.max];
      return a.coords.map((x, i) => f[i % 2](x, b.coords[i]));
    };
    const refs = (k) => k === oREF || k === oREL;
    if (bop.kind === oERR || aop.kind === oERR) {
      res.kind = oERR;
    } else if (opcode === 0x10) {
      if (refs(bop.kind) && refs(aop.kind)) {
        res.kind = aop.kind === oREL || bop.kind === oREL ? oREL : oREF;
        if (aop.value !== null && bop.value !== null) {
          if (aop.value.length < 1) throw assertionError();
          one(bop);
          res.value = aop.value.concat(bop.value);
        }
      }
    } else if (bop.kind === oREF && aop.kind === oREF) {
      if (aop.value !== null && bop.value !== null) res.value = [new Ref3D(box(one(aop), one(bop)))];
    } else if (bop.kind === oREL && aop.kind === oREL) {
      res.kind = oREL;
      if (aop.value !== null && bop.value !== null) {
        const [a, b] = [one(aop), one(bop)];
        if (pyEq(a.relflags, b.relflags)) res.value = [new Ref3D(box(a, b).concat(a.relflags))];
      }
    }
    stack.push(res);
    if (blah) log(`${name} post ${repr(stack)}`);
  };

  // tName and tNameX: the referenced name, evaluated first, as an operand.
  const refName = (tgtnamex, header, footer, tok) => {
    const tgtobj = item(bk.nameObjList, tgtnamex);
    if (!tgtobj.evaluated) evaluateNameFormula(bk, tgtobj, tgtnamex, blah, level + 1);
    let res;
    if (tgtobj.macro || tgtobj.binary || tgtobj.anyErr) {
      if (blah) dumpName(bk, tgtobj, header, footer);
      res = new Operand(oUNK);
      anyErr = anyErr || tgtobj.macro || tgtobj.binary || tgtobj.anyErr;
      anyRel = anyRel || tgtobj.anyRel;
    } else {
      if (tgtobj.stack.length !== 1) throw assertionError();
      const o = tgtobj.stack[0];
      res = new Operand(o.kind, o.value, o.rank, o.text);
    }
    res.rank = LEAF_RANK;
    res.text = tgtobj.scope === -1 ? tgtobj.name : `${item(bk.sheetNames, tgtobj.scope)}!${tgtobj.name}`;
    if (blah) log(`    ${tok}: setting text to ${pyRepr(res.text)}`);
    return res;
  };

  // tRef3d and tArea3d.
  const ref3d = (area, optype) => {
    const [r1, r2] = area ? getCellRangeAddr(data, pos + (bv >= 80 ? 3 : 15), bv) : [];
    const res1 = area ? r1 : getCellAddr(data, pos + (bv >= 80 ? 3 : 15), bv);
    const res2 = area ? r2 : res1;
    let shx1;
    let shx2;
    if (bv >= 80) {
      const [refx] = unpack('<H', data.subarray(pos + 1, pos + 3));
      [shx1, shx2] = getExternsheetLocalRange(bk, refx, blah);
    } else {
      const [raw, s1, s2] = unpack('<hxxxxxxxxhh', data.subarray(pos + 1, pos + 15));
      if (blah) log(`${area ? 'tArea3d' : 'tRef3d'} ${raw} ${s1} ${s2}`);
      [shx1, shx2] = getExternsheetLocalRangeB57(bk, raw, s1, s2, blah);
    }
    const isRel = res1[2] || res1[3] || res2[2] || res2[3];
    anyRel = anyRel || isRel;
    const coords = [shx1, shx2 + 1, res1[0], res2[0] + 1, res1[1], res2[1] + 1];
    anyErr |= shx1 < -1;
    if (blah) log(`    ${tuple(coords)}`);
    const res = new Operand(oUNK);
    let r3d;
    if (isRel) {
      r3d = new Ref3D(coords.concat([0, 0, res1[2], res2[2], res1[3], res2[3]]));
      res.kind = oREL;
      res.text = rangename3drel(bk, r3d);
    } else {
      r3d = new Ref3D(coords);
      res.kind = oREF;
      res.text = rangename3d(bk, r3d);
    }
    res.rank = LEAF_RANK;
    if (optype === 1) res.value = [r3d];
    stack.push(res);
  };

  const notInNameFormula = (op, oname) => {
    throw formulaError(`ERROR *** Token 0x${hex2(op)} (${oname}) found in NAME formula`);
  };

  if (fmlalen === 0) stack = [unkOpnd];
  while (pos >= 0 && pos < fmlalen) {
    const op = byteAt(data, pos);
    const opcode = op & 0x1f;
    const optype = (op & 0x60) >> 5;
    const opx = optype ? opcode + 32 : opcode;
    const oname = ONAMES[opx];
    let sz = sztab[opx];
    if (blah) {
      log(`Pos:${pos} Op:0x${hex2(op)} Name:t${oname} Sz:${sz} opcode:${hex2(opcode)}h optype:${hex2(optype)}h`);
      log(`Stack = ${repr(stack)}`);
    }
    if (sz === -2) throw formulaError(`ERROR *** Unexpected token 0x${hex2(op)} ("${oname}"); biff_version=${bv}`);
    if (!optype) {
      if (opcode <= 0x02) {
        notInNameFormula(op, oname);
      } else if (opcode <= 0x0E) {
        doBinop(opcode);
      } else if (opcode <= 0x11) {
        doRefop(opcode);
      } else if (opcode <= 0x14) {
        need(1);
        const aop = stack.pop();
        const [func, rank, sym1, sym2] = UNOP_RULES[opcode];
        const val = aop.value === null ? null : func(aop.value);
        stack.push(new Operand(oNUM, val, rank, sym1 + paren(aop, rank) + sym2));
      } else if (opcode === 0x15) {
        // tParen only shapes the source text; the operand ranks already rebuild the parentheses.
      } else if (opcode === 0x16) {
        stack.push(new Operand(oMSNG, null, LEAF_RANK, ''));
      } else if (opcode === 0x17) {
        const [strg, newpos] = bv <= 70
          ? unpackStringUpdatePos(data, pos + 1, bk.encoding, 1) : unpackUnicodeUpdatePos(data, pos + 1, 1);
        sz = newpos - pos;
        if (blah) log(`   sz=${sz} strg=${pyRepr(strg)}`);
        stack.push(new Operand(oSTRG, strg, LEAF_RANK, `"${strg.replace(/"/g, '""')}"`));
      } else if (opcode === 0x18) {
        if (bv < 80) throw assertionError();
        // xlrd's own message for tExtended
        throw formulaError('tExtended token not implemented');
      } else if (opcode === 0x19) {
        const [subop, nc] = unpack('<BH', data.subarray(pos + 1, pos + 4));
        sz = 4;
        if (subop === 0x04) {
          sz = nc * 2 + 6;
        } else if (subop === 0x10) {
          if (blah) log(`tAttrSum ${repr(stack)}`);
          need(1);
          stack[stack.length - 1] = new Operand(oNUM, null, FUNC_RANK, `SUM(${stack[stack.length - 1].text})`);
        }
        if (blah) log(`   subop=${hex2(subop)}h subname=t${T_ATTR_NAMES.get(subop) || '??Unknown??'} sz=${sz} nc=${hex2(nc)}h`);
      } else if (opcode <= 0x1B) {
        if (bv >= 50) throw assertionError();
        // xlrd's own message for tSheet and tEndSheet
        throw formulaError('tSheet & tEndsheet tokens not implemented');
      } else if (opcode >= 0x1C) {
        const inx = opcode - 0x1C;
        const nb = [1, 1, 2, 8][inx];
        const [raw] = unpack(`<${'BBHd'[inx]}`, data.subarray(pos + 1, pos + 1 + nb));
        let value = raw;
        let text;
        if (inx >= 2) {
          text = pyFloatRepr(raw);
        } else if (inx === 1) {
          if (raw > 1) throw pyError('IndexError', 'tuple index out of range');
          text = ['FALSE', 'TRUE'][raw];
          value = BigInt(raw);
        } else {
          if (!ERROR_TEXT_FROM_CODE.has(raw)) throw pyError('KeyError', String(raw));
          text = `"${ERROR_TEXT_FROM_CODE.get(raw)}"`;
          value = BigInt(raw);
        }
        stack.push(new Operand([oERR, oBOOL, oNUM, oNUM][inx], value, LEAF_RANK, text));
      }
      if (sz <= 0) throw formulaError(`Size not set for opcode 0x${hex2(opcode)}`);
      pos += sz;
      continue;
    }
    if (opcode === 0x00) {
      stack.push(unkOpnd);
    } else if (opcode === 0x01 || opcode === 0x02) {
      const nb = bv >= 40 ? 2 : 1;
      const fmt = ' BH'[nb];
      let funcx;
      let nargs;
      if (opcode === 0x01) {
        [funcx] = unpack(`<${fmt}`, data.subarray(pos + 1, pos + 1 + nb));
      } else {
        [nargs, funcx] = unpack(`<B${fmt}`, data.subarray(pos + 1, pos + 2 + nb));
        const prompt = Math.floor(nargs / 128);
        const macro = Math.floor(funcx / 32768);
        nargs %= 128;
        funcx %= 32768;
        if (blah) log(`   FuncID=${funcx} nargs=${nargs} macro=${macro} prompt=${prompt}`);
      }
      const funcAttrs = FUNC_DEFS.get(funcx);
      if (!funcAttrs) {
        log(`*** formula/${opcode === 0x01 ? 'tFunc' : 'tFuncVar'} unknown FuncID:${funcx}`);
        stack.push(unkOpnd);
      } else if (opcode === 0x01) {
        const [funcName, n] = funcAttrs;
        if (blah) log(`    FuncID=${funcx} name=${funcName} nargs=${n}`);
        need(n);
        const otext = `${funcName}(${n ? top(n).map((a) => a.text).join(',') : ''})`;
        if (n) stack.splice(-n);
        stack.push(new Operand(oUNK, null, FUNC_RANK, otext));
      } else {
        const [funcName, minargs, maxargs] = funcAttrs;
        if (blah) log(`    name: ${pyRepr(funcName)}, min~max args: ${minargs}~${maxargs}`);
        if (!(minargs <= nargs && nargs <= maxargs)) throw assertionError();
        need(nargs);
        const res = new Operand(oUNK, null, FUNC_RANK, `${funcName}(${top(nargs).map((a) => a.text).join(',')})`);
        const testarg = nargs ? stack[stack.length - nargs] : stack[0];
        const pick = (k) => {
          const chosen = stack[stack.length - nargs + k];
          [res.kind, res.value] = chosen.kind === oMSNG ? [oNUM, 0n] : [chosen.kind, chosen.value];
        };
        if (funcx === 1) {
          if (testarg.kind !== oNUM && testarg.kind !== oBOOL) {
            if (blah && testarg.kind !== oUNK) log('IF testarg kind?');
          } else if (!pyEq(testarg.value, 0n) && !pyEq(testarg.value, 1n)) {
            if (blah && testarg.value !== null) log('IF testarg value?');
          } else {
            if (nargs === 2 && pyEq(testarg.value, 0n)) [res.kind, res.value] = [oBOOL, 0n];
            else pick(2 - Number(pyInt(testarg.value)));
            if (blah) log('$$$$$$ IF => constant');
          }
        } else if (funcx === 100 && testarg.kind === oNUM) {
          if (compare('<=', 1n, testarg.value) && compare('<', testarg.value, BigInt(nargs))) {
            pick(Number(pyInt(testarg.value)));
          }
        }
        stack.splice(nargs ? stack.length - nargs : 0);
        stack.push(res);
      }
    } else if (opcode === 0x03) {
      const tgtnamex = unpack('<H', data.subarray(pos + 1, pos + 3))[0] - 1;
      if (blah) log(`   tgtnamex=${tgtnamex}`);
      stack.push(refName(tgtnamex, '!!! tgtobj has problems!!!', '-----------       --------', 'tName'));
    } else if (opcode === 0x04 || opcode === 0x05) {
      const [res1, res2] = opcode === 0x05 ? getCellRangeAddr(data, pos + 1, bv) : [getCellAddr(data, pos + 1, bv)];
      if (blah) log(`   ${tuple(res1)}${res2 ? ` ${tuple(res2)}` : ''}`);
      const end = res2 || res1;
      anyRel = 1;
      const coords = [0, 1, res1[0], end[0] + 1, res1[1], end[1] + 1];
      if (blah) log(`    ${tuple(coords)}`);
      const relflags = [1, 1, res1[2], end[2], res1[3], end[3]];
      stack.push(optype === 1 ? new Operand(oREL, [new Ref3D(coords.concat(relflags))]) : new Operand(oUNK));
    } else if (opcode === 0x06 || opcode === 0x0C || opcode === 0x0D) {
      notInNameFormula(op, oname);
    } else if (opcode === 0x09) {
      const [nb] = unpack('<H', data.subarray(pos + 1, pos + 3));
      if (blah) log(`  ${nb} bytes of cell ref formula`);
    } else if (opcode === 0x1A || opcode === 0x1B) {
      ref3d(opcode === 0x1B, optype);
    } else if (opcode === 0x19) {
      let dodgy = 0;
      let refx;
      let tgtnamex;
      if (bv >= 80) {
        [refx, tgtnamex] = unpack('<HH', data.subarray(pos + 1, pos + 5));
      } else {
        [refx, tgtnamex] = unpack('<hxxxxxxxxH', data.subarray(pos + 1, pos + 13));
      }
      tgtnamex -= 1;
      const origrefx = refx;
      if (bv < 80) {
        if (refx > 0) refx -= 1;
        else if (refx < 0) refx = -refx - 1;
        else dodgy = 1;
      }
      if (blah) log(`   origrefx=${origrefx} refx=${refx} tgtnamex=${tgtnamex} dodgy=${dodgy}`);
      if (tgtnamex === namex) {
        if (blah) log('!!!! Self-referential !!!!');
        dodgy = anyErr = 1;
      }
      let shx1;
      if (!dodgy) {
        if (bv >= 80) [shx1] = getExternsheetLocalRange(bk, refx, blah);
        else if (origrefx > 0) shx1 = -4;
        else shx1 = item(bk.externsheetTypeB57, refx) === 4 ? -1 : -666;
      }
      if (dodgy || shx1 < -1) {
        stack.push(new Operand(oUNK, null, LEAF_RANK, `<<Name #${tgtnamex} in external(?) file #${origrefx}>>`));
      } else {
        stack.push(refName(tgtnamex, '!!! bad tgtobj !!!', '------------------', 'tNameX'));
      }
    } else if (ERROR_OPCODES.has(opcode)) {
      anyErr = 1;
      stack.push(errorOpnd);
    } else {
      if (blah) log(`FORMULA: /// Not handled yet: t${oname}`);
      anyErr = 1;
    }
    if (sz <= 0) throw formulaError('Fatal: token size is not positive');
    pos += sz;
  }
  anyRel = Boolean(anyRel);
  if (blah) {
    log(`End of formula. level=${level} any_rel=${Number(anyRel)} any_err=${Number(anyErr)} stack=${ascii(repr(stack))}`);
    if (stack.length >= 2) log('*** Stack has unprocessed args');
    log();
  }
  nobj.stack = stack;
  nobj.result = stack.length !== 1 ? null : stack[0];
  nobj.anyRel = anyRel;
  nobj.anyErr = anyErr;
  nobj.anyExternal = 0;
  nobj.evaluated = 1;
}

module.exports = { evaluateNameFormula, Operand, Ref3D };
