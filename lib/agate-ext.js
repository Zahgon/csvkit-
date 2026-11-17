'use strict';
// The agate extensions in2csv loads: agate-excel's Table.from_xls and Table.from_xlsx (agateexcel/table_xls.py,
// table_xlsx.py) and agate-dbf's Table.from_dbf (agatedbf/table.py), over lib/xls, lib/xlsx and lib/dbf.

const { Table, TypeTester } = require('./table');
const T = require('./types');
const { SITE_PACKAGES } = require('./warnings');

// Where each extension builds the table, for the location of agate's "Column names not specified" warning.
const TABLE_CALLS = {
  xls: [`${SITE_PACKAGES}/agateexcel/table_xls.py`, 135,
    '  tables[sheet.name] = agate.Table(rows, column_names, column_types, **kwargs)'],
  xlsx: [`${SITE_PACKAGES}/agateexcel/table_xlsx.py`, 122, '  tables[sheet.title] = agate.Table(rows, column_names, **kwargs)'],
  dbf: [`${SITE_PACKAGES}/agatedbf/table.py`, 22, '  table = agate.Table(dbf.records, column_names=dbf.field_names)'],
};

// agate-excel's own column types, used for the sheets after the first one read in a single call.
const AGATE_TYPES = {
  Boolean: T.BooleanType, Number: T.NumberType, Text: T.TextType, Date: T.DateType, DateTime: T.DateTimeType,
  TimeDelta: T.TimeDeltaType,
};

/**
 * The sheet names of an XLS or XLSX workbook.
 * @param {Buffer} buf the workbook
 * @param {'xls'|'xlsx'} filetype
 * @param {function(string): void} log xlrd's log file (XLS only)
 * @returns {string[]}
 * @throws {Error} the errors xlsSheetNames() and xlsxSheetNames() raise
 */
function excelSheetNames(buf, filetype, log) {
  if (filetype === 'xls') return require('./xls').xlsSheetNames(buf, log);
  return require('./xlsx').xlsxSheetNames(buf);
}

/**
 * agate.Table.from_xls / from_xlsx for a list of sheets.
 * @param {Buffer} buf the workbook
 * @param {'xls'|'xlsx'} filetype
 * @param {object} opts
 * @param {Array<string|number|null>} opts.sheets sheet names or indices; null for the first (xls) or active (xlsx)
 *   sheet
 * @param {number} opts.skipLines rows to skip at the top of each sheet
 * @param {boolean} opts.header whether the first row holds the column names
 * @param {TypeTester|null} opts.columnTypes the types for the first sheet read
 * @param {string|null} [opts.encodingOverride] xlrd's encoding_override (XLS only)
 * @param {function(string): void} [opts.log] xlrd's log file (XLS only)
 * @param {boolean|null} [opts.resetDimensions] ignore the sheet dimensions the file gives (XLSX only)
 * @returns {Map<string, Table>} the tables by sheet name
 * @throws {Error} the errors readXls() and readXlsx() raise, and the casts' CastError
 */
function fromExcel(buf, filetype, { sheets, skipLines, header, columnTypes, encodingOverride, log, resetDimensions }) {
  const opts = { sheets, skipLines, header };
  let parts;
  if (filetype === 'xls') parts = require('./xls').readXls(buf, { ...opts, encodingOverride, log });
  else parts = require('./xlsx').readXlsx(buf, { ...opts, resetDimensions });
  const tables = new Map();
  for (const part of parts) {
    const types = part.columnTypes ? part.columnTypes.map((n) => new AGATE_TYPES[n]({})) : columnTypes;
    tables.set(part.title, new Table(part.rows, part.columnNames, types, { caller: TABLE_CALLS[filetype] }));
  }
  return tables;
}

/**
 * agate.Table.from_dbf, with agate's default type inference.
 * @param {string} filename the DBF file ("<stdin>" for standard input, which dbfread looks up as a file name)
 * @returns {Table}
 * @throws {Error} the errors readDbf() raises, and the casts' CastError
 */
function fromDbf(filename) {
  const d = require('./dbf').readDbf(filename);
  const o = {};
  const types = new TypeTester([new T.BooleanType(o), new T.NumberType(o), new T.TimeDeltaType(o),
    new T.DateType(o), new T.DateTimeType(o), new T.TextType(o)]);
  return new Table(d.rows, d.fields, types, { caller: TABLE_CALLS.dbf });
}

module.exports = { excelSheetNames, fromExcel, fromDbf };
