'use strict';
// Port of csvkit 2.2.0 csvkit.convert (MIT): guess_format, fixed2csv with its FixedWidthReader and SchemaDecoder,
// and geojson2csv, over the JSON values of lib/jsonparse (Map objects, {pyInt} integers, PyFloat floats).

const { pyError } = require('./pyerrors');
const pycsv = require('./pycsv');
const { LineWriter } = require('./table');
const { loads } = require('./jsonparse');
const { dumps, PyFloat } = require('./pyjson');
const { pyRepr, pyStrip } = require('./pystr');
const { strToInt } = require('./pyunicode');

/**
 * csvkit.convert.guess_format: the input format implied by a file name.
 * @param {string} filename input path
 * @returns {string|null}
 */
function guessFormat(filename) {
  const lastPeriod = filename.lastIndexOf('.');
  if (lastPeriod === -1) return 'fixed';
  const extension = filename.slice(lastPeriod + 1).toLowerCase();
  if (['csv', 'dbf', 'fixed', 'xls', 'xlsx'].includes(extension)) return extension;
  if (extension === 'json' || extension === 'js') return 'json';
  return null;
}

/** Python list.index for a header row, raising the schema's ValueError when absent. */
function schemaColumn(header, name) {
  const i = header.indexOf(name);
  if (i < 0) throw pyError('ValueError', `A column named "${name}" must exist in the schema file.`);
  return i;
}

/** Python list indexing with IndexError. */
function item(row, i) {
  if (i >= row.length || i < -row.length) throw pyError('IndexError', 'list index out of range');
  return row[i < 0 ? i + row.length : i];
}

/**
 * SchemaDecoder: finds the column, start and length columns of a schema header, then decodes schema rows into
 * fields. Start values are zero-based unless the first one is 1, in which case all are one-based.
 */
class SchemaDecoder {
  /**
   * @param {string[]} header the schema's header row
   */
  constructor(header) {
    this.column = schemaColumn(header, 'column');
    this.start = schemaColumn(header, 'start');
    this.length = schemaColumn(header, 'length');
    this.oneBased = null;
  }

  /**
   * The field a schema row describes (SchemaDecoder.__call__).
   * @param {string[]} row schema row
   * @returns {{name: string, start: number, length: number}}
   * @throws {Error} pyName IndexError for a short row, ValueError for a start or length that is not an integer
   */
  decode(row) {
    if (this.oneBased === null) this.oneBased = strToInt(item(row, this.start)) === 1;
    const adjustedStart = strToInt(item(row, this.start)) - (this.oneBased ? 1 : 0);
    return { name: item(row, this.column), start: adjustedStart, length: strToInt(item(row, this.length)) };
  }
}

/** Python str slicing by code points. */
function slice(chars, start, stop) {
  const n = chars.length;
  const norm = (x) => (x < 0 ? Math.max(0, x + n) : Math.min(x, n));
  return chars.slice(norm(start), norm(stop)).join('');
}

/**
 * FixedWidthRowParser: the fields of a CSV schema with column, start and length columns, and the cutting of a
 * fixed-width line into those fields.
 */
class FixedWidthRowParser {
  /**
   * @param {Iterable<string>} schemaLines lines of the schema file
   * @throws {Error} pyName StopIteration for an empty schema, ValueError for a header without column, start and
   *   length or a row that cannot be decoded (with its line number), and the csv reader's errors
   */
  constructor(schemaLines) {
    this.fields = [];
    const reader = new pycsv.Reader(schemaLines);
    const header = reader.readRow();
    if (header === null) throw pyError('StopIteration', '');
    const decoder = new SchemaDecoder(header);
    for (let i = 0; ; i++) {
      const row = reader.readRow();
      if (row === null) break;
      try {
        this.fields.push(decoder.decode(row));
      } catch (e) {
        // csvkit's `except Exception as e:` (every Python exception the port raises carries a pyName).
        if (!e.pyName) throw e;
        throw pyError('ValueError', `Error reading schema at line ${i + 2}: ${e.message}`);
      }
    }
  }

  /**
   * The values of a line, each field's slice stripped of whitespace.
   * @param {string} line fixed-width line
   * @returns {string[]}
   */
  parse(line) {
    const chars = [...line];
    return this.fields.map((x) => pyStrip(slice(chars, x.start, x.start + x.length)));
  }

  /** @returns {string[]} the field names */
  get headers() {
    return this.fields.map((x) => x.name);
  }
}

/**
 * csvkit.convert.fixed.fixed2csv in streaming mode: the schema's header, then each line cut into its fields.
 * @param {object} f input file (readline() and lines())
 * @param {object} schema schema file (lines())
 * @param {object} out output stream
 * @param {number} skipLines lines to skip first
 * @returns {void}
 * @throws {Error} as FixedWidthRowParser's constructor, and the input's decoding errors
 */
function fixed2csv(f, schema, out, skipLines) {
  for (let n = skipLines; n > 0; n--) f.readline();
  const writer = new LineWriter(out, {});
  const parser = new FixedWidthRowParser(schema.lines());
  writer.writerow(parser.headers);
  for (const line of f.lines()) writer.writerow(parser.parse(line));
}

/** The Python type name of a JSON value, for error messages. */
function typeName(v) {
  if (v === null) return 'NoneType';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'collections.OrderedDict';
  if (v instanceof PyFloat || typeof v === 'number') return 'float';
  return 'int';
}

function attributeError(v, attr) {
  const name = typeName(v) === 'collections.OrderedDict' ? 'OrderedDict' : typeName(v);
  return pyError('AttributeError', `'${name}' object has no attribute '${attr}'`);
}

/** Python truthiness of a JSON value. */
function truthy(v) {
  if (v === null || v === false) return false;
  if (typeof v === 'string' || Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (v instanceof PyFloat) return v.value !== 0;
  if (typeof v === 'number') return v !== 0;
  if (v.pyInt !== undefined) return v.pyInt !== 0n;
  return true;
}

/** Iterate a JSON value as Python's for loop would. */
function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (v instanceof Map) return [...v.keys()];
  if (typeof v === 'string') return [...v];
  throw pyError('TypeError', `'${typeName(v)}' object is not iterable`);
}

/** repr() of a JSON value (OrderedDict for objects, as Python 3.11 prints it). */
function pyValueRepr(v) {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return pyRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyValueRepr).join(', ')}]`;
  if (v instanceof Map) {
    if (!v.size) return 'OrderedDict()';
    return `OrderedDict([${[...v].map(([k, x]) => `(${pyRepr(k)}, ${pyValueRepr(x)})`).join(', ')}])`;
  }
  if (typeof v === 'number') return pycsv.pyFloatRepr(v);
  return pycsv.pyStr(v);
}

/** What csv.writer writes for a value: str() of it, nothing for None. */
function csvValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v) || v instanceof Map || typeof v === 'number') return pyValueRepr(v);
  return pycsv.pyStr(v);
}

/** json.dumps with the default ensure_ascii=True. */
function jsonDumpsAscii(v) {
  const s = dumps(typeof v === 'number' ? new PyFloat(v) : v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c > 0x7e ? `\\u${c.toString(16).padStart(4, '0')}` : s[i];
  }
  return out;
}

function getKey(obj, key, dflt) {
  if (!(obj instanceof Map)) throw attributeError(obj, 'get');
  return obj.has(key) ? obj.get(key) : dflt;
}

/**
 * csvkit.convert.geojs.geojson2csv: one row per feature with its id, properties, geometry and point coordinates.
 * @param {string} text GeoJSON document
 * @param {object} out output stream
 * @returns {void}
 * @throws {Error} pyName json.decoder.JSONDecodeError for invalid JSON; TypeError, KeyError, AttributeError or
 *   ValueError where csvkit's code fails on a document that is not a FeatureCollection of the expected shape
 */
function geojson2csv(text, out) {
  const js = loads(text, { parseFloat: (t) => new PyFloat(Number(t)) });
  if (!(js instanceof Map)) throw pyError('TypeError', 'JSON document is not valid GeoJSON: Root element is not an object.');
  if (!js.has('type')) throw pyError('TypeError', 'JSON document is not valid GeoJSON: No top-level "type" key.');
  if (js.get('type') !== 'FeatureCollection') {
    const type = js.get('type');
    const shown = type === null ? 'None' : csvValue(type);
    throw pyError('TypeError', `Only GeoJSON with root FeatureCollection type is supported. Not ${shown}`);
  }
  if (!js.has('features')) {
    throw pyError('TypeError', 'JSON document is not a valid FeatureCollection: No top-level "features" key.');
  }
  const parsed = [];
  const propertyFields = [];
  for (const feature of pyIter(js.get('features'))) {
    const properties = getKey(feature, 'properties', new Map());
    if (!(properties instanceof Map)) throw attributeError(properties, 'keys');
    for (const prop of properties.keys()) if (!propertyFields.includes(prop)) propertyFields.push(prop);
    if (!feature.has('geometry')) throw pyError('KeyError', "'geometry'");
    const geometry = feature.get('geometry');
    const geometryType = truthy(geometry) ? getKey(geometry, 'type', null) : null;
    let longitude = null;
    let latitude = null;
    if (geometryType === 'Point' && geometry.has('coordinates')) [longitude, latitude] = firstTwo(geometry.get('coordinates'));
    parsed.push([getKey(feature, 'id', null), properties, jsonDumpsAscii(geometry), geometryType, longitude, latitude]);
  }
  const writer = new LineWriter(out, {});
  writer.writerow(['id', ...propertyFields, 'geojson', 'type', 'longitude', 'latitude']);
  for (const [geoid, properties, geometry, geometryType, longitude, latitude] of parsed) {
    const row = [csvValue(geoid)];
    for (const field of propertyFields) {
      const value = properties.has(field) ? properties.get(field) : null;
      row.push(value instanceof Map ? jsonDumpsAscii(value) : csvValue(value));
    }
    row.push(geometry, csvValue(geometryType), csvValue(longitude), csvValue(latitude));
    writer.writerow(row);
  }
}

/** longitude, latitude = coordinates[0:2] */
function firstTwo(coords) {
  let items;
  if (Array.isArray(coords)) items = coords.slice(0, 2);
  else if (typeof coords === 'string') items = [...coords].slice(0, 2);
  else if (coords instanceof Map) throw pyError('TypeError', "unhashable type: 'slice'");
  else throw pyError('TypeError', `'${typeName(coords)}' object is not subscriptable`);
  if (items.length < 2) throw pyError('ValueError', `not enough values to unpack (expected 2, got ${items.length})`);
  return items;
}

module.exports = { guessFormat, fixed2csv, FixedWidthRowParser, SchemaDecoder, geojson2csv };
