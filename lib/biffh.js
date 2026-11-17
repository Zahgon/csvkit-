'use strict';
// Port of xlrd 2.0.2's biffh module (BSD) as far as the XLS reader uses it: the BIFF record codes, cell types,
// the string unpacking helpers with the errors Python raises on short records, and the hex dump xlrd writes to its
// log file for a corrupt OBJ record.

const { pyError } = require('./pyerrors');
const { unpack, byteAt } = require('./pystruct');
const codecs = require('./codecs');

const XL_CELL_EMPTY = 0;
const XL_CELL_TEXT = 1;
const XL_CELL_NUMBER = 2;
const XL_CELL_DATE = 3;
const XL_CELL_BOOLEAN = 4;
const XL_CELL_ERROR = 5;

/** Record codes and stream types, as biffh names them. */
const R = {
  WORKBOOK_GLOBALS: 0x5, WORKBOOK_GLOBALS_4W: 0x100, WORKSHEET: 0x10, BOUNDSHEET_WORKSHEET: 0x00, ARRAY: 0x0221,
  ARRAY2: 0x0021, BOOLERR: 0x205, BOOLERR_B2: 0x5, BOUNDSHEET: 0x85, BUILTINFMTCOUNT: 0x56, CODEPAGE: 0x42,
  CONTINUE: 0x3c, COUNTRY: 0x8C, DATEMODE: 0x22, DEFAULTROWHEIGHT: 0x0225, DEFCOLWIDTH: 0x55, DIMENSION: 0x200,
  DIMENSION2: 0x0, EOF: 0x0a, EXTERNNAME: 0x23, EXTERNSHEET: 0x17, FILEPASS: 0x2f, FORMAT: 0x41e, FORMAT2: 0x1E,
  HLINK: 0x01B8, QUICKTIP: 0x0800, INTEGER: 0x2, IXFE: 0x44, LABEL: 0x204, LABEL_B2: 0x04, LABELRANGES: 0x15f,
  LABELSST: 0xfd, MULRK: 0xbd, NAME: 0x18, NOTE: 0x1c, NUMBER: 0x203, NUMBER_B2: 0x3, OBJ: 0x5D, PANE: 0x41,
  RK: 0x27e, RSTRING: 0xd6, SCL: 0x00A0, SHEETHDR: 0x8F, SHEETSOFFSET: 0x8E, SHRFMLA: 0x04bc, SST: 0xfc,
  STANDARDWIDTH: 0x99, STRING: 0x207, STRING_B2: 0x7, STYLE: 0x293, SUPBOOK: 0x1AE, TABLEOP: 0x236, TABLEOP2: 0x37,
  TABLEOP_B2: 0x36, TXO: 0x1b6, WINDOW2: 0x023E, WINDOW2_B2: 0x003E, WRITEACCESS: 0x5C, XF: 0xe0, XF2: 0x0043,
  XF3: 0x0243, XF4: 0x0443,
};

const BOFLEN = new Map([[0x0809, 8], [0x0409, 6], [0x0209, 6], [0x0009, 4]]);
const FORMULA_OPCODES = [0x0006, 0x0406, 0x0206];
const BIFF_FIRST_UNICODE = 80;
const BIFF_TEXT = {
  0: '(not BIFF)', 20: '2.0', 21: '2.1', 30: '3', 40: '4S', 45: '4W', 50: '5', 70: '7', 80: '8', 85: '8X',
};

/**
 * An xlrd.biffh.XLRDError.
 * @param {string} message
 * @returns {Error}
 */
function xlrdError(message) {
  return pyError('xlrd.biffh.XLRDError', message);
}

/**
 * The AssertionError of a failed assert statement without a message.
 * @returns {Error}
 */
function assertionError() {
  return pyError('AssertionError', '');
}

/**
 * The string length at pos, a byte (lenlen 1) or a uint16 (lenlen 2).
 * @param {Buffer} data
 * @param {number} pos
 * @param {number} lenlen
 * @returns {number}
 * @throws {Error} pyName struct.error when the record ends first
 */
function unpackLength(data, pos, lenlen) {
  return unpack(lenlen === 1 ? '<B' : '<H', data.subarray(pos, pos + lenlen))[0];
}

/**
 * biffh.unpack_string: a counted 8-bit string in the given encoding.
 * @param {Buffer} data
 * @param {number} pos
 * @param {string} encoding
 * @param {number} lenlen
 * @returns {string}
 * @throws {Error} pyName struct.error for a missing length, LookupError or UnicodeDecodeError from the codec
 */
function unpackString(data, pos, encoding, lenlen = 1) {
  const nchars = unpackLength(data, pos, lenlen);
  pos += lenlen;
  return codecs.decode(data.subarray(pos, pos + nchars), encoding);
}

/**
 * biffh.unpack_string_update_pos.
 * @param {Buffer} data
 * @param {number} pos
 * @param {string} encoding
 * @param {number} lenlen
 * @param {number|null} knownLen the length when the record keeps it elsewhere (NAME)
 * @returns {Array} [string, position after it]
 * @throws {Error} as unpackString()
 */
function unpackStringUpdatePos(data, pos, encoding, lenlen = 1, knownLen = null) {
  let nchars;
  if (knownLen !== null) {
    nchars = knownLen;
  } else {
    nchars = unpackLength(data, pos, lenlen);
    pos += lenlen;
  }
  const newpos = pos + nchars;
  return [codecs.decode(data.subarray(pos, newpos), encoding), newpos];
}

/**
 * biffh.unpack_unicode: a BIFF8 string (options byte, then compressed latin-1 or UTF-16LE characters).
 * @param {Buffer} data
 * @param {number} pos
 * @param {number} lenlen
 * @returns {string}
 * @throws {Error} pyName struct.error for a missing length, IndexError for a missing options byte,
 *   UnicodeDecodeError for bad UTF-16
 */
function unpackUnicode(data, pos, lenlen = 2) {
  const nchars = unpackLength(data, pos, lenlen);
  if (!nchars) return '';
  pos += lenlen;
  const options = byteAt(data, pos);
  pos += 1;
  if (options & 0x08) pos += 2;
  if (options & 0x04) pos += 4;
  if (options & 0x01) return codecs.decode(data.subarray(pos, pos + 2 * nchars), 'utf_16_le');
  return codecs.decode(data.subarray(pos, pos + nchars), 'latin_1');
}

/**
 * biffh.unpack_unicode_update_pos.
 * @param {Buffer} data
 * @param {number} pos
 * @param {number} lenlen
 * @param {number|null} knownLen the length when the record keeps it elsewhere (NAME, TXO)
 * @returns {Array} [string, position after it and its rich-text and phonetic data]
 * @throws {Error} as unpackUnicode(), and struct.error for truncated rich-text or phonetic sizes
 */
function unpackUnicodeUpdatePos(data, pos, lenlen = 2, knownLen = null) {
  let nchars;
  if (knownLen !== null) {
    nchars = knownLen;
  } else {
    nchars = unpackLength(data, pos, lenlen);
    pos += lenlen;
  }
  if (!nchars && !data.subarray(pos).length) return ['', pos];
  const options = byteAt(data, pos);
  pos += 1;
  const phonetic = options & 0x04;
  const richtext = options & 0x08;
  let rt = 0;
  let sz = 0;
  if (richtext) {
    [rt] = unpack('<H', data.subarray(pos, pos + 2));
    pos += 2;
  }
  if (phonetic) {
    [sz] = unpack('<i', data.subarray(pos, pos + 4));
    pos += 4;
  }
  let strg;
  if (options & 0x01) {
    strg = codecs.decode(data.subarray(pos, pos + 2 * nchars), 'utf_16_le');
    pos += 2 * nchars;
  } else {
    strg = codecs.decode(data.subarray(pos, pos + nchars), 'latin_1');
    pos += nchars;
  }
  if (richtext) pos += 4 * rt;
  if (phonetic) pos += sz;
  return [strg, pos];
}

/**
 * biffh.unpack_cell_range_address_list_update_pos: a count and that many cell ranges.
 * @param {Array} outputList receives [rlo, rhi, clo, chi] per range
 * @param {Buffer} data
 * @param {number} pos
 * @param {number} addrSize 6 (byte columns) or 8
 * @returns {number} the position after the list
 * @throws {Error} pyName struct.error for a truncated list
 */
function unpackCellRangeAddressListUpdatePos(outputList, data, pos, addrSize = 6) {
  const [n] = unpack('<H', data.subarray(pos, pos + 2));
  pos += 2;
  const fmt = addrSize === 6 ? '<HHBB' : '<HHHH';
  for (let k = 0; k < n; k++) {
    const [ra, rb, ca, cb] = unpack(fmt, data.subarray(pos, pos + addrSize));
    outputList.push([ra, rb + 1, ca, cb + 1]);
    pos += addrSize;
  }
  return pos;
}

/**
 * biffh.hex_char_dump: hex and printable characters, 16 bytes a line, numbered from 0.
 * @param {Buffer} strg
 * @param {number} ofs
 * @param {number} dlen
 * @param {function(string): void} log
 * @returns {void}
 */
function hexCharDump(strg, ofs, dlen, log) {
  const endpos = Math.min(ofs + dlen, strg.length);
  let pos = ofs;
  while (pos < endpos) {
    const endsub = Math.min(pos + 16, endpos);
    const sub = strg.subarray(pos, endsub);
    const hexd = [...sub].map((c) => `${c.toString(16).padStart(2, '0')} `).join('');
    const printable = (c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '?');
    const chard = [...sub].map((c) => (c === 0 ? '~' : printable(c))).join('');
    log(`${String(pos - ofs).padStart(5)}:      ${hexd.padEnd(48)} ${chard}\n`);
    pos = endsub;
  }
}

module.exports = {
  XL_CELL_EMPTY, XL_CELL_TEXT, XL_CELL_NUMBER, XL_CELL_DATE, XL_CELL_BOOLEAN, XL_CELL_ERROR,
  R, BOFLEN, FORMULA_OPCODES, BIFF_FIRST_UNICODE, BIFF_TEXT, xlrdError, assertionError, unpackString,
  unpackStringUpdatePos, unpackUnicode, unpackUnicodeUpdatePos, unpackCellRangeAddressListUpdatePos, hexCharDump,
};
