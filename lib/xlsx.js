'use strict';
// Port of openpyxl 3.1.5's read-only reading path (reader.excel, reader.workbook, reader.strings,
// styles.stylesheet number formats, worksheet._reader, worksheet._read_only) with load_workbook(read_only=True,
// data_only=True), and of agate-excel 0.4.3 table_xlsx.from_xlsx (both MIT).

const path = require('node:path').posix;
const { pyError } = require('./pyerrors');
const { ZipFile } = require('./zipfile');
const xml = require('./xmltree');
const { SITE_PACKAGES, warn } = require('./warnings');
const { pyRepr } = require('./pystr');
const { intLiteral, strToFloat } = require('./pyunicode');
const { PyFloat } = require('./pyjson');
const { PyDate, PyDateTime } = require('./types');
const { PyTime, fromExcel, fromISO8601, addToEpoch, WINDOWS_EPOCH, MAC_EPOCH } = require('./xldate');
const { pyStr } = require('./pycsv');

const MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}';
const REL_NS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}';
const PKG_REL = '{http://schemas.openxmlformats.org/package/2006/relationships}';
const CT_NS = '{http://schemas.openxmlformats.org/package/2006/content-types}';
const SPREADSHEET = (t) => `application/vnd.openxmlformats-officedocument.spreadsheetml.${t}+xml`;
const WORKBOOK_TYPES = [
  'application/vnd.ms-excel.template.macroEnabled.main+xml',
  SPREADSHEET('template.main'),
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  SPREADSHEET('sheet.main'),
];

const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)', 7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm',
  17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm',
  37: '#,##0_);(#,##0)', 38: '#,##0_);[Red](#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_)_("$"* \\(#,##0.00\\)_("$"* "-"??_)_(@_)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0',
  48: '##0.0E+0', 49: '@',
};
const BUILTIN_FORMATS_REVERSE = new Map(Object.entries(BUILTIN_FORMATS).map(([k, v]) => [v, Number(k)]));
const BUILTIN_FORMATS_MAX_SIZE = 164;

const STRIP_RE = /".*?"|\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/g;
const TIMEDELTA_RE = /\[hh?\](:mm(:ss(\.0*)?)?)?|\[mm?\](:ss(\.0*)?)?|\[ss?\](\.0*)?/i;

const EXT_TYPES = {
  '{78C0D931-6437-407D-A8EE-F0AAD7539E65}': 'Conditional Formatting',
  '{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}': 'Data Validation',
  '{05C60535-1F16-4FD2-B633-F4F36F0B64E0}': 'Sparkline Group',
  '{A8765BA9-456A-4DAB-B4F3-ACF838C121DE}': 'Slicer List',
  '{FC87AEE6-9EDD-4A0A-B7FB-166176984837}': 'Protected Range',
  '{01252117-D84E-4E92-8308-4BE1C098FCBB}': 'Ignored Error',
  '{F7C9EE02-42E1-4005-9D12-6889AFFD525C}': 'Web Extension',
  '{3A4CF648-6AED-40F4-86FF-DC5316D8AED3}': 'Slicer List',
  '{7E03D99C-DC04-49D9-9315-930204A7B6E9}': 'Timeline Ref',
};

/** openpyxl.styles.numbers.is_date_format */
function isDateFormat(fmt) {
  if (fmt === null || fmt === undefined) return false;
  const first = fmt.split(';')[0].replace(STRIP_RE, '');
  return /(?<![_\\])[dmhysDMHYS]/.test(first);
}

/** openpyxl.styles.numbers.is_timedelta_format */
function isTimedeltaFormat(fmt) {
  if (fmt === null || fmt === undefined) return false;
  return TIMEDELTA_RE.test(fmt.split(';')[0]);
}

/** int() of a decimal string as a bigint, raising Python's ValueError. */
function pyIntStr(s) {
  const t = intLiteral(s);
  if (t === null) throw pyError('ValueError', `invalid literal for int() with base 10: ${pyRepr(s)}`);
  return BigInt(t);
}

/** worksheet._reader._cast_number: an int ({pyInt}) or a float (PyFloat). */
function castNumber(value) {
  if (value.includes('.') || value.includes('E') || value.includes('e')) return new PyFloat(strToFloat(value));
  return { pyInt: pyIntStr(value) };
}

/** cell.text.Text.content: plain text followed by the text of each rich-text run. */
function textContent(node) {
  let plain = null;
  const runs = [];
  for (const c of node.children) {
    if (c.tag === `${MAIN}t`) plain = c.text;
    else if (c.tag === `${MAIN}r`) {
      let t = null;
      for (const rc of c.children) if (rc.tag === `${MAIN}t`) t = rc.text;
      if (t !== null) runs.push(t);
    }
  }
  return (plain === null ? '' : plain) + runs.join('');
}

/** utils.cell.column_index_from_string */
function columnIndexFromString(col) {
  const msg = `'${col}' is not a valid column name. Column names are from A to ZZZ`;
  if ([...col].length > 3) throw pyError('ValueError', msg);
  let idx = 0;
  for (const ch of col.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') throw pyError('ValueError', msg);
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  if (!(idx > 0 && idx < 18279)) throw pyError('ValueError', msg);
  return idx;
}

/** utils.cell.coordinate_to_tuple: "B3" to [3, 2]; the row is everything from the first digit on. */
function coordinateToTuple(coord) {
  const chars = [...coord];
  let idx = chars.findIndex((c) => c >= '0' && c <= '9');
  if (idx < 0) idx = chars.length - 1;
  const row = Number(pyIntStr(chars.slice(idx).join('')));
  return [row, columnIndexFromString(chars.slice(0, idx).join(''))];
}

/** utils.cell.range_boundaries: [min_col, min_row, max_col, max_row]. */
function rangeBoundaries(ref) {
  const msg = `${ref} is not a valid coordinate or range`;
  const m = /^[$]?([A-Za-z]{1,3})?[$]?(\d+)?(:[$]?([A-Za-z]{1,3})?[$]?(\d+)?)?$/.exec(ref);
  if (!m) throw pyError('ValueError', msg);
  const [, minCol, minRow, sep, maxCol, maxRow] = m;
  if (sep) {
    const cols = [minCol, maxCol];
    const rows = [minRow, maxRow];
    const all = (a) => a.every((x) => x);
    const any = (a) => a.some((x) => x);
    if (!(all([...cols, ...rows]) || (all(cols) && !any(rows)) || (all(rows) && !any(cols)))) throw pyError('ValueError', msg);
  }
  const c1 = minCol ? columnIndexFromString(minCol) : null;
  const r1 = minRow ? parseInt(minRow, 10) : null;
  const c2 = maxCol ? columnIndexFromString(maxCol) : c1;
  const r2 = maxRow ? parseInt(maxRow, 10) : r1;
  return [c1, r1, c2, r2];
}

/** packaging.relationship.get_dependents: relationship targets made absolute inside the archive. */
function getDependents(archive, filename) {
  const root = xml.parse(archive.read(filename));
  const parent = path.dirname(path.dirname(filename));
  const rels = new Map();
  for (const r of root.findall(`${PKG_REL}Relationship`)) {
    let target = r.get('Target');
    if (r.get('TargetMode') !== 'External' && target !== null) {
      target = target.startsWith('/') ? target.slice(1) : path.normalize(path.join(parent, target));
    }
    rels.set(r.get('Id'), { target, type: r.get('Type') });
  }
  return rels;
}

function getRelsPath(p) {
  return path.join(path.dirname(p), '_rels', `${path.basename(p)}.rels`);
}

/** openpyxl.cell.read_only.ReadOnlyCell: a cell's position, value, data type and style index. */
class ReadOnlyCell {
  /**
   * @param {ReadOnlyWorksheet} sheet
   * @param {{row: number, column: number, value: *, dataType: string, styleId: number}} cell what the worksheet
   *   parser read
   */
  constructor(sheet, { row, column, value, dataType, styleId }) {
    Object.assign(this, { sheet, row, column, value, dataType, styleId });
  }

  /** ReadOnlyCell.number_format through the workbook's cell styles. */
  get numberFormat() {
    const wb = this.sheet.parent;
    if (this.styleId >= wb.cellStyles.length) throw pyError('IndexError', 'list index out of range');
    const id = wb.cellStyles[this.styleId];
    if (id < BUILTIN_FORMATS_MAX_SIZE) return BUILTIN_FORMATS[id] !== undefined ? BUILTIN_FORMATS[id] : 'General';
    return wb.numberFormats[id - BUILTIN_FORMATS_MAX_SIZE];
  }
}

const EMPTY_CELL = { value: null, numberFormat: null, empty: true };

/** openpyxl.worksheet._reader.WorkSheetParser: the rows of a worksheet part, cell by cell. */
class WorkSheetParser {
  /**
   * @param {object} source the parsed worksheet XML
   * @param {string[]} sharedStrings the workbook's shared strings
   * @param {Workbook} wb the workbook, for its styles and date epoch
   */
  constructor(source, sharedStrings, wb) {
    this.source = source;
    this.sharedStrings = sharedStrings;
    this.wb = wb;
    this.rowCounter = 0;
    this.colCounter = 0;
  }

  /** Rows as [index, cells] in document order, with the side effects of the elements seen on the way. */
  *parse() {
    for (const el of this.source.iterEnd()) {
      if (el.tag === `${MAIN}extLst`) this.parseExtensions(el);
      else if (el.tag === `${MAIN}row`) yield this.parseRow(el);
    }
  }

  /**
   * WorkSheetParser.parse_extensions: openpyxl's UserWarning for each extension it drops.
   * @param {object} el the extLst element
   * @returns {void}
   */
  parseExtensions(el) {
    for (const e of el.findall(`${MAIN}ext`)) {
      const uri = (e.get('uri') || '').toUpperCase();
      const type = EXT_TYPES[uri] || 'Unknown';
      warn(`${SITE_PACKAGES}/openpyxl/worksheet/_reader.py`, 329, 'UserWarning',
        `${type} extension is not supported and will be removed`, '  warn(msg)');
    }
  }

  /**
   * WorkSheetParser.parse_row.
   * @param {object} row the row element
   * @returns {Array} [row index, cells]
   * @throws {Error} pyName ValueError for an r attribute that is not a whole number
   */
  parseRow(row) {
    const r = row.get('r');
    if (r !== null) {
      if (/^\s*[+-]?\d+\s*$/.test(r)) this.rowCounter = parseInt(r, 10);
      else {
        const v = strToFloat(r);
        if (Number.isInteger(v)) this.rowCounter = v;
        else throw pyError('ValueError', `${r} is not a valid row number`);
      }
    } else {
      this.rowCounter += 1;
    }
    this.colCounter = 0;
    return [this.rowCounter, row.children.map((c) => this.parseCell(c))];
  }

  /**
   * WorkSheetParser.parse_cell: the cell's value by its data type and number format (dates through from_excel).
   * @param {object} element the c element
   * @returns {{row: number, column: number, value: *, dataType: string, styleId: number}}
   * @throws {Error} pyName ValueError, IndexError or TypeError where openpyxl fails on a malformed cell
   */
  parseCell(element) {
    let dataType = element.get('t', 'n');
    const coordinate = element.get('r');
    let styleId = element.get('s', 0);
    if (styleId) styleId = Number(pyIntStr(styleId));
    let value;
    if (dataType === 'inlineStr') value = null;
    else value = element.findtext(`${MAIN}v`, null) || null;
    let row;
    let column;
    if (coordinate) {
      [row, column] = coordinateToTuple(coordinate);
      this.colCounter = column;
    } else {
      this.colCounter += 1;
      [row, column] = [this.rowCounter, this.colCounter];
    }
    if (value !== null) {
      if (dataType === 'n') {
        value = castNumber(value);
        if (this.wb.dateFormats.has(styleId)) {
          dataType = 'd';
          const num = value.isPyFloat ? value.value : Number(value.pyInt);
          try {
            value = fromExcel(num, this.wb.epoch, this.wb.timedeltaFormats.has(styleId));
          } catch (e) {
            if (e.pyName !== 'OverflowError' && e.pyName !== 'ValueError') throw e;
            const shown = value.isPyFloat ? value.pyStr() : String(value.pyInt);
            warn(`${SITE_PACKAGES}/openpyxl/worksheet/_reader.py`, 223, 'UserWarning',
              `Cell ${coordinate} is marked as a date but the serial value ${shown} is outside the limits for dates. `
              + 'The cell will be treated as an error.',
              '  warn(msg)');
            dataType = 'e';
            value = '#VALUE!';
          }
        }
      } else if (dataType === 's') {
        const i = Number(pyIntStr(value));
        const n = this.sharedStrings.length;
        if (i >= n || i < -n) throw pyError('IndexError', 'list index out of range');
        value = this.sharedStrings[i < 0 ? i + n : i];
      } else if (dataType === 'b') {
        value = pyIntStr(value) !== 0n;
      } else if (dataType === 'str') {
        dataType = 's';
      } else if (dataType === 'd') {
        value = fromISO8601(value);
      }
    } else if (dataType === 'inlineStr') {
      const child = element.find(`${MAIN}is`);
      if (child) {
        dataType = 's';
        value = textContent(child);
      }
    }
    return { row, column, value, dataType, styleId };
  }
}

/**
 * openpyxl.worksheet._read_only.ReadOnlyWorksheet: a worksheet streamed from its XML part, with the dimensions the
 * part declares.
 */
class ReadOnlyWorksheet {
  /**
   * @param {Workbook} wb
   * @param {string} title the sheet name
   * @param {string} worksheetPath the worksheet part in the package
   * @throws {Error} pyName TypeError for a dimension element without ref, ValueError for a malformed ref
   */
  constructor(wb, title, worksheetPath) {
    this.parent = wb;
    this.title = title;
    this.worksheetPath = worksheetPath;
    this.minColumn = 1;
    this.minRow = 1;
    this.maxColumn = null;
    this.maxRow = null;
    const dims = this.parseDimensions();
    if (dims) [this.minColumn, this.minRow, this.maxColumn, this.maxRow] = dims;
  }

  /**
   * @returns {object} the worksheet XML, parsed afresh as openpyxl reads it on each pass
   * @throws {Error} pyName KeyError for a missing part, xml.etree.ElementTree.ParseError for invalid XML
   */
  source() {
    return xml.parse(this.parent.archive.read(this.worksheetPath));
  }

  /**
   * ReadOnlyWorksheet._get_size from the dimension element before sheetData.
   * @returns {number[]|null} [min column, min row, max column, max row], or null without one
   * @throws {Error} pyName TypeError for a dimension without ref, ValueError for a malformed ref
   */
  parseDimensions() {
    for (const el of this.source().iterEnd()) {
      if (el.tag === `${MAIN}dimension`) {
        const ref = el.get('ref');
        if (ref === null) throw pyError('TypeError', "SheetDimension.__init__() missing 1 required positional argument: 'ref'");
        return rangeBoundaries(ref);
      }
      if (el.tag === `${MAIN}sheetData`) break;
    }
    return null;
  }

  /**
   * Worksheet.iter_rows on a read-only sheet: rows of cells, missing rows and cells filled with empty cells.
   * @param {number|null} [minRow]
   * @param {number|null} [maxRow]
   * @param {number|null} [minCol]
   * @param {number|null} [maxCol]
   * @returns {Generator<Array>}
   * @throws {Error} as WorkSheetParser
   */
  *iterRows(minRow = null, maxRow = null, minCol = null, maxCol = null) {
    minCol = minCol || 1;
    minRow = minRow || 1;
    maxCol = maxCol || this.maxColumn;
    maxRow = maxRow || this.maxRow;
    const emptyRow = maxCol !== null ? new Array(maxCol + 1 - minCol).fill(EMPTY_CELL) : [];
    let counter = minRow;
    let idx = 1;
    const parser = new WorkSheetParser(this.source(), this.parent.sharedStrings, this.parent);
    for (const [i, row] of parser.parse()) {
      idx = i;
      if (maxRow !== null && idx > maxRow) break;
      for (; counter < idx; counter++) yield emptyRow;
      if (counter <= idx) {
        counter++;
        yield this.getRow(row, minCol, maxCol);
      }
    }
    if (maxRow !== null && maxRow < idx) for (; counter <= maxRow; counter++) yield emptyRow;
  }

  /**
   * ReadOnlyWorksheet._get_row: a parsed row as cells from minCol to maxCol, gaps filled with empty cells.
   * @param {Array<object>} row the parsed cells
   * @param {number} minCol
   * @param {number|null} maxCol
   * @returns {Array}
   */
  getRow(row, minCol, maxCol) {
    if (!row.length && !maxCol) return [];
    maxCol = maxCol || row[row.length - 1].column;
    const out = new Array(Math.max(0, maxCol + 1 - minCol)).fill(EMPTY_CELL);
    for (const cell of row) {
      if (minCol <= cell.column && cell.column <= maxCol) out[cell.column - minCol] = new ReadOnlyCell(this, cell);
    }
    return out;
  }

  /**
   * ReadOnlyWorksheet.reset_dimensions.
   * @returns {void}
   */
  resetDimensions() {
    this.maxRow = null;
    this.maxColumn = null;
  }

  /**
   * ReadOnlyWorksheet.calculate_dimension(force=True).
   * @returns {boolean} false when openpyxl hits its UnboundLocalError (a sheet without rows)
   * @throws {Error} pyName AttributeError when a row ends in an empty cell
   */
  calculateDimension() {
    if (this.maxColumn && this.maxRow) return true;
    let maxCol = 0;
    let cell = null;
    for (const r of this.iterRows()) {
      if (!r.length) continue;
      cell = r[r.length - 1];
      if (cell.empty) throw pyError('AttributeError', "'EmptyCell' object has no attribute 'column'");
      maxCol = Math.max(maxCol, cell.column);
    }
    if (cell === null) return false;
    this.maxRow = cell.row;
    this.maxColumn = maxCol;
    return true;
  }
}

/** openpyxl.load_workbook(f, read_only=True, data_only=True): the package's sheets, strings and styles. */
class Workbook {
  /**
   * @param {Buffer} buf file contents
   * @throws {Error} pyName zipfile.BadZipFile for a file that is not a zip, KeyError for a missing part, OSError
   *   for a package without a workbook part, and the XML ParseError of a malformed part
   */
  constructor(buf) {
    this.archive = new ZipFile(buf);
    const validFiles = new Set(this.archive.namelist());
    const manifest = xml.parse(this.archive.read('[Content_Types].xml'));
    const overrides = manifest.findall(`${CT_NS}Override`).map((o) => [o.get('PartName'), o.get('ContentType')]);
    const findPart = (ct) => overrides.find((o) => o[1] === ct);

    this.sharedStrings = [];
    const ss = findPart(SPREADSHEET('sharedStrings'));
    if (ss) {
      for (const node of xml.parse(this.archive.read(ss[0].slice(1))).iterEnd()) {
        if (node.tag === `${MAIN}si`) this.sharedStrings.push(textContent(node).split('x005F_').join(''));
      }
    }

    let wbPart = null;
    for (const ct of WORKBOOK_TYPES) {
      wbPart = findPart(ct);
      if (wbPart) break;
    }
    if (!wbPart) {
      const defaults = new Set(manifest.findall(`${CT_NS}Default`).map((d) => d.get('ContentType')));
      if (WORKBOOK_TYPES.some((t) => defaults.has(t))) wbPart = ['/xl/workbook.xml'];
      else throw pyError('OSError', 'File contains no valid workbook part');
    }
    const wbPath = wbPart[0].slice(1);
    const wbRoot = xml.parse(this.archive.read(wbPath));
    const pr = wbRoot.find(`${MAIN}workbookPr`);
    const date1904 = pr ? pr.get('date1904') : null;
    this.epoch = date1904 !== null && !['false', 'f', '0'].includes(date1904) && date1904 !== '' ? MAC_EPOCH : WINDOWS_EPOCH;
    this.activeIndex = 0;
    const views = wbRoot.find(`${MAIN}bookViews`);
    if (views) {
      const first = views.findall(`${MAIN}workbookView`)[0];
      if (first) this.activeIndex = Number(first.get('activeTab', '0'));
    }
    const sheetsEl = wbRoot.find(`${MAIN}sheets`);
    const sheets = sheetsEl ? sheetsEl.findall(`${MAIN}sheet`) : [];

    this.readStyles();

    let rels = null;
    this.sheets = [];
    for (const sheet of sheets) {
      const id = sheet.get(`${REL_NS}id`);
      if (!id) {
        warn(`${SITE_PACKAGES}/openpyxl/reader/workbook.py`, 81, 'UserWarning',
          'File contains an invalid specification for 0. This will be removed', '  warn(msg)');
        continue;
      }
      if (rels === null) rels = getDependents(this.archive, getRelsPath(wbPath));
      const rel = rels.get(id);
      if (!rel) throw pyError('KeyError', pyRepr(id));
      if (!validFiles.has(rel.target)) continue;
      if (rel.type && rel.type.includes('chartsheet')) {
        this.sheets.push({ title: sheet.get('name'), chartsheet: true });
        continue;
      }
      this.sheets.push(new ReadOnlyWorksheet(this, sheet.get('name'), rel.target));
    }
  }

  /**
   * openpyxl.styles.stylesheet: the cell style number formats and which of them are date or duration formats
   * (the defaults when the package has no styles part).
   * @returns {void}
   * @throws {Error} pyName xml.etree.ElementTree.ParseError for a malformed styles part
   */
  readStyles() {
    this.cellStyles = [0];
    this.numberFormats = [];
    this.dateFormats = new Set();
    this.timedeltaFormats = new Set();
    let src;
    try {
      src = this.archive.read('xl/styles.xml');
    } catch (e) {
      if (e.pyName === 'KeyError') return;
      throw e;
    }
    const root = xml.parse(src);
    const custom = new Map();
    const numFmts = root.find(`${MAIN}numFmts`);
    if (numFmts) {
      for (const n of numFmts.findall(`${MAIN}numFmt`)) custom.set(Number(n.get('numFmtId')), n.get('formatCode'));
    }
    const cellXfs = root.find(`${MAIN}cellXfs`);
    const xfs = cellXfs ? cellXfs.findall(`${MAIN}xf`) : [];
    if (!xfs.length) {
      warn(`${SITE_PACKAGES}/openpyxl/styles/stylesheet.py`, 232, 'UserWarning',
        "Workbook contains no stylesheet, using openpyxl's defaults",
        '  warn("Workbook contains no stylesheet, using openpyxl\'s defaults")');
      return;
    }
    const styles = [];
    const dateFormats = new Set();
    const timedeltaFormats = new Set();
    xfs.forEach((xf, idx) => {
      let id = Number(xf.get('numFmtId', '0'));
      let fmt;
      if (custom.has(id)) {
        fmt = custom.get(id);
        if (BUILTIN_FORMATS_REVERSE.has(fmt)) id = BUILTIN_FORMATS_REVERSE.get(fmt);
        else {
          let i = this.numberFormats.indexOf(fmt);
          if (i < 0) {
            this.numberFormats.push(fmt);
            i = this.numberFormats.length - 1;
          }
          id = i + BUILTIN_FORMATS_MAX_SIZE;
        }
      } else {
        fmt = BUILTIN_FORMATS[id] !== undefined ? BUILTIN_FORMATS[id] : null;
      }
      if (isDateFormat(fmt)) dateFormats.add(idx);
      if (isTimedeltaFormat(fmt)) timedeltaFormats.add(idx);
      styles.push(id);
    });
    this.cellStyles = styles;
    this.dateFormats = dateFormats;
    this.timedeltaFormats = timedeltaFormats;
  }

  /** @returns {string[]} Workbook.sheetnames */
  get sheetnames() { return this.sheets.map((s) => s.title); }

  /** @returns {ReadOnlyWorksheet[]} Workbook.worksheets (chartsheets excluded) */
  get worksheets() { return this.sheets.filter((s) => !s.chartsheet); }

  /** @returns {ReadOnlyWorksheet|null} Workbook.active, or null when the active index is out of range */
  get active() {
    const i = this.activeIndex < 0 ? this.activeIndex + this.sheets.length : this.activeIndex;
    return this.sheets[i] || null;
  }

  /**
   * Workbook.__getitem__ by title.
   * @param {string} key
   * @returns {ReadOnlyWorksheet}
   * @throws {Error} pyName KeyError "Worksheet X does not exist."
   */
  get(key) {
    const s = this.sheets.find((x) => x.title === key);
    if (!s) throw pyError('KeyError', pyRepr(`Worksheet ${key} does not exist.`));
    return s;
  }
}

/** agateexcel.table_xlsx.normalize_datetime */
function normalizeDatetime(dt) {
  if (dt.us === 0) return dt;
  if (dt.us < 1000) return withMicro(dt, 0);
  if (dt.us > 999000) {
    if (dt instanceof PyTime) {
      throw pyError('TypeError', "unsupported operand type(s) for +: 'datetime.time' and 'datetime.timedelta'");
    }
    return addSecond(withMicro(dt, 0));
  }
  return dt;
}

function withMicro(dt, us) {
  if (dt instanceof PyTime) return new PyTime(dt.h, dt.mi, dt.s, us);
  return new PyDateTime(dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s, us);
}

/** datetime + timedelta(seconds=1) */
function addSecond(dt) {
  return addToEpoch([dt.y, dt.mo, dt.d], BigInt((dt.h * 3600 + dt.mi * 60 + dt.s + 1) * 1e6));
}

/** agateexcel.table_xlsx.has_date_elements */
function hasDateElements(cell) {
  const fmt = cell.numberFormat;
  return fmt.includes('d') || fmt.includes('y');
}

function cellValue(c) {
  let value = c.value;
  if (value instanceof PyDateTime) {
    if (value.y === 1904 && value.mo === 1 && value.d === 1 && !hasDateElements(c)) {
      value = normalizeDatetime(new PyTime(value.h, value.mi, value.s, value.us));
    } else if (!value.h && !value.mi && !value.s && !value.us) {
      value = new PyDate(value.y, value.mo, value.d);
    } else {
      value = normalizeDatetime(value);
    }
  }
  return value;
}

/** Python str() of a cell value used as a column name. */
function pyStrValue(v) {
  if (v instanceof PyDateTime) return v.pyStr(' ');
  return pyStr(v);
}

/**
 * agateexcel from_xlsx without the final Table: each selected sheet's column names and rows, sheet by sheet, so
 * that the caller builds each table before the next sheet is read.
 * @param {Buffer} buf XLSX contents
 * @param {object} o {sheets: Array<string|number|null>, skipLines, header, resetDimensions}
 * @returns {Generator<{title: string, columnNames: Array|null, rows: Array[]}>}
 * @throws {Error} pyName KeyError "Worksheet X does not exist." for an unknown sheet name, IndexError for a sheet
 *   index out of range, AttributeError for a chartsheet or a workbook without an active sheet, and the
 *   zipfile.BadZipFile, KeyError, OSError or ValueError openpyxl raises for a damaged package
 */
function* readXlsx(buf, o) {
  const book = new Workbook(buf);
  for (const spec of o.sheets) {
    let sheet;
    if (typeof spec === 'string') sheet = book.get(spec);
    else if (typeof spec === 'number') {
      const ws = book.worksheets;
      sheet = ws[spec < 0 ? spec + ws.length : spec];
      if (!sheet) throw pyError('IndexError', 'list index out of range');
    } else {
      sheet = book.active;
      if (!sheet) throw pyError('AttributeError', "'NoneType' object has no attribute 'max_column'");
    }
    if (sheet.chartsheet) {
      const attr = o.resetDimensions ? 'reset_dimensions' : 'max_column';
      throw pyError('AttributeError', `'Chartsheet' object has no attribute '${attr}'`);
    }
    if (o.resetDimensions || (o.resetDimensions === null && sheet.maxColumn === 1 && sheet.maxRow === 1)) {
      sheet.resetDimensions();
      sheet.calculateDimension();
    }
    let columnNames = null;
    let offset = 0;
    if (o.header) {
      columnNames = [];
      for (const row of sheet.iterRows(1 + o.skipLines, 1 + o.skipLines)) {
        for (const c of row) columnNames.push(c.value === null ? null : pyStrValue(c.value));
      }
      offset = 1;
    }
    const rows = [];
    for (const row of sheet.iterRows(1 + o.skipLines + offset)) rows.push(row.map(cellValue));
    yield { title: sheet.title, columnNames, rows };
  }
}

/**
 * Workbook.sheetnames of an XLSX file (in2csv --names).
 * @param {Buffer} buf XLSX contents
 * @returns {string[]}
 * @throws {Error} pyName zipfile.BadZipFile, KeyError, OSError or ValueError as openpyxl raises them for a
 *   damaged package
 */
function xlsxSheetNames(buf) {
  return new Workbook(buf).sheetnames;
}

module.exports = { readXlsx, xlsxSheetNames };
