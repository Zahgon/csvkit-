'use strict';
// Port of agate.table.print_table (agate 1.14.2, MIT) with agate.utils.make_number_formatter and the agate.config
// options it reads.

const { formatDecimal } = require('./babel-format');
const { defaultLocale } = require('./babel');
const { maxPrecision } = require('./table');
const T = require('./types');
const pycsv = require('./pycsv');

const ELLIPSIS = '...';
const TRUNCATION = '...';
const H_LINE = '-';
const V_LINE = '|';

/** agate.utils.make_number_formatter: a Babel pattern showing `places` decimal places. */
function makeNumberFormatter(places, ellipsis) {
  const fraction = '0'.repeat(Math.max(0, places));
  return `#,##0.${fraction}${ellipsis};-#,##0.${fraction}${ellipsis}`;
}

const length = (s) => [...s].length;

// Python's seq[:n], including a negative n.
function head(seq, n) {
  return seq.slice(0, n < 0 ? Math.max(0, seq.length + n) : n);
}

const truncate = (s, width) => head([...s], width - TRUNCATION.length).join('') + TRUNCATION;

function displayValue(v) {
  return (v instanceof T.PyDateTime ? v.pyStr(' ') : pycsv.pyStr(v)).replace(/\n/g, '↵');
}

/**
 * Table.print_table: writes a GitHub Flavored Markdown view of the table.
 * @param {import('./table').Table} table
 * @param {{write(s: string): void}} output
 * @param {object} [opts]
 * @param {number|null} [opts.maxRows] null shows every row
 * @param {number|null} [opts.maxColumns] null shows every column
 * @param {number|null} [opts.maxColumnWidth] null disables truncation
 * @param {number|null} [opts.maxPrecision] null shows every decimal place
 * @param {string} [opts.locale] defaults to the environment's LC_NUMERIC locale, else en_US
 * @param {string} [opts.numberTruncation] the number_truncation_chars option
 */
function printTable(table, output, {
  maxRows = 20, maxColumns = 6, maxColumnWidth = 20, maxPrecision: maxPrec = 3,
  locale = null, numberTruncation = '…',
} = {}) {
  const rows = table.rows;
  if (maxRows === null) maxRows = rows.length;
  if (maxColumns === null) maxColumns = table.columnNames.length;
  if (maxPrec === null) maxPrec = Infinity;
  const numberLocale = locale || defaultLocale('LC_NUMERIC') || 'en_US';

  const rowsTruncated = maxRows < rows.length;
  const columnsTruncated = maxColumns < table.columnNames.length;
  const columnNames = head(table.columnNames, maxColumns).map((name) => (
    maxColumnWidth !== null && length(name) > maxColumnWidth ? truncate(name, maxColumnWidth) : name));
  if (columnsTruncated) columnNames.push(ELLIPSIS);

  const widths = columnNames.map(length);
  const numberFormatters = [];
  for (const [i, type] of table.columnTypes.entries()) {
    if (i >= maxColumns) break;
    if (type instanceof T.NumberType) {
      let places = maxPrecision(head(rows, maxRows).map((r) => r[i]));
      let addEllipsis = false;
      if (places > maxPrec) {
        addEllipsis = true;
        places = maxPrec;
      }
      numberFormatters.push(makeNumberFormatter(places, addEllipsis ? numberTruncation : ''));
    } else numberFormatters.push(null);
  }

  const formattedData = [];
  for (const [i, row] of rows.entries()) {
    if (i >= maxRows) break;
    const formattedRow = [];
    for (let j = 0; j < row.length; j++) {
      let v = row[j];
      if (j >= maxColumns) v = ELLIPSIS;
      else if (v === null) v = '';
      else if (numberFormatters[j] !== null && Math.abs(v.toNumber()) !== Infinity) {
        v = formatDecimal(v, numberFormatters[j], numberLocale);
      } else v = displayValue(v);
      if (maxColumnWidth !== null && length(v) > maxColumnWidth) v = truncate(v, maxColumnWidth);
      if (length(v) > widths[j]) widths[j] = length(v);
      formattedRow.push(v);
      if (j >= maxColumns) break;
    }
    formattedData.push(formattedRow);
  }

  const writeRow = (formattedRow) => {
    const cells = formattedRow.map((d, j) => {
      const pad = ' '.repeat(Math.max(0, widths[j] - length(d)));
      return table.columnTypes[j] instanceof T.TextType ? ` ${d}${pad} ` : ` ${pad}${d} `;
    });
    output.write(`${V_LINE}${cells.join(V_LINE)}${V_LINE}\n`);
  };
  writeRow(columnNames);
  output.write(`${V_LINE} ${widths.map((w) => H_LINE.repeat(w)).join(' | ')} ${V_LINE}\n`);
  for (const formattedRow of formattedData) writeRow(formattedRow);
  if (rowsTruncated) writeRow(columnNames.map(() => ELLIPSIS));
}

module.exports = { printTable };
