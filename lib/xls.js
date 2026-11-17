'use strict';
// Port of xlrd 2.0.2 (BSD) as agate-excel 0.4.3 table_xls.from_xls and in2csv --names use it
// (open_workbook(formatting_info=False)): format detection, open_workbook_xls for BIFF 2.0 to 8 (BIFF 2-4S files
// hold one worksheet and no workbook globals, BIFF 4W worksheets are embedded in the globals stream), the workbook
// globals records, the worksheet records with the cell storage of Sheet.put_cell_unragged, and the messages xlrd
// writes to its log file; then agate-excel's column normalisation (MIT). Records are unpacked as struct.unpack
// unpacks them, so a truncated record fails with the error xlrd raises. NAME formulas are parsed for their header
// but not evaluated (xlrd's formula.evaluate_name_formula is not ported).

const { pyError } = require('./pyerrors');
const { unpack, byteAt } = require('./pystruct');
const {
  XL_CELL_EMPTY, XL_CELL_TEXT, XL_CELL_NUMBER, XL_CELL_DATE, XL_CELL_BOOLEAN, XL_CELL_ERROR, R, BOFLEN,
  FORMULA_OPCODES, BIFF_FIRST_UNICODE, BIFF_TEXT, xlrdError, assertionError, unpackString, unpackStringUpdatePos,
  unpackUnicode, unpackUnicodeUpdatePos, unpackCellRangeAddressListUpdatePos, hexCharDump,
} = require('./biffh');
const {
  FUN, CELLTY_FROM_FMTTY, initialiseFormatInfo, handleFormat, handleXf, xfEpilogue,
} = require('./xlformatting');
const { CompDoc, SIGNATURE } = require('./compdoc');
const { OleFileIO } = require('./olefile');
const { pyBytesRepr, pyRepr } = require('./pystr');
const { ZipFile } = require('./zipfile');
const codecs = require('./codecs');
const { PyFloat } = require('./pyjson');
const { PyDate, PyDateTime } = require('./types');
const { xldateAsDatetime } = require('./xldate');

const SUPPORTED_VERSIONS = [80, 70, 50, 45, 40, 30, 21, 20];
const MY_EOF = 0xF00BAAA;
const SHRFMLA_ETC_ETC = [R.SHRFMLA, R.ARRAY, R.TABLEOP, R.TABLEOP2, R.ARRAY2, R.TABLEOP_B2];
const UTTER_MAX_COLS = 256;
const URL_MONIKER = Buffer.from('E0C9EA79F9BACE118C8200AA004BA90B', 'hex');
const FILE_MONIKER = Buffer.from('0303000000000000C000000000000046', 'hex');
const HLINK_GUID = Buffer.from('D0C9EA79F9BACE118C8200AA004BA90B', 'hex');

const ENCODING_FROM_CODEPAGE = {
  1200: 'utf_16_le', 10000: 'mac_roman', 10006: 'mac_greek', 10007: 'mac_cyrillic', 10029: 'mac_latin2',
  10079: 'mac_iceland', 10081: 'mac_turkish', 32768: 'mac_roman', 32769: 'cp1252',
};

function hex4(n) {
  return n.toString(16).padStart(4, '0');
}

/** Python ascii(): repr() with every non-ASCII character escaped, as xlrd's fprintf prints %r. */
function pyAscii(s) {
  return pyRepr(s).replace(/[^\x00-\x7f]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff) return `\\x${cp.toString(16).padStart(2, '0')}`;
    if (cp <= 0xffff) return `\\u${cp.toString(16).padStart(4, '0')}`;
    return `\\U${cp.toString(16).padStart(8, '0')}`;
  });
}

/**
 * Python list indexing: negative indices count from the end.
 * @param {Array} list
 * @param {number} i
 * @param {string} kind 'list' or 'array', for the IndexError message
 * @returns {number} the index into list
 * @throws {Error} pyName IndexError for an index outside the list
 */
function pyIndex(list, i, kind = 'list') {
  const k = i < 0 ? i + list.length : i;
  if (k < 0 || k >= list.length) throw pyError('IndexError', `${kind} index out of range`);
  return k;
}

/**
 * sheet.unpack_RK: an RK number (a 30-bit integer or the top 30 bits of a double, optionally divided by 100).
 * @param {Buffer} rk the four RK bytes
 * @returns {number}
 * @throws {Error} pyName IndexError for no bytes, struct.error for fewer than four
 */
function unpackRK(rk) {
  const flags = byteAt(rk, 0);
  if (flags & 2) {
    const [i] = unpack('<i', rk);
    const n = i >> 2;
    return flags & 1 ? n / 100.0 : n;
  }
  const [d] = unpack('<d', Buffer.concat([Buffer.alloc(4), Buffer.from([flags & 252]), rk.subarray(1, 4)]));
  return flags & 1 ? d / 100.0 : d;
}

/** xlrd.sheet.Sheet: one worksheet's cells, in rows padded to ncols as put_cell_unragged keeps them. */
class Sheet {
  /**
   * @param {Book} book
   * @param {number} position the offset after the sheet's BOF record
   * @param {string} name
   * @param {number} number the sheet index as the caller gave it
   */
  constructor(book, position, name, number) {
    this.book = book;
    this.biffVersion = book.biffVersion;
    this.position = position;
    this.name = name;
    this.number = number;
    this.log = book.log;
    this.xfTypeMap = book.xfTypeMap;
    this.nrows = 0;
    this.ncols = 0;
    this.cellValues = [];
    this.cellTypes = [];
    this.utterMaxRows = this.biffVersion >= 80 ? 65536 : 16384;
    this.firstFullRowx = -1;
    this.ixfe = null;
    this.cellAttrToXfx = new Map();
    this.hyperlinkList = [];
  }

  /**
   * Sheet.put_cell_unragged: stores a cell, growing the rows to ncols; a null type is the cell's XF type.
   * @param {number} rowx
   * @param {number} colx
   * @param {number|null} ctype an XL_CELL_* type
   * @param {*} value
   * @param {number} xfIndex
   * @returns {void}
   * @throws {Error} pyName KeyError for an XF index the workbook does not define, AssertionError for a cell
   *   beyond column 255 or the last row, IndexError (after the "put_cell" log line) for a cell that lands in a row
   *   left short by a DIMENSIONS record met after the cells
   */
  putCell(rowx, colx, ctype, value, xfIndex) {
    if (ctype === null) {
      if (!this.xfTypeMap.has(xfIndex)) throw pyError('KeyError', String(xfIndex));
      ctype = this.xfTypeMap.get(xfIndex);
    }
    const types = this.cellTypes;
    const values = this.cellValues;
    if (rowx < types.length && colx < types[rowx].length) {
      types[rowx][colx] = ctype;
      values[rowx][colx] = value;
      return;
    }
    const nr = rowx + 1;
    const nc = colx + 1;
    if (!(nc >= 1 && nc <= UTTER_MAX_COLS)) throw assertionError();
    if (!(nr >= 1 && nr <= this.utterMaxRows)) throw assertionError();
    if (nc > this.ncols) {
      this.ncols = nc;
      if (nr < this.nrows) this.firstFullRowx = -2;
      else if (rowx > this.firstFullRowx && this.firstFullRowx > -2) this.firstFullRowx = rowx;
    }
    if (nr <= this.nrows) {
      const nextra = this.ncols - types[rowx].length;
      if (nextra > 0) {
        types[rowx].push(...new Array(nextra).fill(XL_CELL_EMPTY));
        values[rowx].push(...new Array(nextra).fill(''));
      }
    } else {
      for (let r = this.nrows; r < nr; r++) {
        types.push(new Array(this.ncols).fill(XL_CELL_EMPTY));
        values.push(new Array(this.ncols).fill(''));
      }
      this.nrows = nr;
    }
    if (colx >= types[rowx].length) {
      this.log(`put_cell ${rowx} ${colx}\n`);
      throw pyError('IndexError', 'array assignment index out of range');
    }
    types[rowx][colx] = ctype;
    values[rowx][colx] = value;
  }

  /**
   * Sheet.tidy_dimensions without merged cells (formatting_info is off): pads the rows not known to be full.
   * @returns {void}
   */
  tidyDimensions() {
    const ubound = this.firstFullRowx === -2 ? this.nrows : this.firstFullRowx;
    for (let rowx = 0; rowx < ubound; rowx++) {
      const nextra = this.ncols - this.cellTypes[rowx].length;
      if (nextra > 0) {
        this.cellValues[rowx].push(...new Array(nextra).fill(''));
        this.cellTypes[rowx].push(...new Array(nextra).fill(XL_CELL_EMPTY));
      }
    }
  }

  /**
   * Sheet.cell_value.
   * @param {number} rowx a row index (negative counts from the end)
   * @param {number} colx
   * @returns {*}
   * @throws {Error} pyName IndexError for a cell outside the stored rows
   */
  cellValue(rowx, colx) {
    const row = this.cellValues[pyIndex(this.cellValues, rowx)];
    return row[pyIndex(row, colx)];
  }

  /**
   * Sheet.cell_type.
   * @param {number} rowx a row index (negative counts from the end)
   * @param {number} colx
   * @returns {number}
   * @throws {Error} pyName IndexError for a cell outside the stored rows
   */
  cellType(rowx, colx) {
    const row = this.cellTypes[pyIndex(this.cellTypes, rowx)];
    return row[pyIndex(row, colx, 'array')];
  }

  /**
   * The row range of Sheet.col_values / col_types from start to the last row.
   * @param {number} start
   * @returns {Array<number>} [start, end]
   */
  colRange(start) {
    const nr = this.nrows;
    if (start < 0) start = Math.max(0, start + nr);
    return [start, nr];
  }

  /**
   * Sheet.col_values(colx, start).
   * @param {number} colx
   * @param {number} start the first row (negative counts from the end)
   * @returns {Array}
   * @throws {Error} pyName IndexError for a row shorter than colx
   */
  colValues(colx, start) {
    const [a, b] = this.colRange(start);
    const out = [];
    for (let r = a; r < b; r++) out.push(this.cellValue(r, colx));
    return out;
  }

  /**
   * Sheet.col_types(colx, start).
   * @param {number} colx
   * @param {number} start the first row (negative counts from the end)
   * @returns {number[]}
   * @throws {Error} pyName IndexError for a row shorter than colx
   */
  colTypes(colx, start) {
    const [a, b] = this.colRange(start);
    const out = [];
    for (let r = a; r < b; r++) out.push(this.cellType(r, colx));
    return out;
  }

  /**
   * Sheet.string_record_contents: the text of a STRING record and the CONTINUE records after it.
   * @param {Buffer} data the STRING record
   * @returns {string}
   * @throws {Error} pyName xlrd.biffh.XLRDError for more characters than declared or a missing CONTINUE record,
   *   struct.error or IndexError for a short record, and decoding errors
   */
  stringRecordContents(data) {
    const bv = this.biffVersion;
    const bk = this.book;
    const lenlen = (bv >= 30 ? 1 : 0) + 1;
    const [expected] = unpack(lenlen === 1 ? '<B' : '<H', data.subarray(0, lenlen));
    let offset = lenlen;
    let enc = bv < 80 ? bk.encoding || bk.deriveEncoding() : null;
    let found = 0;
    let result = '';
    for (;;) {
      if (bv >= 80) {
        enc = byteAt(data, offset) & 1 ? 'utf_16_le' : 'latin_1';
        offset += 1;
      }
      const chunk = codecs.decode(data.subarray(offset), enc);
      result += chunk;
      found += Array.from(chunk).length;
      if (found === expected) return result;
      if (found > expected) throw xlrdError(`STRING/CONTINUE: expected ${expected} chars, found ${found}`);
      const [rc, , next] = bk.getRecordParts();
      if (rc !== R.CONTINUE) throw xlrdError(`Expected CONTINUE record; found record-type 0x${hex4(rc).toUpperCase()}`);
      data = next;
      offset = 0;
    }
  }

  /**
   * Sheet.fixed_BIFF2_xfindex: the XF index of a BIFF2 cell. BIFF 2.1 cells name their XF (63 meaning the last
   * IXFE record); without XF records (BIFF 2.0) an XF is made for each distinct set of cell attributes.
   * @param {Buffer} cellAttr the three attribute bytes
   * @param {number|null} trueXfx
   * @returns {number}
   * @throws {Error} pyName xlrd.biffh.XLRDError for index 63 without IXFE, AssertionError for a BIFF 2.0 cell
   *   whose XF slot is not zero
   */
  fixedBIFF2Xfindex(cellAttr, trueXfx = null) {
    if (this.biffVersion === 21) {
      if (this.book.xfList.length) {
        let xfx = trueXfx !== null ? trueXfx : byteAt(cellAttr, 0) & 0x3F;
        if (xfx === 0x3F) {
          if (this.ixfe === null) throw xlrdError('BIFF2 cell record has XF index 63 but no preceding IXFE record.');
          xfx = this.ixfe;
        }
        return xfx;
      }
      this.biffVersion = 20;
      this.book.biffVersion = 20;
    }
    if ((byteAt(cellAttr, 0) & 0x3F) !== 0) throw assertionError();
    const key = cellAttr.toString('latin1');
    if (this.cellAttrToXfx.has(key)) return this.cellAttrToXfx.get(key);
    if (!this.book.xfList.length) {
      for (let xfx = 0; xfx < 16; xfx++) this.insertNewBIFF20Xf(Buffer.from([0x40, 0, 0]));
    }
    return this.insertNewBIFF20Xf(cellAttr);
  }

  /**
   * Sheet.insert_new_BIFF20_xf: an XF made from BIFF 2.0 cell attributes, its format added as General when the
   * file has no such FORMAT record (logged unless it is format 0).
   * @param {Buffer} cellAttr
   * @returns {number} the new XF index
   */
  insertNewBIFF20Xf(cellAttr) {
    const book = this.book;
    const xfx = book.xfList.length;
    const [, fontAndFormat] = unpack('<BBB', cellAttr);
    const xf = { xfIndex: xfx, formatKey: fontAndFormat & 0x3F };
    book.xfList.push(xf);
    if (!book.formatMap.has(xf.formatKey)) {
      if (xf.formatKey) {
        this.log(`ERROR *** XF[${xf.xfIndex}] unknown format key (${xf.formatKey}, 0x${hex4(xf.formatKey)})\n`);
      }
      const fmt = { formatKey: xf.formatKey, type: FUN, formatStr: 'General' };
      book.formatMap.set(xf.formatKey, fmt);
      book.formatList.push(fmt);
    }
    this.xfTypeMap.set(xf.xfIndex, CELLTY_FROM_FMTTY[book.formatMap.get(xf.formatKey).type]);
    this.cellAttrToXfx.set(cellAttr.toString('latin1'), xfx);
    return xfx;
  }

  /**
   * Sheet.read: the worksheet records up to its EOF. The records xlrd reads only with formatting_info (ROW, COLINFO,
   * BLANK, MULBLANK, MERGEDCELLS, page breaks, conditional formats ...) and those it reads only in debug mode
   * (MSODRAWING, FEAT11) are skipped, as xlrd skips them here.
   * @returns {void}
   * @throws {Error} the errors xlrd raises for the records: struct.error, IndexError, AssertionError, KeyError,
   *   UnboundLocalError, decoding errors and xlrd.biffh.XLRDError
   */
  read() {
    const bk = this.book;
    const oldpos = bk.position;
    bk.position = this.position;
    const bv = this.biffVersion;
    // Whether an OBJ record has set xlrd's saved_obj_id, which a BIFF8 TXO record reads.
    let objSeen = false;
    const enc = () => bk.encoding || bk.deriveEncoding();
    for (;;) {
      const [rc, dataLen, data] = bk.getRecordParts();
      if (rc === R.NUMBER) {
        const [rowx, colx, xfIndex, d] = unpack('<HHHd', data.subarray(0, 14));
        this.putCell(rowx, colx, null, d, xfIndex);
      } else if (rc === R.LABELSST) {
        const [rowx, colx, xfIndex, sstindex] = unpack('<HHHi', data);
        const ss = bk.sharedStrings;
        this.putCell(rowx, colx, XL_CELL_TEXT, ss[pyIndex(ss, sstindex)], xfIndex);
      } else if (rc === R.LABEL) {
        const [rowx, colx, xfIndex] = unpack('<HHH', data.subarray(0, 6));
        const strg = bv < BIFF_FIRST_UNICODE ? unpackString(data, 6, enc(), 2) : unpackUnicode(data, 6, 2);
        this.putCell(rowx, colx, XL_CELL_TEXT, strg, xfIndex);
      } else if (rc === R.RSTRING) {
        const [rowx, colx, xfIndex] = unpack('<HHH', data.subarray(0, 6));
        let strg;
        let pos;
        if (bv < BIFF_FIRST_UNICODE) {
          [strg, pos] = unpackStringUpdatePos(data, 6, enc(), 2);
          const nrt = byteAt(data, pos);
          pos += 1;
          for (let k = 0; k < nrt; k++) {
            unpack('<BB', data.subarray(pos, pos + 2));
            pos += 2;
          }
        } else {
          [strg, pos] = unpackUnicodeUpdatePos(data, 6, 2);
          const [nrt] = unpack('<H', data.subarray(pos, pos + 2));
          pos += 2;
          for (let k = 0; k < nrt; k++) {
            unpack('<HH', data.subarray(pos, pos + 4));
            pos += 4;
          }
        }
        if (pos !== data.length) throw assertionError();
        this.putCell(rowx, colx, XL_CELL_TEXT, strg, xfIndex);
      } else if (rc === R.RK) {
        const [rowx, colx, xfIndex] = unpack('<HHH', data.subarray(0, 6));
        this.putCell(rowx, colx, null, unpackRK(data.subarray(6, 10)), xfIndex);
      } else if (rc === R.MULRK) {
        const [row, first] = unpack('<HH', data.subarray(0, 4));
        const [last] = unpack('<H', data.subarray(-2));
        let pos = 4;
        for (let colx = first; colx <= last; colx++) {
          const [xfIndex] = unpack('<H', data.subarray(pos, pos + 2));
          const d = unpackRK(data.subarray(pos + 2, pos + 6));
          pos += 6;
          this.putCell(row, colx, null, d, xfIndex);
        }
      } else if (FORMULA_OPCODES.includes(rc)) {
        this.readFormula(data, bv);
      } else if (rc === R.BOOLERR) {
        const [rowx, colx, xfIndex, value, isErr] = unpack('<HHHBB', data.subarray(0, 8));
        this.putCell(rowx, colx, this.boolerrType(isErr), value, xfIndex);
      } else if (rc === R.DEFCOLWIDTH) {
        unpack('<H', data.subarray(0, 2));
      } else if (rc === R.STANDARDWIDTH) {
        if (dataLen !== 2) this.log(`*** ERROR *** STANDARDWIDTH ${dataLen} ${pyBytesRepr(data)}\n`);
        unpack('<H', data.subarray(0, 2));
      } else if (rc === R.DIMENSION || rc === R.DIMENSION2) {
        if (dataLen === 0) continue;
        if (bv < 80) unpack('<HxxH', data.subarray(2, 8));
        else unpack('<ixxH', data.subarray(4, 12));
        this.nrows = 0;
        this.ncols = 0;
        if ([21, 30, 40].includes(bv) && bk.xfList.length && !bk.xfEpilogueDone) xfEpilogue(bk);
      } else if (rc === R.HLINK) {
        this.handleHlink(data);
      } else if (rc === R.QUICKTIP) {
        this.handleQuicktip(data);
      } else if (rc === R.EOF) {
        break;
      } else if (rc === R.OBJ) {
        const savedObj = this.handleObj(data);
        if (savedObj && !('id' in savedObj)) throw pyError('AttributeError', "'MSObj' object has no attribute 'id'");
        objSeen = true;
      } else if (rc === R.TXO) {
        if (this.handleTxo(data) && !objSeen) {
          throw pyError('UnboundLocalError',
            "cannot access local variable 'saved_obj_id' where it is not associated with a value");
        }
      } else if (rc === R.NOTE) {
        this.handleNote(data);
      } else if (BOFLEN.has(rc)) {
        const [version, boftype] = unpack('<HH', data.subarray(0, 4));
        if (boftype !== 0x20) {
          this.log(`*** Unexpected embedded BOF (0x${hex4(rc)}) at offset ${bk.position - dataLen - 4}: `
            + `version=0x${hex4(version)} type=0x${hex4(boftype)}\n`);
        }
        for (;;) {
          const [code] = bk.getRecordParts();
          if (code === R.EOF) break;
        }
      } else if (rc === R.COUNTRY) {
        bk.handleCountry(data);
      } else if (rc === R.LABELRANGES) {
        let pos = unpackCellRangeAddressListUpdatePos([], data, 0, 8);
        pos = unpackCellRangeAddressListUpdatePos([], data, pos, 8);
        if (pos !== dataLen) throw assertionError();
      } else if (rc === R.ARRAY) {
        unpack('<HHBBBxxxxxH', data.subarray(0, 14));
      } else if (rc === R.SHRFMLA) {
        unpack('<HHBBxBH', data.subarray(0, 10));
      } else if (rc === R.DEFAULTROWHEIGHT) {
        if (dataLen === 4) {
          unpack('<HH', data.subarray(0, 4));
        } else if (dataLen === 2) {
          unpack('<H', data);
          this.log('*** WARNING: DEFAULTROWHEIGHT record len is 2, should be 4; assuming BIFF2 format\n');
        } else {
          this.log(`*** WARNING: DEFAULTROWHEIGHT record len is ${dataLen}, should be 4; ignoring this record\n`);
        }
      } else if (rc === R.WINDOW2) {
        if (bv >= 80 && dataLen >= 14) {
          unpack('<HHHHxxHH', data.subarray(0, 14));
        } else {
          if (!(bv >= 30)) throw assertionError();
          unpack('<HHH', data.subarray(0, 6));
          unpack('<BBB', data.subarray(6, 9));
        }
      } else if (rc === R.SCL) {
        const [num, den] = unpack('<HH', data);
        const result = den ? Math.floor((num * 100) / den) : 0;
        if (!(result >= 10 && result <= 400)) {
          this.log(`WARNING *** SCL rcd sheet ${this.number}: should have 0.1 <= num/den <= 4; got ${num}/${den}\n`);
        }
      } else if (rc === R.PANE) {
        unpack('<HHHHB', data.subarray(0, 9));
      } else if (bv <= 45) {
        this.readBiff2To4Record(rc, data);
      }
    }
    this.tidyDimensions();
    bk.position = oldpos;
  }

  /**
   * The cell type of a BOOLERR record: xlrd indexes (XL_CELL_BOOLEAN, XL_CELL_ERROR) with the error flag.
   * @param {number} isErr
   * @returns {number}
   * @throws {Error} pyName IndexError for a flag above 1
   */
  boolerrType(isErr) {
    if (isErr > 1) throw pyError('IndexError', 'tuple index out of range');
    return isErr ? XL_CELL_ERROR : XL_CELL_BOOLEAN;
  }

  /**
   * The branch of Sheet.read for records that only BIFF 2 to 4W worksheets hold: formats, XFs, the book-level
   * records of a worksheet stream and the BIFF2 cell records.
   * @param {number} rc the record code
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} as read()
   */
  readBiff2To4Record(rc, data) {
    const bk = this.book;
    const enc = () => bk.encoding || bk.deriveEncoding();
    if (rc === R.FORMAT || rc === R.FORMAT2) {
      handleFormat(bk, data, rc);
    } else if (rc === R.STYLE) {
      if (!bk.xfEpilogueDone) xfEpilogue(bk);
    } else if (rc === R.BUILTINFMTCOUNT) {
      unpack('<H', data.subarray(0, 2));
    } else if (rc === R.XF4 || rc === R.XF3 || rc === R.XF2) {
      handleXf(bk, data);
    } else if (rc === R.DATEMODE) {
      bk.handleDatemode(data);
    } else if (rc === R.CODEPAGE) {
      bk.handleCodepage(data);
    } else if (rc === R.FILEPASS) {
      bk.handleFilepass();
    } else if (rc === R.WRITEACCESS) {
      bk.handleWriteaccess(data);
    } else if (rc === R.IXFE) {
      [this.ixfe] = unpack('<H', data);
    } else if (rc === R.NUMBER_B2) {
      const [rowx, colx, cellAttr, d] = unpack('<HH3sd', data);
      this.putCell(rowx, colx, null, d, this.fixedBIFF2Xfindex(cellAttr));
    } else if (rc === R.INTEGER) {
      const [rowx, colx, cellAttr, d] = unpack('<HH3sH', data);
      this.putCell(rowx, colx, null, d, this.fixedBIFF2Xfindex(cellAttr));
    } else if (rc === R.LABEL_B2) {
      const [rowx, colx, cellAttr] = unpack('<HH3s', data.subarray(0, 7));
      const strg = unpackString(data, 7, enc(), 1);
      this.putCell(rowx, colx, XL_CELL_TEXT, strg, this.fixedBIFF2Xfindex(cellAttr));
    } else if (rc === R.BOOLERR_B2) {
      const [rowx, colx, cellAttr, value, isErr] = unpack('<HH3sBB', data);
      const cellty = this.boolerrType(isErr);
      this.putCell(rowx, colx, cellty, value, this.fixedBIFF2Xfindex(cellAttr));
    } else if (rc === R.WINDOW2_B2) {
      unpack('<HHB', data.subarray(5, 10));
      unpack('<BBB', data.subarray(10, 13));
    }
  }

  /**
   * The FORMULA branch of Sheet.read: stores the cached result as the cell, reading the STRING record (after an
   * optional SHRFMLA, ARRAY or TABLEOP record) for a string result.
   * @param {Buffer} data the FORMULA record
   * @param {number} bv the BIFF version the sheet started reading with
   * @returns {void}
   * @throws {Error} pyName xlrd.biffh.XLRDError for an unexpected record after the formula or an unknown result
   *   type, struct.error for short records, and putCell()'s errors
   */
  readFormula(data, bv) {
    const bk = this.book;
    let rowx;
    let colx;
    let xfIndex;
    let resultStr;
    if (bv >= 30) {
      [rowx, colx, xfIndex, resultStr] = unpack('<HHH8sH', data.subarray(0, 16));
    } else {
      let cellAttr;
      [rowx, colx, cellAttr, resultStr] = unpack('<HH3s8sB', data.subarray(0, 16));
      xfIndex = this.fixedBIFF2Xfindex(cellAttr);
    }
    if (resultStr[6] !== 0xFF || resultStr[7] !== 0xFF) {
      const [d] = unpack('<d', resultStr);
      this.putCell(rowx, colx, null, d, xfIndex);
      return;
    }
    const firstByte = resultStr[0];
    if (firstByte === 0) {
      let gotstring = false;
      let [rc2, , data2] = bk.getRecordParts();
      if (rc2 === R.STRING || rc2 === R.STRING_B2) {
        gotstring = true;
      } else if (rc2 === R.ARRAY) {
        unpack('<HHBBBxxxxxH', data2.subarray(0, 14));
      } else if (rc2 === R.SHRFMLA) {
        unpack('<HHBBxBH', data2.subarray(0, 10));
      } else if (!SHRFMLA_ETC_ETC.includes(rc2)) {
        throw xlrdError(`Expected SHRFMLA, ARRAY, TABLEOP* or STRING record; found 0x${hex4(rc2)}`);
      }
      if (!gotstring) {
        [rc2, , data2] = bk.getRecordParts();
        if (rc2 !== R.STRING && rc2 !== R.STRING_B2) throw xlrdError(`Expected STRING record; found 0x${hex4(rc2)}`);
      }
      this.putCell(rowx, colx, XL_CELL_TEXT, this.stringRecordContents(data2), xfIndex);
    } else if (firstByte === 1) {
      this.putCell(rowx, colx, XL_CELL_BOOLEAN, resultStr[2], xfIndex);
    } else if (firstByte === 2) {
      this.putCell(rowx, colx, XL_CELL_ERROR, resultStr[2], xfIndex);
    } else if (firstByte === 3) {
      this.putCell(rowx, colx, XL_CELL_TEXT, '', xfIndex);
    } else {
      throw xlrdError(`unexpected special case (0x${firstByte.toString(16).padStart(2, '0')}) in FORMULA`);
    }
  }

  /**
   * Sheet.handle_hlink: checks a HLINK record the way xlrd parses it, logging trailing bytes.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName AssertionError for a bad GUID or moniker size, struct.error for a short record,
   *   UnicodeDecodeError for bad UTF-16, xlrd.biffh.XLRDError when the parts overrun the record
   */
  handleHlink(data) {
    const recordSize = data.length;
    const [frowx, lrowx, fcolx, lcolx, guid0, dummy, options] = unpack('<HHHH16s4si', data.subarray(0, 32));
    if (!guid0.equals(HLINK_GUID)) throw assertionError();
    if (!dummy.equals(Buffer.from([2, 0, 0, 0]))) throw assertionError();
    let offset = 32;
    // get_nul_terminated_unicode: a counted UTF-16 string; returns the offset after it.
    const nulTerminatedUnicode = (ofs) => {
      const nb = unpack('<L', data.subarray(ofs, ofs + 4))[0] * 2;
      ofs += 4;
      codecs.decode(data.subarray(ofs, ofs + nb), 'utf_16_le');
      return ofs + nb;
    };
    if (options & 0x14) offset = nulTerminatedUnicode(offset);
    if (options & 0x80) offset = nulTerminatedUnicode(offset);
    if ((options & 1) && !(options & 0x100)) {
      const [clsid] = unpack('<16s', data.subarray(offset, offset + 16));
      offset += 16;
      if (clsid.equals(URL_MONIKER)) {
        const [nbytes] = unpack('<L', data.subarray(offset, offset + 4));
        offset += 4;
        const url = Array.from(codecs.decode(data.subarray(offset, offset + nbytes), 'utf_16_le'));
        const endpos = url.indexOf('\x00');
        const trueNbytes = 2 * (endpos + 1);
        offset += trueNbytes;
        const extraNbytes = nbytes - trueNbytes;
        offset += extraNbytes;
        if (extraNbytes !== 24 && extraNbytes !== 0) throw assertionError();
      } else if (clsid.equals(FILE_MONIKER)) {
        const [, nbytes] = unpack('<Hi', data.subarray(offset, offset + 6));
        offset += 6;
        offset += nbytes;
        offset += 24;
        const [sz] = unpack('<i', data.subarray(offset, offset + 4));
        offset += 4;
        if (sz) {
          const [xl] = unpack('<i', data.subarray(offset, offset + 4));
          offset += 4;
          offset += 2;
          codecs.decode(data.subarray(offset, offset + xl), 'utf_16_le');
          offset += xl;
        }
      } else {
        this.log(`*** unknown clsid ${pyBytesRepr(clsid)}\n`);
      }
    } else if ((options & 0x163) === 0x103) {
      offset = nulTerminatedUnicode(offset);
    }
    if (options & 0x8) offset = nulTerminatedUnicode(offset);
    const extraNbytes = recordSize - offset;
    if (extraNbytes > 0) {
      this.log(`*** WARNING: hyperlink at R${frowx + 1}C${fcolx + 1} has ${extraNbytes} extra data bytes: `
        + `${pyBytesRepr(data.subarray(-extraNbytes))}\n`);
    } else if (extraNbytes < 0) {
      throw xlrdError('Bug or corrupt file, send copy of input file for debugging');
    }
    this.hyperlinkList.push({ frowx, lrowx, fcolx, lcolx });
  }

  /**
   * Sheet.handle_quicktip: the tooltip of the hyperlink just read.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName AssertionError for a tooltip that does not follow its hyperlink, struct.error for a
   *   short record, UnicodeDecodeError for bad UTF-16
   */
  handleQuicktip(data) {
    const [rcx, frowx, lrowx, fcolx, lcolx] = unpack('<5H', data.subarray(0, 10));
    if (rcx !== R.QUICKTIP) throw assertionError();
    if (!this.hyperlinkList.length) throw assertionError();
    const h = this.hyperlinkList[this.hyperlinkList.length - 1];
    if (frowx !== h.frowx || lrowx !== h.lrowx || fcolx !== h.fcolx || lcolx !== h.lcolx) throw assertionError();
    if (!data.subarray(-2).equals(Buffer.from([0, 0]))) throw assertionError();
    codecs.decode(data.subarray(10, -2), 'utf_16_le');
  }

  /**
   * Sheet.handle_obj: a BIFF8 OBJ record's common data (its id); null for older BIFF or an antique record.
   * @param {Buffer} data
   * @returns {object|null} {id} or {} when the record has no subrecords
   * @throws {Error} pyName xlrd.biffh.XLRDError (after a hex dump to the log) for data after the end subrecord,
   *   AssertionError, struct.error for short subrecords
   */
  handleObj(data) {
    if (this.biffVersion < 80) return null;
    const o = {};
    const dataLen = data.length;
    let pos = 0;
    let autofilter = 0;
    while (pos < dataLen) {
      const [ft, cb] = unpack('<HH', data.subarray(pos, pos + 4));
      if (pos === 0 && !(ft === 0x15 && cb === 18)) return null;
      if (ft === 0x15) {
        if (pos !== 0) throw assertionError();
        const [, id, optionFlags] = unpack('<HHH', data.subarray(pos + 4, pos + 10));
        o.id = id;
        autofilter = (optionFlags & 0x0100) >> 8;
      } else if (ft === 0x00) {
        if (data.subarray(pos, dataLen).every((b) => b === 0)) break;
        const msg = 'Unexpected data at end of OBJECT record';
        this.log(`*** ERROR ${msg}\n`);
        hexCharDump(data, pos, dataLen - pos, this.log);
        throw xlrdError(msg);
      } else if (ft === 0x0C) {
        unpack('<5H', data.subarray(pos + 8, pos + 18));
      } else if (ft === 0x13 && autofilter) {
        break;
      }
      pos += cb + 4;
    }
    return o;
  }

  /**
   * Sheet.handle_note: a cell comment (BIFF2-7 text spread over NOTE records, BIFF8 author and object id).
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName AssertionError for inconsistent NOTE records, struct.error, IndexError and decoding
   *   errors for short or bad ones
   */
  handleNote(data) {
    const bk = this.book;
    if (this.biffVersion < 80) {
      let [, , expectedBytes] = unpack('<HHH', data.subarray(0, 6));
      const nb = data.length - 6;
      if (!(nb <= expectedBytes)) throw assertionError();
      const pieces = [data.subarray(6)];
      expectedBytes -= nb;
      while (expectedBytes > 0) {
        const [rc2, data2Len, data2] = bk.getRecordParts();
        if (rc2 !== R.NOTE) throw assertionError();
        const [dummyRowx, nb2] = unpack('<H2xH', data2.subarray(0, 6));
        if (dummyRowx !== 0xFFFF) throw assertionError();
        if (nb2 !== data2Len - 6) throw assertionError();
        pieces.push(data2.subarray(6));
        expectedBytes -= nb2;
      }
      if (expectedBytes !== 0) throw assertionError();
      codecs.decode(Buffer.concat(pieces), bk.encoding || bk.deriveEncoding());
      return;
    }
    unpack('<4H', data.subarray(0, 8));
    const [, endpos] = unpackUnicodeUpdatePos(data, 8, 2);
    if (data.length - endpos !== 0 && data.length - endpos !== 1) throw assertionError();
  }

  /**
   * Sheet.handle_txo: a BIFF8 text object, its text and formatting runs read from the CONTINUE records after it.
   * @param {Buffer} data
   * @returns {boolean} whether a text object was read (xlrd reads none before BIFF8)
   * @throws {Error} pyName AssertionError for missing or malformed CONTINUE records, struct.error, IndexError and
   *   decoding errors
   */
  handleTxo(data) {
    if (this.biffVersion < 80) return false;
    const bk = this.book;
    const [, , , cchText, cbRuns] = unpack('<HH6sHHH', data.subarray(0, 16));
    let totchars = 0;
    while (totchars < cchText) {
      const [rc2, data2Len, data2] = bk.getRecordParts();
      if (rc2 !== R.CONTINUE) throw assertionError();
      const nb = byteAt(data2, 0);
      let nchars = data2Len - 1;
      if (nb) {
        if (nchars % 2 !== 0) throw assertionError();
        nchars = Math.floor(nchars / 2);
      }
      const [, endpos] = unpackUnicodeUpdatePos(data2, 0, 2, nchars);
      if (endpos !== data2Len) throw assertionError();
      totchars += nchars;
    }
    let totruns = 0;
    while (totruns < cbRuns) {
      const [rc3, data3Len, data3] = bk.getRecordParts();
      if (rc3 !== R.CONTINUE) throw assertionError();
      if (data3Len % 8 !== 0) throw assertionError();
      for (let pos = 0; pos < data3Len; pos += 8) {
        unpack('<HH4x', data3.subarray(pos, pos + 8));
        totruns += 8;
      }
    }
    return true;
  }
}

/** xlrd.book.Book, as open_workbook_xls fills it. */
class Book {
  /**
   * @param {function(string): void} log xlrd's logfile
   * @param {string|null} encodingOverride
   */
  constructor(log, encodingOverride) {
    this.log = log;
    this.encodingOverride = encodingOverride;
    this.sheetList = [];
    this.sheetNames = [];
    this.nsheets = 0;
    this.shAbsPosn = [];
    this.sharedStrings = [];
    // A BIFF2-7 WRITEACCESS record met before the encoding was known, decoded once it is.
    this.rawUserName = null;
    this.sheethdrCount = 0;
    initialiseFormatInfo(this);
    this.supbookCount = 0;
    // EXTERNSHEET number -> sheet name (BIFF5/7), for the NAME records' sheet references.
    this.extnshtNameFromNum = new Map();
    this.extnshtCount = 0;
    this.resourcesReleased = false;
    this.nameObjList = [];
    this.datemode = 0;
    this.biffVersion = 0;
    this.codepage = null;
    this.encoding = null;
    this.countries = [0, 0];
    this.sheetsoffset = null;
    this.mem = Buffer.alloc(0);
    this.base = 0;
    this.position = 0;
  }

  /**
   * Book.biff2_8_load: the workbook stream, from an OLE2 compound document or the raw bytes.
   * @param {Buffer} contents
   * @returns {void}
   * @throws {Error} pyName xlrd.biffh.XLRDError when the document has no Workbook or Book stream, and the
   *   xlrd.compdoc.CompDocError of a damaged compound document
   */
  biff28Load(contents) {
    this.base = 0;
    if (!contents.subarray(0, 8).equals(SIGNATURE)) {
      this.mem = contents;
    } else {
      const cd = new CompDoc(contents, this.log);
      let found = false;
      for (const qname of ['Workbook', 'Book']) {
        [this.mem, this.base] = cd.locateNamedStream(qname);
        if (this.mem && this.mem.length) {
          found = true;
          break;
        }
      }
      if (!found) throw xlrdError("Can't find workbook in OLE2 compound document");
    }
    this.position = this.base;
  }

  /** @returns {number} Book.get2bytes: the uint16 at the position, MY_EOF when fewer than 2 bytes are left */
  get2bytes() {
    const pos = this.position;
    const b = this.mem.subarray(pos, pos + 2);
    this.position += b.length;
    return b.length < 2 ? MY_EOF : b.readUInt16LE(0);
  }

  /**
   * Book.get_record_parts: the next BIFF record; its data is cut short at the end of the stream.
   * @returns {Array} [opcode, declared length, data]
   * @throws {Error} pyName struct.error when fewer than 4 bytes are left
   */
  getRecordParts() {
    const pos = this.position;
    const [code, length] = unpack('<HH', this.mem.subarray(pos, pos + 4));
    const data = this.mem.subarray(pos + 4, pos + 4 + length);
    this.position = pos + 4 + length;
    return [code, length, data];
  }

  /**
   * Book.get_record_parts_conditional: the next record if it has the given code.
   * @param {number} reqdRecord
   * @returns {Array} [opcode, length, data], or [null, 0, empty] without moving
   * @throws {Error} pyName struct.error when fewer than 4 bytes are left
   */
  getRecordPartsConditional(reqdRecord) {
    const pos = this.position;
    const [code] = unpack('<HH', this.mem.subarray(pos, pos + 4));
    if (code !== reqdRecord) return [null, 0, Buffer.alloc(0)];
    return this.getRecordParts();
  }

  /**
   * Book.get_sheet: reads a worksheet from its BOF record (at its BOUNDSHEET position, or here for BIFF 4W).
   * @param {number} shNumber
   * @param {boolean} updatePos
   * @returns {Sheet}
   * @throws {Error} pyName xlrd.biffh.XLRDError after release_resources() or for a bad BOF, IndexError for a
   *   sheet number out of range, and the errors of Sheet.read()
   */
  getSheet(shNumber, updatePos = true) {
    if (this.resourcesReleased) throw xlrdError("Can't load sheets after releasing resources.");
    if (updatePos) this.position = this.shAbsPosn[pyIndex(this.shAbsPosn, shNumber)];
    this.getbof(R.WORKSHEET);
    const sh = new Sheet(this, this.position, this.sheetNames[pyIndex(this.sheetNames, shNumber)], shNumber);
    sh.read();
    this.sheetList[pyIndex(this.sheetList, shNumber)] = sh;
    return sh;
  }

  /**
   * Book.get_sheets: every worksheet in order.
   * @returns {void}
   * @throws {Error} as getSheet()
   */
  getSheets() {
    for (let i = 0; i < this.sheetNames.length; i++) this.getSheet(i);
  }

  /**
   * Book.fake_globals_get_sheet: a BIFF 2 to 4S file is one worksheet, named "Sheet 1", read from offset 0.
   * @returns {void}
   * @throws {Error} as getSheet()
   */
  fakeGlobalsGetSheet() {
    this.xfEpilogueDone = false;
    this.sheetNames = ['Sheet 1'];
    this.shAbsPosn = [0];
    this.sheetList.push(null);
    this.getSheets();
  }

  /**
   * Book.release_resources.
   * @returns {void}
   */
  releaseResources() {
    this.resourcesReleased = true;
    this.mem = null;
    this.sharedStrings = null;
  }

  /**
   * Book.sheet_by_index, reading the sheet on first use.
   * @param {number} i a sheet index (negative counts from the end)
   * @returns {Sheet}
   * @throws {Error} pyName IndexError for an index out of range, and the errors of getSheet()
   */
  sheetByIndex(i) {
    return this.sheetList[pyIndex(this.sheetList, i)] || this.getSheet(i);
  }

  /**
   * Book.sheet_by_name.
   * @param {string} name
   * @returns {Sheet}
   * @throws {Error} pyName xlrd.biffh.XLRDError for a name the workbook does not have, and sheetByIndex()'s errors
   */
  sheetByName(name) {
    const i = this.sheetNames.indexOf(name);
    if (i < 0) throw xlrdError(`No sheet named <${pyRepr(name)}>`);
    return this.sheetByIndex(i);
  }

  /**
   * Book.derive_encoding: the text encoding from --encoding-xls or the CODEPAGE record, checked by decoding a trial
   * string; a BIFF2-7 user name met before the encoding was known is decoded now.
   * @returns {string|null} the encoding (null for BIFF8 without a code page, which needs none)
   * @throws {Error} pyName LookupError for an encoding Python does not know (logged first, as xlrd logs it), and
   *   the errors of decoding the user name
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
        this.log(`ERROR *** codepage ${cp} -> encoding ${pyAscii(this.encoding)} -> ${kind}: ${e.message}\n`);
        throw e;
      }
    }
    if (this.rawUserName) {
      unpackString(this.rawUserName, 0, this.encoding, 1);
      this.rawUserName = null;
    }
    return this.encoding;
  }

  /**
   * Book.handle_boundsheet: a worksheet's name and stream position (other sheet types are counted, not listed).
   * In BIFF 4W the record holds only the name, and the first sheet's position comes from SHEETSOFFSET.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName AttributeError for a BIFF 4W BOUNDSHEET before SHEETSOFFSET, struct.error, IndexError
   *   and decoding errors for a bad record, and deriveEncoding()'s errors
   */
  handleBoundsheet(data) {
    const bv = this.biffVersion;
    this.deriveEncoding();
    let sheetName;
    let sheetType;
    let absPosn;
    if (bv === 45) {
      sheetName = unpackString(data, 0, this.encoding, 1);
      sheetType = R.BOUNDSHEET_WORKSHEET;
      if (this.shAbsPosn.length === 0) {
        if (this.sheetsoffset === null) throw pyError('AttributeError', "'Book' object has no attribute '_sheetsoffset'");
        absPosn = this.sheetsoffset + this.base;
      } else {
        absPosn = -1;
      }
    } else {
      let offset;
      [offset, , sheetType] = unpack('<iBB', data.subarray(0, 6));
      absPosn = offset + this.base;
      sheetName = bv < BIFF_FIRST_UNICODE ? unpackString(data, 6, this.encoding, 1) : unpackUnicode(data, 6, 1);
    }
    if (sheetType === R.BOUNDSHEET_WORKSHEET) {
      this.sheetNames.push(sheetName);
      this.shAbsPosn.push(absPosn);
    }
  }

  /**
   * Book.handle_codepage.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName struct.error for a short record, and deriveEncoding()'s errors
   */
  handleCodepage(data) {
    [this.codepage] = unpack('<H', data.subarray(0, 2));
    this.deriveEncoding();
  }

  /**
   * Book.handle_country.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName AssertionError for a second COUNTRY record that differs, struct.error for a short one
   */
  handleCountry(data) {
    const c = unpack('<HH', data.subarray(0, 4));
    const [a, b] = this.countries;
    if (!((a === 0 && b === 0) || (a === c[0] && b === c[1]))) throw assertionError();
    this.countries = c;
  }

  /**
   * Book.handle_datemode.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName AssertionError for a mode other than 0 or 1, struct.error for a short record
   */
  handleDatemode(data) {
    const [dm] = unpack('<H', data.subarray(0, 2));
    if (dm !== 0 && dm !== 1) throw assertionError();
    this.datemode = dm;
  }

  /**
   * Book.handle_filepass.
   * @returns {never}
   * @throws {Error} pyName xlrd.biffh.XLRDError always
   */
  handleFilepass() {
    throw xlrdError('Workbook is encrypted');
  }

  /**
   * Book.handle_writeaccess: decodes the user name as xlrd does (retrying a BIFF8 name without surrounding
   * whitespace); before BIFF8 it waits for the encoding when none is known yet.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName struct.error, IndexError and decoding errors for a bad record
   */
  handleWriteaccess(data) {
    if (this.biffVersion < 80) {
      if (!this.encoding) {
        this.rawUserName = data;
        return;
      }
      unpackString(data, 0, this.encoding, 1);
      return;
    }
    try {
      unpackUnicode(data, 0, 2);
    } catch (e) {
      if (e.pyName !== 'UnicodeDecodeError') throw e;
      let a = 0;
      let b = data.length;
      const space = (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
      while (a < b && space(data[a])) a++;
      while (b > a && space(data[b - 1])) b--;
      unpackUnicode(data.subarray(a, b), 0, 2);
    }
  }

  /**
   * Book.handle_externname (BIFF8): an external name; add-in function names belong to the last SUPBOOK.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName IndexError before any SUPBOOK record, struct.error and decoding errors
   */
  handleExternname(data) {
    if (this.biffVersion < 80) return;
    unpack('<HI', data.subarray(0, 6));
    unpackUnicodeUpdatePos(data, 6, 1);
    if (!this.supbookCount) throw pyError('IndexError', 'list index out of range');
  }

  /**
   * Book.handle_externsheet: BIFF8 references (joined with their CONTINUE records), or a BIFF2-7 sheet name.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName xlrd.biffh.XLRDError for a missing CONTINUE record, struct.error, decoding errors and
   *   deriveEncoding()'s errors
   */
  handleExternsheet(data) {
    this.deriveEncoding();
    this.extnshtCount += 1;
    if (this.biffVersion >= 80) {
      const [numRefs] = unpack('<H', data.subarray(0, 2));
      const bytesReqd = numRefs * 6 + 2;
      while (data.length < bytesReqd) {
        const [code2, , data2] = this.getRecordParts();
        if (code2 !== R.CONTINUE) throw xlrdError('Missing CONTINUE after EXTERNSHEET record');
        data = Buffer.concat([data, data2]);
      }
      return;
    }
    const [nc, ty] = unpack('<BB', data.subarray(0, 2));
    if (ty === 3) this.extnshtNameFromNum.set(this.extnshtCount, codecs.decode(data.subarray(2, nc + 2), this.encoding));
  }

  /**
   * Book.handle_name (BIFF5+): a defined name's header and name text; the sheet reference is kept for
   * names_epilogue().
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName struct.error, IndexError and decoding errors for a bad record, and deriveEncoding()'s
   */
  handleName(data) {
    const bv = this.biffVersion;
    if (bv < 50) return;
    this.deriveEncoding();
    const [, , nameLen, , extshtIndex] = unpack('<HBBHHH4B', data.subarray(0, 14));
    this.nameObjList.push({ extnSheetNum: extshtIndex });
    if (bv < 80) unpackStringUpdatePos(data, 14, this.encoding, 1, nameLen);
    else unpackUnicodeUpdatePos(data, 14, 2, nameLen);
  }

  /**
   * Book.names_epilogue without formula evaluation: a BIFF5/7 name's sheet reference must name an EXTERNSHEET
   * record that held a sheet name.
   * @returns {void}
   * @throws {Error} pyName KeyError for a BIFF5/7 name whose EXTERNSHEET index has no sheet name
   */
  namesEpilogue() {
    if (this.biffVersion < 50 || this.biffVersion > 70) return;
    for (const nobj of this.nameObjList) {
      if (nobj.extnSheetNum !== 0 && !this.extnshtNameFromNum.has(nobj.extnSheetNum)) {
        throw pyError('KeyError', String(nobj.extnSheetNum));
      }
    }
  }

  /**
   * Book.handle_supbook: an external workbook reference (internal, add-in, DDE/OLE or a URL with sheet names),
   * read as xlrd reads it; a sheet name cut short by the record end stops the list.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName struct.error, IndexError and decoding errors for a bad record
   */
  handleSupbook(data) {
    this.supbookCount += 1;
    const [numSheets] = unpack('<H', data.subarray(0, 2));
    if (data.subarray(2, 4).equals(Buffer.from([0x01, 0x04]))) return;
    if (data.subarray(0, 4).equals(Buffer.from([0x01, 0x00, 0x01, 0x3A]))) return;
    let [, pos] = unpackUnicodeUpdatePos(data, 2, 2);
    if (numSheets === 0) return;
    for (let x = 0; x < numSheets; x++) {
      try {
        [, pos] = unpackUnicodeUpdatePos(data, pos, 2);
      } catch (e) {
        if (e.pyName !== 'struct.error') throw e;
        break;
      }
    }
  }

  /**
   * Book.handle_sheethdr (BIFF 4W): the worksheet substream that follows, read with fresh format information.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} pyName AssertionError for a name that differs from its BOUNDSHEET record, IndexError for more
   *   SHEETHDR than BOUNDSHEET records, struct.error and decoding errors, and getSheet()'s errors
   */
  handleSheethdr(data) {
    this.deriveEncoding();
    const [sheetLen] = unpack('<i', data.subarray(0, 4));
    const sheetName = unpackString(data, 4, this.encoding, 1);
    const sheetno = this.sheethdrCount;
    if (sheetName !== this.sheetNames[pyIndex(this.sheetNames, sheetno)]) throw assertionError();
    this.sheethdrCount += 1;
    const bofPosn = this.position;
    initialiseFormatInfo(this);
    this.sheetList.push(null);
    this.getSheet(sheetno, false);
    this.position = bofPosn + sheetLen;
  }

  /**
   * Book.handle_sst: the shared strings of an SST record and the CONTINUE records after it.
   * @param {Buffer} data
   * @returns {void}
   * @throws {Error} as unpackSSTTable(), and struct.error at the end of the stream
   */
  handleSst(data) {
    const strlist = [data];
    const [uniquestrings] = unpack('<i', data.subarray(4, 8));
    for (;;) {
      const [code, , more] = this.getRecordPartsConditional(R.CONTINUE);
      if (code === null) break;
      strlist.push(more);
    }
    this.sharedStrings = unpackSSTTable(strlist, uniquestrings);
  }

  /**
   * Book.parse_globals: the workbook globals substream up to its EOF (for BIFF 4W the worksheets are read here).
   * @returns {void}
   * @throws {Error} the record handlers' errors, and struct.error at the end of the stream
   */
  parseGlobals() {
    this.xfEpilogueDone = false;
    for (;;) {
      const [rc, , data] = this.getRecordParts();
      if (rc === R.SST) this.handleSst(data);
      else if (rc === R.FORMAT) handleFormat(this, data);
      else if (rc === R.XF) handleXf(this, data);
      else if (rc === R.BOUNDSHEET) this.handleBoundsheet(data);
      else if (rc === R.DATEMODE) this.handleDatemode(data);
      else if (rc === R.CODEPAGE) this.handleCodepage(data);
      else if (rc === R.COUNTRY) this.handleCountry(data);
      else if (rc === R.EXTERNNAME) this.handleExternname(data);
      else if (rc === R.EXTERNSHEET) this.handleExternsheet(data);
      else if (rc === R.FILEPASS) this.handleFilepass();
      else if (rc === R.WRITEACCESS) this.handleWriteaccess(data);
      else if (rc === R.SHEETSOFFSET) [this.sheetsoffset] = unpack('<i', data);
      else if (rc === R.SHEETHDR) this.handleSheethdr(data);
      else if (rc === R.SUPBOOK) this.handleSupbook(data);
      else if (rc === R.NAME) this.handleName(data);
      else if (rc === R.EOF) {
        xfEpilogue(this);
        this.namesEpilogue();
        if (!this.encoding) this.deriveEncoding();
        return;
      }
    }
  }

  /**
   * Book.getbof: the BIFF version of the BOF record at the position.
   * @param {number} rqdStream the substream type required (R.WORKBOOK_GLOBALS or R.WORKSHEET)
   * @returns {number} the BIFF version (0 when the BOF names none)
   * @throws {Error} pyName xlrd.biffh.XLRDError "Unsupported format, or corrupt file: ..." for a missing, short or
   *   unexpected BOF record
   */
  getbof(rqdStream) {
    const bofError = (msg) => xlrdError(`Unsupported format, or corrupt file: ${msg}`);
    const savpos = this.position;
    const opcode = this.get2bytes();
    if (opcode === MY_EOF) throw bofError('Expected BOF record; met end of file');
    if (!BOFLEN.has(opcode)) throw bofError(`Expected BOF record; found ${pyBytesRepr(this.mem.subarray(savpos, savpos + 8))}`);
    const length = this.get2bytes();
    if (length === MY_EOF) throw bofError('Incomplete BOF record[1]; met end of file');
    if (!(length >= 4 && length <= 20)) throw bofError(`Invalid length (${length}) for BOF record type 0x${hex4(opcode)}`);
    let data = this.mem.subarray(this.position, this.position + length);
    this.position += data.length;
    if (data.length < length) throw bofError('Incomplete BOF record[2]; met end of file');
    data = Buffer.concat([data, Buffer.alloc(Math.max(0, BOFLEN.get(opcode) - length))]);
    const version1 = opcode >> 8;
    const [version2, streamtype] = unpack('<HH', data.subarray(0, 4));
    let version = 0;
    let build = 0;
    let year = 0;
    if (version1 === 0x08) {
      [build, year] = unpack('<HH', data.subarray(4, 8));
      if (version2 === 0x0600) version = 80;
      else if (version2 === 0x0500) version = year < 1994 || [2412, 3218, 3321].includes(build) ? 50 : 70;
      else version = { 0x0000: 21, 0x0007: 21, 0x0200: 21, 0x0300: 30, 0x0400: 40 }[version2] || 0;
    } else {
      version = { 0x04: 40, 0x02: 30, 0x00: 21 }[version1];
    }
    if (version === 40 && streamtype === R.WORKBOOK_GLOBALS_4W) version = 45;
    const gotGlobals = streamtype === R.WORKBOOK_GLOBALS || (version === 45 && streamtype === R.WORKBOOK_GLOBALS_4W);
    if ((rqdStream === R.WORKBOOK_GLOBALS && gotGlobals) || streamtype === rqdStream) return version;
    if (version < 50 && streamtype === R.WORKSHEET) return version;
    if (version >= 50 && streamtype === 0x0100) throw bofError('Workspace file -- no spreadsheet data');
    throw bofError(`BOF not workbook/worksheet: op=0x${hex4(opcode)} vers=0x${hex4(version2)} `
      + `strm=0x${hex4(streamtype)} build=${build} year=${year} -> BIFF${version}`);
  }
}

/**
 * book.unpack_SST_table: the shared strings spread over SST and CONTINUE records.
 * @param {Buffer[]} datatab the SST record and its CONTINUE records
 * @param {number} nstrings
 * @returns {string[]}
 * @throws {Error} pyName struct.error and IndexError for truncated strings, AssertionError for strings that end
 *   past the last record, UnicodeDecodeError for bad UTF-16
 */
function unpackSSTTable(datatab, nstrings) {
  let datainx = 0;
  const ndatas = datatab.length;
  let data = datatab[0];
  let datalen = data.length;
  let pos = 8;
  const strings = [];
  for (let i = 0; i < nstrings; i++) {
    const [nchars] = unpack('<H', data.subarray(pos, pos + 2));
    pos += 2;
    let options = byteAt(data, pos);
    pos += 1;
    let rtcount = 0;
    let phosz = 0;
    if (options & 0x08) {
      [rtcount] = unpack('<H', data.subarray(pos, pos + 2));
      pos += 2;
    }
    if (options & 0x04) {
      [phosz] = unpack('<i', data.subarray(pos, pos + 4));
      pos += 4;
    }
    let accstrg = '';
    let charsgot = 0;
    for (;;) {
      const charsneed = nchars - charsgot;
      let charsavail;
      if (options & 0x01) {
        charsavail = Math.min((datalen - pos) >> 1, charsneed);
        accstrg += codecs.decode(data.subarray(pos, pos + 2 * charsavail), 'utf_16_le');
        pos += 2 * charsavail;
      } else {
        charsavail = Math.min(datalen - pos, charsneed);
        accstrg += codecs.decode(data.subarray(pos, pos + charsavail), 'latin_1');
        pos += charsavail;
      }
      charsgot += charsavail;
      if (charsgot === nchars) break;
      datainx += 1;
      data = datatab[pyIndex(datatab, datainx)];
      datalen = data.length;
      options = byteAt(data, 0);
      pos = 1;
    }
    for (let r = 0; r < rtcount; r++) {
      if (pos === datalen) {
        pos = 0;
        datainx += 1;
        data = datatab[pyIndex(datatab, datainx)];
        datalen = data.length;
      }
      unpack('<HH', data.subarray(pos, pos + 4));
      pos += 4;
    }
    pos += phosz;
    if (pos >= datalen) {
      pos -= datalen;
      datainx += 1;
      if (datainx < ndatas) {
        data = datatab[datainx];
        datalen = data.length;
      } else if (i !== nstrings - 1) {
        throw assertionError();
      }
    }
    strings.push(accstrg);
  }
  return strings;
}

/**
 * xlrd.book.open_workbook_xls.
 * @param {Buffer} contents
 * @param {object} o {encodingOverride, onDemand, log}
 * @returns {Book}
 * @throws {Error} pyName xlrd.biffh.XLRDError for an unknown or unsupported BIFF version and the errors of reading
 *   the globals and (unless on demand) the worksheets
 */
function openWorkbookXls(contents, o) {
  const bk = new Book(o.log, o.encodingOverride);
  let onDemand = o.onDemand;
  bk.biff28Load(contents);
  const biffVersion = bk.getbof(R.WORKBOOK_GLOBALS);
  if (!biffVersion) throw xlrdError("Can't determine file's BIFF version");
  if (!SUPPORTED_VERSIONS.includes(biffVersion)) throw xlrdError(`BIFF version ${BIFF_TEXT[biffVersion]} is not supported`);
  bk.biffVersion = biffVersion;
  const onDemandWarning = '*** WARNING: on_demand is not supported for this Excel version.\n*** Setting on_demand to False.\n';
  if (biffVersion <= 40) {
    if (onDemand) {
      bk.log(onDemandWarning);
      onDemand = false;
    }
    bk.fakeGlobalsGetSheet();
  } else if (biffVersion === 45) {
    bk.parseGlobals();
    if (onDemand) {
      bk.log(onDemandWarning);
      onDemand = false;
    }
  } else {
    bk.parseGlobals();
    bk.sheetList = bk.sheetNames.map(() => null);
    if (!onDemand) bk.getSheets();
  }
  bk.nsheets = bk.sheetList.length;
  if (biffVersion === 45 && bk.nsheets > 1) {
    bk.log(`*** WARNING: Excel 4.0 workbook (.XLW) file contains ${bk.nsheets} worksheets.\n`
      + '*** Book-level data will be that of the last worksheet.\n');
  }
  if (!onDemand) bk.releaseResources();
  return bk;
}

/**
 * xlrd.open_workbook's format check: only OLE2 or raw BIFF content is read as XLS.
 * @param {Buffer} contents file bytes
 * @returns {string|null}
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

/**
 * xlrd.open_workbook(file_contents=...).
 * @param {Buffer} contents
 * @param {object} o {encodingOverride, onDemand, log}
 * @returns {Book}
 * @throws {Error} pyName TypeError for empty contents (xlrd then opens the path None), xlrd.biffh.XLRDError for
 *   ZIP based formats, and openWorkbookXls()'s errors
 */
function openWorkbook(contents, o) {
  if (!contents.length) throw pyError('TypeError', 'expected str, bytes or os.PathLike object, not NoneType');
  const fmt = inspectFormat(contents);
  if (fmt && fmt !== 'xls') throw xlrdError(`${FORMAT_DESCRIPTIONS[fmt]}; not supported`);
  return openWorkbookXls(contents, o);
}

/**
 * in2csv --names: xlrd.open_workbook(file_contents=...).sheet_names(), every sheet loaded as xlrd loads them
 * without on_demand.
 * @param {Buffer} contents file bytes
 * @param {function(string): void} log xlrd's logfile
 * @returns {string[]}
 * @throws {Error} the errors of openWorkbook()
 */
function xlsSheetNames(contents, log) {
  const book = openWorkbook(contents, { encodingOverride: null, onDemand: false, log });
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
    book = openWorkbook(contents, { encodingOverride: o.encodingOverride, onDemand: true, log: o.log });
  } catch (e) {
    if (e.pyName !== 'xlrd.compdoc.CompDocError') throw e;
    const ole = new OleFileIO(contents);
    if (!ole.exists('Workbook')) throw pyError('OSError', 'No Workbook stream found in OLE file');
    book = openWorkbook(ole.openstream('Workbook'), { encodingOverride: null, onDemand: true, log: o.log });
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
      const cellValues = sheet.colValues(i, o.skipLines + offset);
      const cellTypes = sheet.colTypes(i, o.skipLines + offset);
      const types = new Set(cellTypes);
      types.delete(XL_CELL_EMPTY);
      const excelType = types.size > 1 ? XL_CELL_TEXT : (types.size ? [...types][0] : XL_CELL_EMPTY);
      let agateType = EXCEL_TO_AGATE_TYPE[excelType] || 'Text';
      let values;
      if (excelType === XL_CELL_BOOLEAN) {
        values = cellValues.map((v) => (v === null || v === '' ? null : Boolean(v)));
      } else if (excelType === XL_CELL_DATE) {
        values = cellValues.map((v) => normalizeDate(v, book.datemode));
        if (!values.some((v) => v instanceof PyDateTime)) agateType = 'Date';
      } else {
        values = cellValues.map((v, r) => (cellTypes[r] === XL_CELL_DATE
          ? normalizeDate(v, book.datemode) : pyValue(cellTypes[r], v)));
      }
      if (o.header) {
        const v = sheet.cellValue(o.skipLines, i);
        columnNames.push(headerName(sheet.cellType(o.skipLines, i), v) || null);
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
