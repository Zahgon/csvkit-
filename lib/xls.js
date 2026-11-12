'use strict';
// Port of xlrd 2.0.2 (BSD) as agate-excel 0.4.3 table_xls.from_xls uses it: format detection, the BIFF workbook
// globals (BOF, SST/CONTINUE, FORMAT, XF, BOUNDSHEET, DATEMODE, CODEPAGE), worksheet cell records
// (NUMBER, RK, MULRK, LABELSST, LABEL, RSTRING, FORMULA/STRING, BOOLERR) and the cell type derived from the
// cell's XF and number format; then agate-excel's column normalisation (MIT).

const { pyError } = require('./pyerrors');
const { CompDoc, SIGNATURE } = require('./compdoc');
const { OleFileIO } = require('./olefile');
const { pyBytesRepr, pyRepr } = require('./pystr');
const { ZipFile } = require('./zipfile');
const codecs = require('./codecs');
const { PyFloat } = require('./pyjson');
const { PyDate, PyDateTime } = require('./types');
const { xldateAsDatetime } = require('./xldate');

const XL_CELL_EMPTY = 0;
const XL_CELL_TEXT = 1;
const XL_CELL_NUMBER = 2;
const XL_CELL_DATE = 3;
const XL_CELL_BOOLEAN = 4;
const XL_CELL_ERROR = 5;

const XL_WORKBOOK_GLOBALS = 0x5;
const XL_WORKBOOK_GLOBALS_4W = 0x100;
const XL_WORKSHEET = 0x10;
const BOFLEN = { 0x0809: 8, 0x0409: 6, 0x0209: 6, 0x0009: 4 };
const SUPPORTED_VERSIONS = [80, 70, 50, 45, 40, 30, 21, 20];
const BIFF_TEXT = { 0: '(not BIFF)', 20: '2.0', 21: '2.1', 30: '3', 40: '4S', 45: '4W', 50: '5', 70: '7', 80: '8', 85: '8X' };

const XL_SST = 0xfc;
const XL_CONTINUE = 0x3c;
const XL_FORMAT = 0x41e;
const XL_XF = 0xe0;
const XL_BOUNDSHEET = 0x85;
const XL_DATEMODE = 0x22;
const XL_CODEPAGE = 0x42;
const XL_COUNTRY = 0x8c;
const XL_FILEPASS = 0x2f;
const XL_WRITEACCESS = 0x5c;
const XL_EOF = 0x0a;
const XL_NUMBER = 0x203;
const XL_LABELSST = 0xfd;
const XL_LABEL = 0x204;
const XL_RSTRING = 0xd6;
const XL_RK = 0x27e;
const XL_MULRK = 0xbd;
const XL_FORMULA_OPCODES = [0x0006, 0x0406, 0x0206];
const XL_STRING = 0x207;
const XL_STRING_B2 = 0x07;
const XL_ARRAY = 0x221;
const XL_SHRFMLA = 0x4bc;
const XL_SHRFMLA_ETC_ETC = [XL_SHRFMLA, XL_ARRAY, 0x236, 0x37, 0x21, 0x36];
const XL_BOOLERR = 0x205;

// formatting.py: the standard format codes, those of them that are dates, and the date test for format strings.
const STD_DATE_RANGES = [[14, 22], [27, 36], [45, 47], [50, 58], [71, 81]];
const STD_CODES = [[0, 0], [1, 13], [14, 22], [27, 36], [37, 44], [45, 47], [48, 48], [49, 49], [50, 58], [59, 62],
  [67, 70], [71, 81]];
const NON_DATE_FORMATS = new Set(['0.00E+00', '##0.0E+0', 'General', 'GENERAL', 'general', '@']);

function xlrdError(message) {
  return pyError('xlrd.biffh.XLRDError', message);
}

/** formatting.is_date_format_string */
function isDateFormatString(fmt) {
  let state = 0;
  let s = '';
  for (const c of fmt) {
    if (state === 0) {
      if (c === '"') state = 1;
      else if ('\\_*'.includes(c)) state = 2;
      else if (!'$-+/(): '.includes(c)) s += c;
    } else if (state === 1) {
      if (c === '"') state = 0;
    } else {
      state = 0;
    }
  }
  s = s.replace(/\[[^\]]*\]/g, '');
  if (NON_DATE_FORMATS.has(s)) return false;
  let dateCount = 0;
  let numCount = 0;
  for (const c of s) {
    if ('ymdhsYMDHS'.includes(c)) dateCount += 5;
    else if ('0#?'.includes(c)) numCount += 5;
  }
  if (dateCount && !numCount) return true;
  if (numCount && !dateCount) return false;
  return dateCount > numCount;
}

/** biffh.unpack_unicode_update_pos: a BIFF8 string with its options byte. */
function unpackUnicodeUpdatePos(data, pos, lenlen) {
  const nchars = lenlen === 1 ? data[pos] : data.readUInt16LE(pos);
  pos += lenlen;
  if (!nchars && pos >= data.length) return ['', pos];
  const options = data[pos];
  pos += 1;
  const phonetic = options & 0x04;
  const richtext = options & 0x08;
  let rt = 0;
  let sz = 0;
  if (richtext) {
    rt = data.readUInt16LE(pos);
    pos += 2;
  }
  if (phonetic) {
    sz = data.readInt32LE(pos);
    pos += 4;
  }
  let strg;
  if (options & 0x01) {
    strg = codecs.decode(data.subarray(pos, pos + 2 * nchars), 'utf_16_le');
    pos += 2 * nchars;
  } else {
    strg = data.subarray(pos, pos + nchars).toString('latin1');
    pos += nchars;
  }
  if (richtext) pos += 4 * rt;
  if (phonetic) pos += sz;
  return [strg, pos];
}

/** book.unpack_SST_table: the shared strings spread over SST and CONTINUE records. */
function unpackSSTTable(datatab, nstrings) {
  let datainx = 0;
  let data = datatab[0];
  let datalen = data.length;
  let pos = 8;
  const strings = [];
  for (let i = 0; i < nstrings; i++) {
    const nchars = data.readUInt16LE(pos);
    pos += 2;
    let options = data[pos];
    pos += 1;
    let rtcount = 0;
    let phosz = 0;
    if (options & 0x08) {
      rtcount = data.readUInt16LE(pos);
      pos += 2;
    }
    if (options & 0x04) {
      phosz = data.readInt32LE(pos);
      pos += 4;
    }
    let acc = '';
    let charsgot = 0;
    for (;;) {
      const charsneed = nchars - charsgot;
      let avail;
      if (options & 0x01) {
        avail = Math.min((datalen - pos) >> 1, charsneed);
        acc += codecs.decode(data.subarray(pos, pos + 2 * avail), 'utf_16_le');
        pos += 2 * avail;
      } else {
        avail = Math.min(datalen - pos, charsneed);
        acc += data.subarray(pos, pos + avail).toString('latin1');
        pos += avail;
      }
      charsgot += avail;
      if (charsgot === nchars) break;
      datainx += 1;
      data = datatab[datainx];
      datalen = data.length;
      options = data[0];
      pos = 1;
    }
    for (let r = 0; r < rtcount; r++) {
      if (pos === datalen) {
        pos = 0;
        datainx += 1;
        data = datatab[datainx];
        datalen = data.length;
      }
      pos += 4;
    }
    pos += phosz;
    if (pos >= datalen) {
      pos -= datalen;
      datainx += 1;
      if (datainx < datatab.length) {
        data = datatab[datainx];
        datalen = data.length;
      }
    }
    strings.push(acc);
  }
  return strings;
}

/** sheet.unpack_RK: a float from an RK value (xlrd returns floats only). */
function unpackRK(b) {
  const flags = b[0];
  let d;
  if (flags & 2) {
    d = b.readInt32LE(0) >> 2;
  } else {
    const t = Buffer.alloc(8);
    t[4] = flags & 252;
    b.copy(t, 5, 1, 4);
    d = t.readDoubleLE(0);
  }
  return flags & 1 ? d / 100.0 : d;
}

/** xlrd.sheet.Sheet: one worksheet's cells, read from its BIFF records on first use. */
class Sheet {
  /**
   * @param {Book} book
   * @param {number} position the offset of the sheet's BOF record in the workbook stream
   * @param {string} name
   * @param {number} number the sheet index
   */
  constructor(book, position, name, number) {
    this.book = book;
    this.position = position;
    this.name = name;
    this.number = number;
    this.nrows = 0;
    this.ncols = 0;
    this.cells = new Map();
  }

  /**
   * Sheet.put_cell, growing nrows and ncols; a null type is taken from the cell's XF record.
   * @param {number} rowx
   * @param {number} colx
   * @param {number|null} ctype an XL_CELL_* type
   * @param {*} value
   * @param {number} xfIndex
   * @returns {void}
   * @throws {Error} pyName KeyError for an XF index the workbook does not define
   */
  putCell(rowx, colx, ctype, value, xfIndex) {
    if (ctype === null) {
      if (!this.book.xfTypes.has(xfIndex)) throw pyError('KeyError', String(xfIndex));
      ctype = this.book.xfTypes.get(xfIndex);
    }
    if (rowx + 1 > this.nrows) this.nrows = rowx + 1;
    if (colx + 1 > this.ncols) this.ncols = colx + 1;
    this.cells.set(`${rowx},${colx}`, [ctype, value]);
  }

  /**
   * Cell [type, value]; cells never written are empty text cells.
   * @param {number} rowx
   * @param {number} colx
   * @returns {Array} [XL_CELL_* type, value]
   */
  cell(rowx, colx) {
    return this.cells.get(`${rowx},${colx}`) || [XL_CELL_EMPTY, ''];
  }

  /**
   * Sheet.cell_value.
   * @param {number} rowx a row index (negative counts from the end)
   * @param {number} colx
   * @returns {*}
   * @throws {Error} pyName IndexError for a cell outside the sheet
   */
  cellValue(rowx, colx) {
    if (rowx >= this.nrows || rowx < -this.nrows || colx >= this.ncols) throw pyError('IndexError', 'list index out of range');
    return this.cell(rowx < 0 ? rowx + this.nrows : rowx, colx)[1];
  }

  /**
   * Sheet.col_values / col_types from start_rowx to the end.
   * @param {number} colx
   * @param {number} start the first row (negative counts from the end)
   * @returns {Array<Array>} [type, value] per row
   */
  column(colx, start) {
    const nr = this.nrows;
    if (start < 0) start = Math.max(0, start + nr);
    const out = [];
    for (let r = start; r < nr; r++) out.push(this.cell(r, colx));
    return out;
  }

  /**
   * Sheet.string_record_contents: the text of a STRING record and the CONTINUE records after it.
   * @param {Buffer} data the STRING record
   * @returns {string|null}
   * @throws {Error} pyName xlrd.biffh.XLRDError for more characters than declared or a missing CONTINUE record
   */
  stringRecordContents(data) {
    const bk = this.book;
    const bv = bk.biffVersion;
    const lenlen = (bv >= 30 ? 1 : 0) + 1;
    const expected = lenlen === 1 ? data[0] : data.readUInt16LE(0);
    let offset = lenlen;
    let enc = bv < 80 ? bk.encoding || bk.deriveEncoding() : null;
    let found = 0;
    let result = '';
    for (;;) {
      if (bv >= 80) {
        enc = data[offset] & 1 ? 'utf_16_le' : 'latin_1';
        offset += 1;
      }
      const chunk = codecs.decode(data.subarray(offset), enc);
      result += chunk;
      found += chunk.length;
      if (found === expected) return result;
      if (found > expected) throw xlrdError(`STRING/CONTINUE: expected ${expected} chars, found ${found}`);
      const [rc, , next] = bk.getRecordParts();
      if (rc !== XL_CONTINUE) {
        throw xlrdError(`Expected CONTINUE record; found record-type 0x${rc.toString(16).toUpperCase().padStart(4, '0')}`);
      }
      data = next;
      offset = 0;
    }
  }

  /**
   * Sheet.read: the cell records up to the sheet's EOF.
   * @returns {void}
   * @throws {Error} pyName IndexError for a shared-string index out of range, KeyError for an undefined XF,
   *   xlrd.biffh.XLRDError for malformed formula or string records, struct.error for a truncated record
   */
  read() {
    const bk = this.book;
    const oldpos = bk.position;
    bk.position = this.position;
    const bv = bk.biffVersion;
    for (;;) {
      const [rc, , data] = bk.getRecordParts();
      if (rc === XL_NUMBER) {
        this.putCell(data.readUInt16LE(0), data.readUInt16LE(2), null, data.readDoubleLE(6), data.readUInt16LE(4));
      } else if (rc === XL_LABELSST) {
        const i = data.readInt32LE(6);
        const ss = bk.sharedStrings;
        if (i >= ss.length || i < -ss.length) throw pyError('IndexError', 'list index out of range');
        const text = ss[i < 0 ? i + ss.length : i];
        this.putCell(data.readUInt16LE(0), data.readUInt16LE(2), XL_CELL_TEXT, text, data.readUInt16LE(4));
      } else if (rc === XL_LABEL || rc === XL_RSTRING) {
        let strg;
        if (bv < 80) {
          const n = data.readUInt16LE(6);
          strg = codecs.decode(data.subarray(8, 8 + n), bk.encoding || bk.deriveEncoding());
        } else {
          [strg] = unpackUnicodeUpdatePos(data, 6, 2);
        }
        this.putCell(data.readUInt16LE(0), data.readUInt16LE(2), XL_CELL_TEXT, strg, data.readUInt16LE(4));
      } else if (rc === XL_RK) {
        this.putCell(data.readUInt16LE(0), data.readUInt16LE(2), null, unpackRK(data.subarray(6, 10)), data.readUInt16LE(4));
      } else if (rc === XL_MULRK) {
        const row = data.readUInt16LE(0);
        const first = data.readUInt16LE(2);
        const last = data.readUInt16LE(data.length - 2);
        let pos = 4;
        for (let colx = first; colx <= last; colx++) {
          this.putCell(row, colx, null, unpackRK(data.subarray(pos + 2, pos + 6)), data.readUInt16LE(pos));
          pos += 6;
        }
      } else if (XL_FORMULA_OPCODES.includes(rc)) {
        this.readFormula(data);
      } else if (rc === XL_BOOLERR) {
        const ctype = data[7] ? XL_CELL_ERROR : XL_CELL_BOOLEAN;
        this.putCell(data.readUInt16LE(0), data.readUInt16LE(2), ctype, data[6], data.readUInt16LE(4));
      } else if (rc === XL_EOF) {
        break;
      } else if (rc in BOFLEN) {
        const boftype = data.readUInt16LE(2);
        if (boftype !== 0x20) {
          bk.log(`*** Unexpected embedded BOF (0x${hex4(rc)}) at offset ${bk.position - data.length - 4}: `
            + `version=0x${hex4(data.readUInt16LE(0))} type=0x${hex4(boftype)}\n`);
        }
        for (;;) {
          const [code] = bk.getRecordParts();
          if (code === XL_EOF) break;
        }
      } else if (rc === XL_COUNTRY) {
        bk.handleCountry(data);
      }
    }
    bk.position = oldpos;
  }

  /**
   * Stores the FORMULA record's cached result as the cell: a number, a string from the STRING record that follows,
   * a boolean, an error code or an empty string.
   * @param {Buffer} data the FORMULA record
   * @returns {void}
   * @throws {Error} pyName xlrd.biffh.XLRDError for an unexpected record after the formula or an unknown result type
   */
  readFormula(data) {
    const bk = this.book;
    const rowx = data.readUInt16LE(0);
    const colx = data.readUInt16LE(2);
    const xfIndex = data.readUInt16LE(4);
    const result = data.subarray(6, 14);
    if (result[6] === 0xff && result[7] === 0xff) {
      const first = result[0];
      if (first === 0) {
        let gotstring = false;
        let [rc2, , data2] = bk.getRecordParts();
        if (rc2 === XL_STRING || rc2 === XL_STRING_B2) gotstring = true;
        else if (!XL_SHRFMLA_ETC_ETC.includes(rc2)) {
          throw xlrdError(`Expected SHRFMLA, ARRAY, TABLEOP* or STRING record; found 0x${hex4(rc2)}`);
        }
        if (!gotstring) {
          [rc2, , data2] = bk.getRecordParts();
          if (rc2 !== XL_STRING && rc2 !== XL_STRING_B2) throw xlrdError(`Expected STRING record; found 0x${hex4(rc2)}`);
        }
        this.putCell(rowx, colx, XL_CELL_TEXT, this.stringRecordContents(data2), xfIndex);
      } else if (first === 1) {
        this.putCell(rowx, colx, XL_CELL_BOOLEAN, result[2], xfIndex);
      } else if (first === 2) {
        this.putCell(rowx, colx, XL_CELL_ERROR, result[2], xfIndex);
      } else if (first === 3) {
        this.putCell(rowx, colx, XL_CELL_TEXT, '', xfIndex);
      } else {
        throw xlrdError(`unexpected special case (0x${first.toString(16).padStart(2, '0')}) in FORMULA`);
      }
    } else {
      this.putCell(rowx, colx, null, result.readDoubleLE(0), xfIndex);
    }
  }
}

function hex4(n) {
  return n.toString(16).padStart(4, '0');
}

class Book {
  /**
   * xlrd.open_workbook(file_contents=..., on_demand=True) on an XLS file: finds the workbook stream, checks the BIFF
   * version and parses the globals.
   * @param {Buffer} contents file bytes
   * @param {string|null} encodingOverride --encoding-xls
   * @param {function(string): void} log xlrd's logfile
   * @throws {Error} pyName xlrd.biffh.XLRDError for a missing workbook stream, an unknown or unsupported BIFF
   *   version, a bad BOF or an encrypted workbook; xlrd.compdoc.CompDocError from the compound document; the
   *   errors parseGlobals() raises
   */
  constructor(contents, encodingOverride, log) {
    this.log = log;
    this.encodingOverride = encodingOverride;
    this.encoding = null;
    this.codepage = null;
    this.datemode = 0;
    this.countries = [0, 0];
    this.sheetNames = [];
    this.shAbsPosn = [];
    this.sheetList = [];
    this.sharedStrings = [];
    // format key -> whether it is a date format; XF index -> its format key; XF index -> cell type of numbers.
    this.formatMap = new Map();
    this.xfList = [];
    this.xfTypes = new Map([[0, XL_CELL_NUMBER]]);
    this.biffVersion = 0;
    // A BIFF5/7 WRITEACCESS seen before the code page is known, decoded (for its errors) once it is.
    this.rawUserName = null;
    this.base = 0;
    if (!contents.subarray(0, 8).equals(SIGNATURE)) {
      this.mem = contents;
    } else {
      const cd = new CompDoc(contents, log);
      let found = false;
      for (const qname of ['Workbook', 'Book']) {
        [this.mem, this.base] = cd.locateNamedStream(qname);
        if (this.mem) {
          found = true;
          break;
        }
      }
      if (!found) throw xlrdError("Can't find workbook in OLE2 compound document");
    }
    this.position = this.base;
    const bv = this.getbof(XL_WORKBOOK_GLOBALS);
    if (!bv) throw xlrdError("Can't determine file's BIFF version");
    if (!SUPPORTED_VERSIONS.includes(bv)) throw xlrdError(`BIFF version ${BIFF_TEXT[bv]} is not supported`);
    this.biffVersion = bv;
    if (bv <= 45) throw xlrdError(`BIFF version ${BIFF_TEXT[bv]} is not supported`);
    this.parseGlobals();
    this.sheetList = this.sheetNames.map(() => null);
  }

  /** @returns {number|null} the little-endian uint16 at the current position, or null when fewer than 2 bytes are left */
  get2bytes() {
    const pos = this.position;
    const b = this.mem.subarray(pos, pos + 2);
    this.position += b.length;
    return b.length < 2 ? null : b.readUInt16LE(0);
  }

  /**
   * Book.get_record_parts: the next BIFF record.
   * @returns {Array} [opcode, length, data]
   * @throws {Error} pyName struct.error when fewer than 4 bytes are left
   */
  getRecordParts() {
    let pos = this.position;
    if (pos + 4 > this.mem.length) throw pyError('struct.error', 'unpack requires a buffer of 4 bytes');
    const code = this.mem.readUInt16LE(pos);
    const length = this.mem.readUInt16LE(pos + 2);
    pos += 4;
    const data = this.mem.subarray(pos, pos + length);
    this.position = pos + length;
    return [code, length, data];
  }

  /**
   * Book.getbof: the BIFF version of the BOF record at the current position.
   * @param {number} rqdStream the substream type required (XL_WORKBOOK_GLOBALS or XL_WORKSHEET)
   * @returns {number} the BIFF version
   * @throws {Error} pyName xlrd.biffh.XLRDError "Unsupported format, or corrupt file: ..." for a missing, short or
   *   unexpected BOF record
   */
  getbof(rqdStream) {
    const bofError = (msg) => xlrdError(`Unsupported format, or corrupt file: ${msg}`);
    const savpos = this.position;
    const opcode = this.get2bytes();
    if (opcode === null) throw bofError('Expected BOF record; met end of file');
    if (!(opcode in BOFLEN)) throw bofError(`Expected BOF record; found ${pyBytesRepr(this.mem.subarray(savpos, savpos + 8))}`);
    const length = this.get2bytes();
    if (length === null) throw bofError('Incomplete BOF record[1]; met end of file');
    if (!(length >= 4 && length <= 20)) throw bofError(`Invalid length (${length}) for BOF record type 0x${hex4(opcode)}`);
    let data = this.mem.subarray(this.position, this.position + length);
    this.position += data.length;
    if (data.length < length) throw bofError('Incomplete BOF record[2]; met end of file');
    data = Buffer.concat([data, Buffer.alloc(Math.max(0, BOFLEN[opcode] - length))]);
    const version1 = opcode >> 8;
    const version2 = data.readUInt16LE(0);
    const streamtype = data.readUInt16LE(2);
    let version = 0;
    if (version1 === 0x08) {
      const build = data.readUInt16LE(4);
      const year = data.readUInt16LE(6);
      if (version2 === 0x0600) version = 80;
      else if (version2 === 0x0500) version = year < 1994 || [2412, 3218, 3321].includes(build) ? 50 : 70;
      else version = { 0x0000: 21, 0x0007: 21, 0x0200: 21, 0x0300: 30, 0x0400: 40 }[version2] || 0;
    } else if ([0x04, 0x02, 0x00].includes(version1)) {
      version = { 0x04: 40, 0x02: 30, 0x00: 21 }[version1];
    }
    if (version === 40 && streamtype === XL_WORKBOOK_GLOBALS_4W) version = 45;
    const gotGlobals = streamtype === XL_WORKBOOK_GLOBALS || (version === 45 && streamtype === XL_WORKBOOK_GLOBALS_4W);
    if ((rqdStream === XL_WORKBOOK_GLOBALS && gotGlobals) || streamtype === rqdStream) return version;
    if (version < 50 && streamtype === XL_WORKSHEET) return version;
    return null;
  }

  /**
   * Book.derive_encoding: the text encoding from --encoding-xls or the CODEPAGE record, checked by decoding a trial
   * string (and the user name record, if any).
   * @returns {string} the encoding
   * @throws {Error} pyName LookupError for an encoding Python does not know (logged first, as xlrd logs it), and the
   *   decoding error of the user name
   */
  deriveEncoding() {
    if (this.encodingOverride) {
      this.encoding = this.encodingOverride;
    } else if (this.codepage === null) {
      if (this.biffVersion < 80) {
        this.log("*** No CODEPAGE record, no encoding_override: will use 'iso-8859-1'\n");
        this.encoding = 'iso-8859-1';
      } else {
        this.codepage = 1200;
      }
    } else {
      const cp = this.codepage;
      let encoding;
      if (ENCODING_FROM_CODEPAGE[cp]) encoding = ENCODING_FROM_CODEPAGE[cp];
      else if (cp >= 300 && cp <= 1999) encoding = `cp${cp}`;
      else if (this.biffVersion >= 80) {
        this.codepage = 1200;
        encoding = 'utf_16_le';
      } else {
        encoding = `unknown_codepage_${cp}`;
      }
      this.encoding = encoding;
    }
    if (this.codepage !== 1200) {
      try {
        codecs.decode(Buffer.from('trial'), this.encoding);
      } catch (e) {
        const kind = (e.pyName || 'LookupError').split('.').pop();
        const cp = this.codepage === null ? 'None' : this.codepage;
        this.log(`ERROR *** codepage ${cp} -> encoding ${pyRepr(this.encoding)} -> ${kind}: ${e.message}\n`);
        throw e;
      }
    }
    if (this.rawUserName) {
      codecs.decode(this.rawUserName.subarray(1, 1 + this.rawUserName[0]), this.encoding);
      this.rawUserName = null;
    }
    return this.encoding;
  }

  /**
   * Book.handle_country.
   * @param {Buffer} data the COUNTRY record
   * @returns {void}
   * @throws {Error} pyName AssertionError for a second COUNTRY record that differs
   */
  handleCountry(data) {
    const c = [data.readUInt16LE(0), data.readUInt16LE(2)];
    if (!((this.countries[0] === 0 && this.countries[1] === 0) || (this.countries[0] === c[0] && this.countries[1] === c[1]))) {
      throw pyError('AssertionError', '');
    }
    this.countries = c;
  }

  /**
   * Book.handle_format: records whether a number format is a date format.
   * @param {Buffer} data the FORMAT record
   * @returns {void}
   * @throws {Error} as deriveEncoding(), and the decoding errors of the format string
   */
  handleFormat(data) {
    if (!this.encoding) this.deriveEncoding();
    const bv = this.biffVersion;
    const fmtkey = data.readUInt16LE(0);
    let strg;
    if (bv >= 80) [strg] = unpackUnicodeUpdatePos(data, 2, 2);
    else strg = codecs.decode(data.subarray(3, 3 + data[2]), this.encoding);
    this.formatMap.set(fmtkey, isDateFormatString(strg));
  }

  /**
   * formatting.handle_xf, reduced to what the cell types need: the XF's number format and whether it is a date.
   * @param {Buffer} data the XF record
   * @returns {void}
   */
  handleXf(data) {
    if (!this.xfList.length) {
      for (const [lo, hi] of STD_CODES) {
        for (let x = lo; x <= hi; x++) {
          if (!this.formatMap.has(x)) this.formatMap.set(x, STD_DATE_RANGES.some(([a, b]) => x >= a && x <= b));
        }
      }
    }
    const formatKey = data.readUInt16LE(2);
    this.xfTypes.set(this.xfList.length, this.formatMap.get(formatKey) === true ? XL_CELL_DATE : XL_CELL_NUMBER);
    this.xfList.push(this.formatMap.has(formatKey) ? formatKey : 0);
  }

  /**
   * formatting.xf_epilogue: the cell type of every XF from its number format.
   * @returns {void}
   */
  xfEpilogue() {
    this.xfList.forEach((key, xfx) => {
      const isDate = this.formatMap.get(key);
      this.xfTypes.set(xfx, isDate === undefined ? XL_CELL_TEXT : (isDate ? XL_CELL_DATE : XL_CELL_NUMBER));
    });
  }

  /**
   * Book.handle_boundsheet: records a worksheet's name and stream position (other sheet types are skipped).
   * @param {Buffer} data the BOUNDSHEET record
   * @returns {void}
   * @throws {Error} as deriveEncoding(), and the decoding errors of the sheet name
   */
  handleBoundsheet(data) {
    this.deriveEncoding();
    const offset = data.readInt32LE(0);
    const sheetType = data[5];
    const absPosn = offset + this.base;
    let name;
    if (this.biffVersion < 80) name = codecs.decode(data.subarray(7, 7 + data[6]), this.encoding);
    else [name] = unpackUnicodeUpdatePos(data, 6, 1);
    if (sheetType !== 0) return;
    this.sheetNames.push(name);
    this.shAbsPosn.push(absPosn);
  }

  /**
   * Book.parse_globals: the workbook globals substream.
   * @returns {void}
   * @throws {Error} pyName xlrd.biffh.XLRDError for an encrypted workbook, AssertionError for a bad DATEMODE or
   *   COUNTRY record, struct.error for a truncated record, and the record handlers' errors
   */
  parseGlobals() {
    for (;;) {
      const [rc, , data] = this.getRecordParts();
      if (rc === XL_SST) {
        const parts = [data];
        const unique = data.readInt32LE(4);
        for (;;) {
          if (this.position + 4 > this.mem.length || this.mem.readUInt16LE(this.position) !== XL_CONTINUE) break;
          parts.push(this.getRecordParts()[2]);
        }
        this.sharedStrings = unpackSSTTable(parts, unique);
      } else if (rc === XL_FORMAT) {
        this.handleFormat(data);
      } else if (rc === XL_XF) {
        this.handleXf(data);
      } else if (rc === XL_BOUNDSHEET) {
        this.handleBoundsheet(data);
      } else if (rc === XL_DATEMODE) {
        const dm = data.readUInt16LE(0);
        if (dm !== 0 && dm !== 1) throw pyError('AssertionError', '');
        this.datemode = dm;
      } else if (rc === XL_CODEPAGE) {
        this.codepage = data.readUInt16LE(0);
        this.deriveEncoding();
      } else if (rc === XL_COUNTRY) {
        this.handleCountry(data);
      } else if (rc === XL_FILEPASS) {
        throw xlrdError('Workbook is encrypted');
      } else if (rc === XL_WRITEACCESS && this.biffVersion < 80) {
        if (this.encoding) codecs.decode(data.subarray(1, 1 + data[0]), this.encoding);
        else this.rawUserName = data;
      } else if (rc === XL_EOF) {
        this.xfEpilogue();
        if (!this.encoding) this.deriveEncoding();
        return;
      }
    }
  }

  /**
   * Book.sheet_by_index, reading the sheet on first use.
   * @param {number} i a sheet index (negative counts from the end)
   * @returns {Sheet}
   * @throws {Error} pyName IndexError for an index out of range, and the errors xlrd raises reading the sheet
   */
  sheetByIndex(i) {
    const n = this.sheetNames.length;
    if (i >= n || i < -n) throw pyError('IndexError', 'list index out of range');
    const k = i < 0 ? i + n : i;
    if (this.sheetList[k]) return this.sheetList[k];
    this.position = this.shAbsPosn[k];
    this.getbof(XL_WORKSHEET);
    const sh = new Sheet(this, this.position, this.sheetNames[k], k);
    sh.read();
    this.sheetList[k] = sh;
    return sh;
  }

  /**
   * Book.sheet_by_name.
   * @param {string} name
   * @returns {Sheet}
   * @throws {Error} pyName xlrd.biffh.XLRDError for a name the workbook does not have
   */
  sheetByName(name) {
    const i = this.sheetNames.indexOf(name);
    if (i < 0) throw xlrdError(`No sheet named <${pyRepr(name)}>`);
    return this.sheetByIndex(i);
  }
}

const ENCODING_FROM_CODEPAGE = {
  1200: 'utf_16_le', 10000: 'mac_roman', 10006: 'mac_greek', 10007: 'mac_cyrillic', 10029: 'mac_latin2',
  10079: 'mac_iceland', 10081: 'mac_turkish', 32768: 'mac_roman', 32769: 'cp1252',
};

/**
 * xlrd.open_workbook's format check: only OLE2 or raw BIFF content is read as XLS.
 * @param {Buffer} contents file bytes
 */
function inspectFormat(contents) {
  if (contents.subarray(0, 8).equals(SIGNATURE)) return 'xls';
  if (contents.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'latin1'))) {
    const names = new Set(new ZipFile(contents).namelist().map((n) => n.replace(/\\/g, '/').toLowerCase()));
    if (names.has('xl/workbook.xml')) return 'xlsx';
    if (names.has('xl/workbook.bin')) return 'xlsb';
    if (names.has('content.xml')) return 'ods';
    return 'zip';
  }
  return null;
}

const FORMAT_DESCRIPTIONS = {
  xlsb: 'Excel 2007 xlsb file', xlsx: 'Excel xlsx file', ods: 'Openoffice.org ODS file', zip: 'Unknown ZIP file',
};

function openWorkbook(contents, encodingOverride, log) {
  // inspect_format falls back to os.path.expanduser(None) when the contents are empty.
  if (!contents.length) throw pyError('TypeError', 'expected str, bytes or os.PathLike object, not NoneType');
  const fmt = inspectFormat(contents);
  if (fmt && fmt !== 'xls') throw xlrdError(`${FORMAT_DESCRIPTIONS[fmt]}; not supported`);
  return new Book(contents, encodingOverride, log);
}

/**
 * xlrd sheet_names() after a full open_workbook (every sheet is loaded, as in2csv --names does).
 * @param {Buffer} contents file bytes
 * @param {function(string): void} log xlrd's logfile
 * @returns {string[]}
 * @throws {Error} pyName xlrd.biffh.XLRDError for a file that is not a BIFF workbook (or is xlsx, ods ...),
 *   xlrd.compdoc.CompDocError for a damaged compound document, and the errors xlrd raises reading a sheet
 */
function xlsSheetNames(contents, log) {
  const book = openWorkbook(contents, null, log);
  book.sheetNames.forEach((_, i) => book.sheetByIndex(i));
  return [...book.sheetNames];
}

/** agateexcel table_xls.normalize_dates for one value: date, or datetime when it has a time of day. */
function normalizeDate(v, datemode) {
  if (!v) return null;
  const dt = xldateAsDatetime(v, datemode);
  if (!dt.h && !dt.mi && !dt.s) return new PyDate(dt.y, dt.mo, dt.d);
  return new PyDateTime(dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s);
}

/** agateexcel table_xls.EXCEL_TO_AGATE_TYPE, by agate type name. */
const EXCEL_TO_AGATE_TYPE = {
  [XL_CELL_EMPTY]: 'Boolean', [XL_CELL_TEXT]: 'Text', [XL_CELL_NUMBER]: 'Number', [XL_CELL_DATE]: 'DateTime',
  [XL_CELL_BOOLEAN]: 'Boolean', [XL_CELL_ERROR]: 'Text',
};

/** A cell value as agate-excel passes it on: floats keep their Python float printing. */
function pyValue(type, value) {
  if (type === XL_CELL_NUMBER || type === XL_CELL_DATE) return new PyFloat(value);
  if (type === XL_CELL_BOOLEAN || type === XL_CELL_ERROR) return { pyInt: BigInt(value) };
  return value;
}

/** Python str() of a header cell value. */
function headerName(type, value) {
  if (type === XL_CELL_NUMBER || type === XL_CELL_DATE) return new PyFloat(value).pyStr();
  return String(value);
}

/**
 * agateexcel from_xls without the final Table: each selected sheet's column names and rows, sheet by sheet, so
 * that the caller builds each table before the next sheet is read.
 * @param {Buffer} contents XLS bytes
 * @param {object} o {sheets: Array<string|number|null>, skipLines, header, encodingOverride, log}
 * @returns {Generator<{title: string, columnNames: Array|null, rows: Array[], columnTypes: string[]|null}>} column
 *   types are agate-excel's own for every sheet after the first: from_xls consumes the caller's column_types
 *   with the first sheet it reads.
 * @throws {Error} pyName xlrd.biffh.XLRDError for an unsupported format or an unknown sheet name, IndexError for
 *   a sheet index out of range, OSError for an OLE file without a Workbook stream, and the errors olefile and xlrd
 *   raise for damaged files
 */
function* readXls(contents, o) {
  let book;
  try {
    book = openWorkbook(contents, o.encodingOverride, o.log);
  } catch (e) {
    if (e.pyName !== 'xlrd.compdoc.CompDocError') throw e;
    const ole = new OleFileIO(contents);
    if (!ole.exists('Workbook')) throw pyError('OSError', 'No Workbook stream found in OLE file');
    book = openWorkbook(ole.openstream('Workbook'), null, o.log);
  }
  let first = true;
  for (const spec of o.sheets) {
    let sheet;
    if (typeof spec === 'string') sheet = book.sheetByName(spec);
    else if (typeof spec === 'number') sheet = book.sheetByIndex(spec);
    else sheet = book.sheetByIndex(0);
    const offset = o.header ? 1 : 0;
    const columnNames = o.header ? [] : null;
    const columns = [];
    const columnTypes = [];
    for (let i = 0; i < sheet.ncols; i++) {
      const cells = sheet.column(i, o.skipLines + offset);
      const types = new Set(cells.map((c) => c[0]));
      types.delete(XL_CELL_EMPTY);
      const excelType = types.size > 1 ? XL_CELL_TEXT : (types.size ? [...types][0] : XL_CELL_EMPTY);
      let agateType = EXCEL_TO_AGATE_TYPE[excelType];
      let values;
      if (excelType === XL_CELL_BOOLEAN) {
        values = cells.map(([, v]) => (v === null || v === '' ? null : Boolean(v)));
      } else if (excelType === XL_CELL_DATE) {
        values = cells.map(([, v]) => normalizeDate(v, book.datemode));
        if (!values.some((v) => v instanceof PyDateTime)) agateType = 'Date';
      } else {
        values = cells.map(([t, v]) => (t === XL_CELL_DATE ? normalizeDate(v, book.datemode) : pyValue(t, v)));
      }
      if (o.header) {
        const v = sheet.cellValue(o.skipLines, i);
        const [t] = sheet.cell(o.skipLines, i);
        columnNames.push(headerName(t, v) || null);
      }
      columns.push(values);
      columnTypes.push(agateType);
    }
    const rows = [];
    if (columns.length) for (let r = 0; r < columns[0].length; r++) rows.push(columns.map((c) => c[r]));
    yield { title: sheet.name, columnNames, rows, columnTypes: first ? null : columnTypes };
    first = false;
  }
}

module.exports = { readXls, xlsSheetNames };
