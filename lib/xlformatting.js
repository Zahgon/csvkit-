'use strict';
// Port of xlrd 2.0.2's formatting module (BSD) for open_workbook(formatting_info=False), the way agate-excel uses
// xlrd: FORMAT records and the date test of their format strings, XF records in their BIFF 2.1, 3, 4, 5-7 and 8
// layouts, and the cell type each XF gives a number (number or date). FONT, EFONT, PALETTE and STYLE records only
// matter with formatting_info, so the reader skips them (STYLE only completes the XF types in BIFF 2-4W sheets).

const { unpack } = require('./pystruct');
const { XL_CELL_DATE, XL_CELL_NUMBER, XL_CELL_TEXT, R, xlrdError, unpackString, unpackUnicode } = require('./biffh');

// Format types: unknown, date, number, general, text.
const FUN = 0;
const FDT = 1;
const FNU = 2;
const FGE = 3;
const FTX = 4;

// The cell type of a number in each format type: a number formatted as text is still a number.
const CELLTY_FROM_FMTTY = {
  [FNU]: XL_CELL_NUMBER, [FUN]: XL_CELL_NUMBER, [FGE]: XL_CELL_NUMBER, [FDT]: XL_CELL_DATE, [FTX]: XL_CELL_NUMBER,
};

// formatting.fmt_code_ranges: the types of the built-in format codes.
const STD_FORMAT_CODE_TYPES = new Map();
for (const [lo, hi, ty] of [[0, 0, FGE], [1, 13, FNU], [14, 22, FDT], [27, 36, FDT], [37, 44, FNU], [45, 47, FDT],
  [48, 48, FNU], [49, 49, FTX], [50, 58, FDT], [59, 62, FNU], [67, 70, FNU], [71, 81, FDT]]) {
  for (let x = lo; x <= hi; x++) STD_FORMAT_CODE_TYPES.set(x, ty);
}

const NON_DATE_FORMATS = new Set(['0.00E+00', '##0.0E+0', 'General', 'GENERAL', 'general', '@']);

/**
 * formatting.is_date_format_string: whether a number format displays a date or time.
 * @param {string} fmt
 * @returns {boolean}
 */
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

/**
 * Book.initialise_format_info: the format and XF state, reset for every BIFF 4W worksheet.
 * @param {object} book
 * @returns {void}
 */
function initialiseFormatInfo(book) {
  book.formatMap = new Map();
  book.formatList = [];
  book.xfcount = 0;
  book.actualfmtcount = 0;
  book.xfTypeMap = new Map([[0, XL_CELL_NUMBER]]);
  book.xfEpilogueDone = false;
  book.xfList = [];
}

/**
 * formatting.handle_format: a FORMAT (or BIFF2/3 FORMAT2) record. Before BIFF5 the key is the record's ordinal.
 * @param {object} book
 * @param {Buffer} data
 * @param {number} rectype R.FORMAT or R.FORMAT2
 * @returns {void}
 * @throws {Error} the errors of Book.deriveEncoding(), struct.error, IndexError or a decoding error for a bad record
 */
function handleFormat(book, data, rectype = R.FORMAT) {
  let bv = book.biffVersion;
  if (rectype === R.FORMAT2) bv = Math.min(bv, 30);
  if (!book.encoding) book.deriveEncoding();
  let strpos = 2;
  let fmtkey;
  if (bv >= 50) {
    [fmtkey] = unpack('<H', data.subarray(0, 2));
  } else {
    fmtkey = book.actualfmtcount;
    if (bv <= 30) strpos = 0;
  }
  book.actualfmtcount += 1;
  const formatStr = bv >= 80 ? unpackUnicode(data, 2) : unpackString(data, strpos, book.encoding, 1);
  const fmt = { formatKey: fmtkey, type: isDateFormatString(formatStr) ? FDT : FGE, formatStr };
  book.formatMap.set(fmtkey, fmt);
  book.formatList.push(fmt);
}

/**
 * formatting.fill_in_standard_formats: the built-in formats a BIFF5+ workbook does not define itself.
 * @param {object} book
 * @returns {void}
 */
function fillInStandardFormats(book) {
  for (const [x, ty] of STD_FORMAT_CODE_TYPES) {
    if (!book.formatMap.has(x)) book.formatMap.set(x, { formatKey: x, type: ty, formatStr: null });
  }
}

// handle_xf's layouts of the leading XF fields by minimum BIFF version; the format key is the second field in each.
const XF_LAYOUTS = [[80, '<HHHBBBBIiH', 20], [50, '<HHHBBIi', 16], [40, '<BBHBBHI', 12], [30, '<BBBBHHI', 12]];

/**
 * formatting.handle_xf: an XF record's number format, and the cell type it gives numbers until xfEpilogue().
 * @param {object} book
 * @param {Buffer} data
 * @returns {void}
 * @throws {Error} pyName struct.error for a short record, xlrd.biffh.XLRDError for an XF record in a BIFF 2.0 file
 */
function handleXf(book, data) {
  const bv = book.biffVersion;
  if (bv >= 50 && !book.xfcount) fillInStandardFormats(book);
  let formatKey;
  const layout = XF_LAYOUTS.find(([min]) => bv >= min);
  if (layout) {
    const [, fmt, size] = layout;
    [, formatKey] = unpack(fmt, data.subarray(0, size));
  } else if (bv === 21) {
    const [, formatEtc] = unpack('<BxBB', data);
    formatKey = formatEtc & 0x3F;
  } else {
    throw xlrdError(`programmer stuff-up: bv=${bv}`);
  }
  const xf = { xfIndex: book.xfList.length, formatKey };
  book.xfList.push(xf);
  book.xfcount += 1;
  const fmt = book.formatMap.get(xf.formatKey);
  book.xfTypeMap.set(xf.xfIndex, fmt ? CELLTY_FROM_FMTTY[fmt.type] : XL_CELL_NUMBER);
  if (!book.formatMap.has(xf.formatKey)) xf.formatKey = 0;
}

/**
 * formatting.xf_epilogue: every XF's cell type from its number format; an XF whose format is unknown gives text.
 * @param {object} book
 * @returns {void}
 */
function xfEpilogue(book) {
  book.xfEpilogueDone = true;
  for (const xf of book.xfList) {
    const fmt = book.formatMap.get(xf.formatKey);
    book.xfTypeMap.set(xf.xfIndex, fmt ? CELLTY_FROM_FMTTY[fmt.type] : XL_CELL_TEXT);
  }
}

module.exports = { FUN, CELLTY_FROM_FMTTY, initialiseFormatInfo, handleFormat, handleXf, xfEpilogue };
