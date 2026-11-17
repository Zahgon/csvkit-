'use strict';
// Port of dbfread 2.0.7 (MIT) as agate-dbf 0.2.4 uses it: DBF(path, load=True, recfactory=tuple of values) with
// its header and field-descriptor parsing, code page guess from the language driver byte, record and deleted
// record iteration, FieldParser value types and the FPT/DBT memo files.

const fs = require('node:fs');
const { pyError, osError, structError } = require('./pyerrors');
const codecs = require('./codecs');
const { Decimal } = require('./decimal');
const { PyFloat } = require('./pyjson');
const { PyDate } = require('./types');
const { pyBytesRepr, pyRepr } = require('./pystr');
const { timedeltaMicros, addToEpoch } = require('./xldate');
const { ordToYmd } = require('./pydatetime');
const { splitext } = require('./pypath');

// dbfread.codepages: language driver byte to Python codec.
const CODEPAGES = {
  0x00: 'ascii', 0x01: 'cp437', 0x02: 'cp850', 0x03: 'cp1252', 0x04: 'mac_roman', 0x08: 'cp865', 0x09: 'cp437',
  0x0a: 'cp850', 0x0b: 'cp437', 0x0d: 'cp437', 0x0e: 'cp850', 0x0f: 'cp437', 0x10: 'cp850', 0x11: 'cp437',
  0x12: 'cp850', 0x13: 'cp932', 0x14: 'cp850', 0x15: 'cp437', 0x16: 'cp850', 0x17: 'cp865', 0x18: 'cp437',
  0x19: 'cp437', 0x1a: 'cp850', 0x1b: 'cp437', 0x1c: 'cp863', 0x1d: 'cp850', 0x1f: 'cp852', 0x22: 'cp852',
  0x23: 'cp852', 0x24: 'cp860', 0x25: 'cp850', 0x26: 'cp866', 0x37: 'cp850', 0x40: 'cp852', 0x4d: 'cp936',
  0x4e: 'cp949', 0x4f: 'cp950', 0x50: 'cp874', 0x57: 'cp1252', 0x58: 'cp1252', 0x59: 'cp1252', 0x64: 'cp852',
  0x65: 'cp866', 0x66: 'cp865', 0x67: 'cp861', 0x6a: 'cp737', 0x6b: 'cp857', 0x78: 'cp950', 0x79: 'cp949',
  0x7a: 'cp936', 0x7b: 'cp932', 0x7c: 'cp874', 0x7d: 'cp1255', 0x7e: 'cp1256', 0xc8: 'cp1250', 0xc9: 'cp1251',
  0xca: 'cp1254', 0xcb: 'cp1253', 0x96: 'mac_cyrillic', 0x97: 'mac_latin2', 0x98: 'mac_greek',
};

// FieldParser's parse<letter> methods, plus parse2B ('+') and parse40 ('@').
const SUPPORTED_TYPES = new Set(['0', 'C', 'D', 'F', 'I', 'L', 'M', 'N', 'O', 'T', 'Y', 'B', 'G', 'P', '+', '@', 'V']);
const BYTES_WS = [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c];
const JULIAN_OFFSET = 1721425;

/** A Python bytes value; str() of it is its repr. */
class PyBytes {
  /** @param {Buffer} buf */
  constructor(buf) { this.buf = buf; }

  /** @returns {string} repr(bytes), e.g. b'\x00' */
  pyStr() { return pyBytesRepr(this.buf); }
}

function strip(b, chars) {
  let a = 0;
  let e = b.length;
  while (a < e && chars.includes(b[a])) a++;
  while (e > a && chars.includes(b[e - 1])) e--;
  return b.subarray(a, e);
}

/** int() of bytes, raising Python's ValueError. */
function bytesInt(b) {
  const t = strip(b, BYTES_WS).toString('latin1');
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) throw pyError('ValueError', `invalid literal for int() with base 10: ${pyBytesRepr(b)}`);
  return BigInt(t.replace(/_/g, ''));
}

/** float() of bytes, raising Python's ValueError. */
function bytesFloat(b) {
  const t = strip(b, BYTES_WS).toString('latin1').replace(/(\d)_(?=\d)/g, '$1');
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (m) return m[2].toLowerCase() === 'nan' ? NaN : (m[1] === '-' ? -Infinity : Infinity);
  throw pyError('ValueError', `could not convert string to float: ${pyBytesRepr(b)}`);
}

const GLOB_MAGIC = /[*?[]/;

/** os.path.split: the head without its trailing slashes (unless it is all slashes) and the last component. */
function splitPath(p) {
  const i = p.lastIndexOf('/') + 1;
  let head = p.slice(0, i);
  if (head && !/^\/+$/.test(head)) head = head.replace(/\/+$/, '');
  return [head, p.slice(i)];
}

/** os.path.join of two components. */
function joinPath(a, b) {
  if (b.startsWith('/') || !a) return b;
  return a.endsWith('/') ? a + b : `${a}/${b}`;
}

/**
 * fnmatch.translate as a JavaScript regular expression: *, ?, [seq] and [!seq], with an unclosed [ taken literally
 * and reversed ranges dropped. A * matches the same names as Python's atomic groups, so it becomes .*.
 * @param {string} pat
 * @returns {RegExp}
 */
function fnmatchRegex(pat) {
  const cs = Array.from(pat);
  const n = cs.length;
  const esc = (c) => c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  let res = '';
  let i = 0;
  while (i < n) {
    const c = cs[i++];
    if (c === '*') {
      if (!res.endsWith('.*')) res += '.*';
    } else if (c === '?') {
      res += '.';
    } else if (c === '[') {
      let j = i;
      if (j < n && cs[j] === '!') j++;
      if (j < n && cs[j] === ']') j++;
      while (j < n && cs[j] !== ']') j++;
      if (j >= n) {
        res += '\\[';
        continue;
      }
      let chunks;
      if (!cs.slice(i, j).includes('-')) {
        chunks = [cs.slice(i, j)];
      } else {
        chunks = [];
        let k = cs[i] === '!' ? i + 2 : i + 1;
        for (;;) {
          k = cs.slice(0, j).indexOf('-', k);
          if (k < 0) break;
          chunks.push(cs.slice(i, k));
          i = k + 1;
          k += 3;
        }
        const chunk = cs.slice(i, j);
        if (chunk.length) chunks.push(chunk);
        else chunks[chunks.length - 1].push('-');
        for (let k2 = chunks.length - 1; k2 > 0; k2--) {
          const prev = chunks[k2 - 1];
          // an earlier merge can leave an empty chunk, which Python indexes all the same
          if (!prev.length || !chunks[k2].length) throw pyError('IndexError', 'string index out of range');
          if (prev[prev.length - 1].codePointAt(0) > chunks[k2][0].codePointAt(0)) {
            chunks[k2 - 1] = prev.slice(0, -1).concat(chunks[k2].slice(1));
            chunks.splice(k2, 1);
          }
        }
      }
      // each chunk's characters are literal; the hyphens joining chunks make ranges
      const stuff = chunks.map((ch) => ch.join(''));
      i = j + 1;
      const all = stuff.join('-');
      if (!all) res += '(?!)';
      else if (all === '!') res += '.';
      else {
        const neg = all[0] === '!';
        const body = stuff.map((t, k) => (k === 0 && neg ? t.slice(1) : t).replace(/[\\\]\[^-]/g, '\\$&')).join('-');
        res += `[${neg ? '^' : ''}${body}]`;
      }
    } else {
      res += esc(c);
    }
  }
  return new RegExp(`^(?:${res})$`, 'su');
}

/** os.lstat succeeds. */
function lexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** os.path.isdir (following symbolic links). */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * glob._listdir: the names in a directory ('' is the current one), only subdirectories when dironly; none for a
 * directory that cannot be listed.
 */
function listDir(dir, dironly) {
  let entries;
  try {
    entries = fs.readdirSync(dir || '.', { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => !dironly || e.isDirectory() || (e.isSymbolicLink() && isDir(joinPath(dir || '.', e.name))))
    .map((e) => e.name);
}

/**
 * glob._iglob (not recursive): the paths matching a shell pattern, the directory part globbed as well.
 * @param {string} pathname
 * @param {boolean} dironly
 * @returns {string[]}
 */
function glob(pathname, dironly = false) {
  const [dirname, basename] = splitPath(pathname);
  if (!GLOB_MAGIC.test(pathname)) {
    if (basename) return lexists(pathname) ? [pathname] : [];
    return isDir(dirname) ? [pathname] : [];
  }
  const inDir = (dir) => {
    if (GLOB_MAGIC.test(basename)) {
      let names = listDir(dir, dironly);
      if (basename[0] !== '.') names = names.filter((x) => x[0] !== '.');
      const re = fnmatchRegex(basename);
      return names.filter((x) => re.test(x));
    }
    if (basename) return lexists(joinPath(dir, basename)) ? [basename] : [];
    return isDir(dir) ? [basename] : [];
  };
  if (!dirname) return inDir('');
  const dirs = dirname !== pathname && GLOB_MAGIC.test(dirname) ? glob(dirname, true) : [dirname];
  const out = [];
  for (const d of dirs) for (const name of inDir(d)) out.push(joinPath(d, name));
  return out;
}

/**
 * ifiles.ifind: the first path glob() finds for the name with each cased letter made a [Xx] set (ifiles.ipat), so
 * it is found whatever its case; glob characters in the name keep their meaning.
 * @param {string} pat the path
 * @param {string|null} [ext] an extension that replaces the path's own, e.g. '.fpt'
 * @returns {string|null}
 */
function ifind(pat, ext = null) {
  if (ext) pat = splitext(pat)[0] + ext;
  const [dirname, base] = splitPath(pat);
  let newpat = '';
  for (const c of base) {
    const u = c.toUpperCase();
    const l = c.toLowerCase();
    newpat += u !== l ? `[${u}${l}]` : c;
  }
  const files = glob(joinPath(dirname, newpat));
  return files.length ? files[0] : null;
}

/** memo.py: Visual FoxPro (.fpt), dBase III and dBase IV (.dbt) memo files. */
class MemoFile {
  /**
   * @param {string} filename the memo file (.fpt for Visual FoxPro, else .dbt)
   * @param {number} dbversion the table's version byte; 0x83 means dBase III memos
   * @throws {Error} pyName struct.error for a Visual FoxPro header cut short, and the OSError open() raises for a
   *   memo file that cannot be read
   */
  constructor(filename, dbversion) {
    try {
      this.buf = fs.readFileSync(filename);
    } catch (e) {
      throw osError(e, filename);
    }
    if (filename.toLowerCase().endsWith('.fpt')) this.kind = 'vfp';
    else this.kind = dbversion === 0x83 ? 'db3' : 'db4';
    if (this.kind === 'vfp') {
      if (this.buf.length < 512) throw structError(512);
      this.blocksize = this.buf.readUInt16BE(6);
    }
  }

  /**
   * The memo at a block index; Visual FoxPro picture and object memos are binary.
   * @param {number} index
   * @returns {{data: Buffer, binary: boolean}|null} null for index 0
   * @throws {Error} pyName struct.error for a block header cut short, OSError for a memo cut short
   */
  get(index) {
    if (index <= 0) return null;
    if (this.kind === 'vfp') {
      const p = index * this.blocksize;
      if (p + 8 > this.buf.length) throw structError(8);
      const type = this.buf.readUInt32BE(p);
      const length = this.buf.readUInt32BE(p + 4);
      const data = this.buf.subarray(p + 8, p + 8 + length);
      if (data.length !== length) throw pyError('OSError', 'EOF reached while reading memo');
      return { data, binary: type !== 1 };
    }
    const p = index * 512;
    if (this.kind === 'db3') {
      const rest = this.buf.subarray(p);
      const end = rest.indexOf(0x1a);
      return { data: end < 0 ? rest : rest.subarray(0, end), binary: false };
    }
    if (p + 8 > this.buf.length) throw structError(8);
    const data = this.buf.subarray(p + 8, p + 8 + this.buf.readUInt32LE(p + 4));
    const cut = data.indexOf(0x1f);
    return { data: cut < 0 ? data : data.subarray(0, cut), binary: false };
  }
}

/** Decimal(value) / 10000 for currency fields: exact, with the exponent as close to 0 as possible. */
function currency(value) {
  const neg = value < 0n;
  let coef = neg ? -value : value;
  let exp = -4;
  while (exp < 0 && coef % 10n === 0n) {
    coef /= 10n;
    exp += 1;
  }
  const digits = coef.toString();
  let s;
  if (exp === 0) s = digits;
  else if (digits.length > -exp) s = `${digits.slice(0, digits.length + exp)}.${digits.slice(digits.length + exp)}`;
  else s = `0.${digits.padStart(-exp, '0')}`;
  return Decimal.parse((neg ? '-' : '') + s);
}

/** dbfread.field_parser.FieldParser: decodes each field type of a record into its Python value. */
class FieldParser {
  /**
   * @param {object} table the table header and encoding
   * @param {MemoFile|null} memofile the memo file, for memo fields
   */
  constructor(table, memofile) {
    this.table = table;
    this.memofile = memofile;
  }

  /**
   * @param {Buffer} b
   * @returns {string} the bytes decoded with the table's encoding
   * @throws {Error} pyName UnicodeDecodeError for bytes the encoding rejects
   */
  decodeText(b) {
    return codecs.decode(b, this.table.encoding);
  }

  /**
   * _parse_memo_index, then the memo file's entry (always null without a memo file).
   * @param {Buffer} data the field's bytes
   * @returns {{data: Buffer, binary: boolean}|null}
   * @throws {Error} pyName ValueError for an index that is not an integer, and MemoFile.get()'s errors
   */
  memo(data) {
    let index;
    if (data.length === 4) index = data.readUInt32LE(0);
    else {
      try {
        index = Number(bytesInt(data));
      } catch (e) {
        if (e.pyName !== 'ValueError') throw e;
        if (strip(data, [0x20, 0x00]).length) throw pyError('ValueError', `Memo index is not an integer: ${pyBytesRepr(data)}`);
        index = 0;
      }
    }
    return this.memofile ? this.memofile.get(index) : null;
  }

  /**
   * FieldParser.parse: the value of one field, by its type letter.
   * @param {{type: string}} field
   * @param {Buffer} data the field's bytes
   * @returns {*} the Python value (str, int, float, Decimal, bool, date, datetime, bytes or None)
   * @throws {Error} pyName ValueError for an unknown type or a malformed value, struct.error for a binary value of
   *   the wrong size, and the decoding errors of the encoding
   */
  parse(field, data) {
    switch (field.type) {
      case '0': return new PyBytes(data);
      case 'C': case 'V': {
        let e = data.length;
        while (e > 0 && (data[e - 1] === 0 || data[e - 1] === 0x20)) e--;
        return this.decodeText(data.subarray(0, e));
      }
      case 'D': return this.parseD(data);
      case 'F': {
        const d = strip(strip(data, BYTES_WS), [0x2a]);
        return d.length ? new PyFloat(bytesFloat(d)) : null;
      }
      case 'I': case '+':
        if (data.length !== 4) throw structError(4);
        return { pyInt: BigInt(data.readInt32LE(0)) };
      case 'L': {
        const c = data.toString('latin1');
        if ('TtYy'.includes(c)) return true;
        if ('FfNn'.includes(c)) return false;
        if ('? '.includes(c)) return null;
        throw pyError('ValueError', `Illegal value for logical field: ${pyBytesRepr(data)}`);
      }
      case 'M': {
        const m = this.memo(data);
        if (m === null) return null;
        return m.binary ? new PyBytes(m.data) : this.decodeText(m.data);
      }
      case 'G': case 'P': return this.binaryMemo(data);
      case 'N': return this.parseN(data);
      case 'O':
        if (data.length !== 8) throw structError(8);
        return new PyFloat(data.readDoubleLE(0));
      case 'T': case '@': return this.parseT(data);
      case 'Y':
        if (data.length !== 8) throw structError(8);
        return currency(data.readBigInt64LE(0));
      case 'B':
        if ([0x30, 0x31, 0x32].includes(this.table.header.dbversion)) {
          if (data.length !== 8) throw structError(8);
          return new PyFloat(data.readDoubleLE(0));
        }
        return this.binaryMemo(data);
      default:
        throw pyError('ValueError', `Unknown field type: ${pyRepr(field.type)}`);
    }
  }

  /**
   * A memo returned as bytes.
   * @param {Buffer} data the field's bytes
   * @returns {PyBytes|null}
   * @throws {Error} as memo()
   */
  binaryMemo(data) {
    const m = this.memo(data);
    return m === null ? null : new PyBytes(m.data);
  }

  /**
   * A "D" (YYYYMMDD) field.
   * @param {Buffer} data
   * @returns {PyDate|null} null for a blank or zero date
   * @throws {Error} pyName ValueError for an invalid date
   */
  parseD(data) {
    try {
      const y = Number(bytesInt(data.subarray(0, 4)));
      const m = Number(bytesInt(data.subarray(4, 6)));
      const d = Number(bytesInt(data.subarray(6, 8)));
      return new PyDate(y, m, d);
    } catch (e) {
      if (e.pyName !== 'ValueError') throw e;
      if (strip(data, [0x20, 0x30]).length === 0) return null;
      throw pyError('ValueError', `invalid date ${pyBytesRepr(data)}`);
    }
  }

  /**
   * An "N" field: an int when it reads as one, else a float (with "," taken as the decimal point).
   * @param {Buffer} data
   * @returns {*} {pyInt}, PyFloat or null for a blank field
   * @throws {Error} pyName ValueError for text that is not a number
   */
  parseN(data) {
    const d = strip(strip(data, BYTES_WS), [0x2a]);
    try {
      return { pyInt: bytesInt(d) };
    } catch (e) {
      if (e.pyName !== 'ValueError') throw e;
      if (!strip(d, BYTES_WS).length) return null;
      return new PyFloat(bytesFloat(Buffer.from(d.toString('latin1').replace(/,/g, '.'), 'latin1')));
    }
  }

  /**
   * A "T" or "@" field: a Julian day and milliseconds.
   * @param {Buffer} data
   * @returns {PyDateTime|null} null for a blank field or day 0
   * @throws {Error} pyName struct.error for a field that is not 8 bytes, ValueError or OverflowError for a date out
   *   of range
   */
  parseT(data) {
    if (!strip(data, BYTES_WS).length) return null;
    if (data.length !== 8) throw structError(8);
    const day = data.readUInt32LE(0);
    const msec = data.readUInt32LE(4);
    if (!day) return null;
    const ord = day - JULIAN_OFFSET;
    if (ord < 1) throw pyError('ValueError', 'ordinal must be >= 1');
    if (ord > 3652059) throw pyError('ValueError', `year ${ordToYmd(ord)[0]} is out of range`);
    return addToEpoch(ordToYmd(ord), timedeltaMicros([[msec / 1000, 1e6]]));
  }
}

/**
 * dbfread.DBF(filename, load=True) with agate-dbf's tuple records.
 * @param {string} filename path of the .dbf file
 * @param {string|null} encoding codec name, or null to guess it from the header
 * @returns {{fields: string[], rows: Array[]}}
 * @throws {Error} pyName dbfread.exceptions.DBFNotFound for a missing file, MissingMemoFile for a missing memo,
 *   ValueError for an unknown or malformed field type or value, struct.error for a truncated header, the OSError
 *   open() raises for a table or memo file that cannot be read, and the codec errors of the table's encoding
 */
function readDbf(filename, encoding = null) {
  const found = ifind(filename);
  if (!found) throw pyError('dbfread.exceptions.DBFNotFound', `could not find file ${pyRepr(filename)}`);
  let buf;
  try {
    buf = fs.readFileSync(found);
  } catch (e) {
    throw osError(e, found);
  }
  if (buf.length < 32) throw structError(32);
  const header = { dbversion: buf[0], headerlen: buf.readUInt16LE(8), recordlen: buf.readUInt16LE(10) };
  const languageDriver = buf[29];
  const table = { header, encoding };
  if (table.encoding === null) table.encoding = languageDriver in CODEPAGES ? CODEPAGES[languageDriver] : 'ascii';
  const fields = [];
  let pos = 32;
  while (pos < buf.length && buf[pos] !== 0x0d && buf[pos] !== 0x0a) {
    if (pos + 32 > buf.length) throw structError(32);
    const raw = buf.subarray(pos, pos + 32);
    pos += 32;
    const field = { type: String.fromCharCode(raw[11]), length: raw[16], decimalCount: raw[17] };
    if (field.type === 'C') {
      field.length |= field.decimalCount << 8;
      field.decimalCount = 0;
    }
    const nameBytes = raw.subarray(0, 11);
    const z = nameBytes.indexOf(0);
    field.name = codecs.decode(z >= 0 ? nameBytes.subarray(0, z) : nameBytes, table.encoding);
    fields.push(field);
  }
  for (const field of fields) {
    if (field.type === 'I' && field.length !== 4) {
      throw pyError('ValueError', `Field type I must have length 4 (was ${field.length})`);
    }
    if (field.type === 'L' && field.length !== 1) {
      throw pyError('ValueError', `Field type L must have length 1 (was ${field.length})`);
    }
    if (!SUPPORTED_TYPES.has(field.type)) throw pyError('ValueError', `Unknown field type: ${pyRepr(field.type)}`);
  }
  let memoName = null;
  if (fields.some((f) => 'MGPB'.includes(f.type))) {
    memoName = ifind(found, '.fpt') || ifind(found, '.dbt');
    if (!memoName) throw pyError('dbfread.exceptions.MissingMemoFile', `missing memo file for ${found}`);
  }
  const iterRecords = (recordType) => {
    const parser = new FieldParser(table, memoName ? new MemoFile(memoName, header.dbversion) : null);
    const out = [];
    let p = header.headerlen;
    for (;;) {
      const sep = p < buf.length ? buf[p] : null;
      p += 1;
      if (sep === recordType) {
        const row = [];
        for (const field of fields) {
          row.push(parser.parse(field, buf.subarray(Math.min(p, buf.length), Math.min(p + field.length, buf.length))));
          p += field.length;
        }
        out.push(row);
      } else if (sep === 0x1a || sep === null) {
        break;
      } else {
        p += header.recordlen - 1;
      }
    }
    return out;
  };
  const rows = iterRecords(0x20);
  iterRecords(0x2a);
  return { fields: fields.map((f) => f.name), rows };
}

module.exports = { readDbf };
