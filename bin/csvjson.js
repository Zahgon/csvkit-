#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvjson (csvkit 2.2.0, MIT) and agate.Table.to_json (agate 1.14.2, MIT).
const { Utility, matchColumnIdentifier } = require('../lib/cli');
const { pyError } = require('../lib/pyerrors');
const { addSniffAndInference } = require('../lib/common');
const { dump, PyFloat } = require('../lib/pyjson');
const { loads } = require('../lib/jsonparse');
const T = require('../lib/types');
const { agateReader } = require('../lib/table');
const { pyRepr } = require('../lib/pystr');
const { strToFloat } = require('../lib/pyunicode');
const pycsv = require('../lib/pycsv');

// The Python class name of a cell value, for error messages.
function className(v) {
  if (v === null) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (v.isDecimal) return 'Decimal';
  return v.kind;
}

const QUALIFIED = { date: 'datetime.date', datetime: 'datetime.datetime', timedelta: 'datetime.timedelta' };

/** float(v) for a cell value: a str, Decimal, bool, None, date, datetime or timedelta. */
function pyFloat(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && v.isDecimal) return v.toNumber();
  if (typeof v !== 'string') {
    const name = v === null ? 'NoneType' : QUALIFIED[v.kind];
    throw pyError('TypeError', `float() argument must be a string or a real number, not '${name}'`);
  }
  return strToFloat(v);
}

/** json.loads(s) with Python floats and ints, raising TypeError for a value that is not a str. */
function jsonLoads(s) {
  if (typeof s !== 'string') throw pyError('TypeError', `the JSON object must be str, bytes or bytearray, not ${className(s)}`);
  if (s.startsWith('﻿')) throw pyError('json.decoder.JSONDecodeError', 'Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)');
  return loads(s, { parseFloat: (t) => new PyFloat(Number(t)) });
}

/** csvkit.cli.default_str_decimal, the json.dump default of csvjson. */
function defaultStrDecimal(v) {
  if (v instanceof T.PyDate || v instanceof T.PyDateTime) return v.pyStr();
  if (v.isDecimal) return v.pyStr();
  throw pyError('TypeError', `${timedeltaRepr(v)} is not JSON serializable`);
}

// repr(datetime.timedelta).
function timedeltaRepr(td) {
  const days = Math.floor(td.us / 86400e6);
  const rem = td.us - days * 86400e6;
  const us = rem % 1e6;
  const parts = [];
  if (days) parts.push(`days=${days}`);
  if ((rem - us) / 1e6) parts.push(`seconds=${(rem - us) / 1e6}`);
  if (us) parts.push(`microseconds=${us}`);
  return `datetime.timedelta(${parts.join(', ') || '0'})`;
}

// Python truthiness of a cell value.
function truthy(c) {
  if (typeof c === 'string') return c.length > 0;
  if (typeof c === 'boolean') return c;
  if (c.isDecimal) return !c.isZero();
  if (c instanceof T.PyTimeDelta) return c.us !== 0;
  return true;
}

// A JSON number (int, float or bool) as a JavaScript number, or null for any other value.
function jsonNumber(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (x && x.pyInt !== undefined) return Number(x.pyInt);
  if (x && x.isPyFloat) return x.value;
  return null;
}

// The Python type name of a decoded JSON value.
function jsonTypeName(x) {
  if (x === null) return 'NoneType';
  if (typeof x === 'string') return 'str';
  if (typeof x === 'boolean') return 'bool';
  if (Array.isArray(x)) return 'list';
  if (x instanceof Map) return 'dict';
  return x.pyInt !== undefined ? 'int' : 'float';
}

/**
 * len(x) on a decoded JSON value.
 * @param {*} x
 * @returns {number}
 * @throws {Error} pyName TypeError for a number, boolean or null
 */
function pyLen(x) {
  if (typeof x === 'string') return [...x].length;
  if (Array.isArray(x)) return x.length;
  if (x instanceof Map) return x.size;
  throw pyError('TypeError', `object of type '${jsonTypeName(x)}' has no len()`);
}

/**
 * x[i] on a decoded JSON value.
 * @param {*} x
 * @param {number} i
 * @returns {*}
 * @throws {Error} pyName KeyError for an object without key i, IndexError past the end of a list or string
 */
function pyIndex(x, i) {
  if (x instanceof Map) {
    if (!x.has(i)) throw pyError('KeyError', String(i));
    return x.get(i);
  }
  const items = typeof x === 'string' ? [...x] : x;
  if (i >= items.length) throw pyError('IndexError', `${typeof x === 'string' ? 'string' : 'list'} index out of range`);
  return items[i];
}

/**
 * The items iterating a decoded JSON value gives: an object's keys, a string's characters, a list's items.
 * @param {*} x
 * @returns {Array}
 */
function pyIter(x) {
  if (x instanceof Map) return [...x.keys()];
  return typeof x === 'string' ? [...x] : x;
}

// `'coordinates' in geometry` followed by geometry['coordinates'].
function coordinatesOf(geometry) {
  if (geometry instanceof Map) return geometry.has('coordinates') ? geometry.get('coordinates') : undefined;
  if (typeof geometry === 'string' || Array.isArray(geometry)) {
    if (!geometry.includes('coordinates')) return undefined;
    throw pyError('TypeError', typeof geometry === 'string' ? "string indices must be integers, not 'str'" : 'list indices must be integers or slices, not str');
  }
  throw pyError('TypeError', `argument of type '${jsonTypeName(geometry)}' is not iterable`);
}

/** csvjson's GeoJsonBounds: the bounding box of every feature's coordinates. */
class GeoJsonBounds {
  constructor() {
    this.minLon = null;
    this.minLat = null;
    this.maxLon = null;
    this.maxLat = null;
  }

  /** @returns {Array} [min lon, min lat, max lon, max lat], each null until a point was seen */
  bbox() { return [this.minLon, this.minLat, this.maxLon, this.maxLat]; }

  /**
   * Widens the box by a feature's geometry coordinates, if it has any.
   * @param {Map} feature
   * @returns {void}
   * @throws {Error} pyName TypeError for a geometry that is a number or a string or list containing "coordinates",
   *   as Python's `in` and indexing fail there; and updateCoordinates()'s errors
   */
  addFeature(feature) {
    const coordinates = coordinatesOf(feature.get('geometry'));
    if (coordinates !== undefined) this.updateCoordinates(coordinates, 0);
  }

  /**
   * GeoJsonBounds.update_coordinates: a position of up to three numbers widens the box; anything else is walked as a
   * list of coordinates.
   * @param {*} coordinates a JSON value from the geometry
   * @param {number} depth the nesting depth, to raise Python's RecursionError where it would
   * @returns {void}
   * @throws {Error} pyName RecursionError past Python's recursion limit; TypeError, KeyError or IndexError where
   *   the Python code fails on coordinates of another shape
   */
  updateCoordinates(coordinates, depth) {
    if (depth > 990) throw pyError('RecursionError', 'maximum recursion depth exceeded in __instancecheck__');
    if (pyLen(coordinates) <= 3 && jsonNumber(pyIndex(coordinates, 0)) !== null) {
      const lon = pyIndex(coordinates, 0);
      if (this.minLon === null || jsonNumber(lon) < jsonNumber(this.minLon)) this.minLon = lon;
      if (this.maxLon === null || jsonNumber(lon) > jsonNumber(this.maxLon)) this.maxLon = lon;
      const lat = pyIndex(coordinates, 1);
      if (this.minLat === null || jsonNumber(lat) < jsonNumber(this.minLat)) this.minLat = lat;
      if (this.maxLat === null || jsonNumber(lat) > jsonNumber(this.maxLat)) this.maxLat = lat;
    } else {
      for (const coordinate of pyIter(coordinates)) this.updateCoordinates(coordinate, depth + 1);
    }
  }
}

/** csvjson's GeoJsonGenerator: a Feature per row, from the --lat, --lon, --type, --geometry and -k columns. */
class GeoJsonGenerator {
  /**
   * @param {object} args the parsed arguments
   * @param {string[]} columnNames
   * @throws {ColumnIdentifierError} for a --lat, --lon, --type, --geometry or -k column that does not exist
   */
  constructor(args, columnNames) {
    this.args = args;
    this.columnNames = columnNames;
    // csvjson passes args.zero_based as the column offset.
    const offset = args.zero_based ? 1 : 0;
    this.latColumn = matchColumnIdentifier(columnNames, args.lat, offset);
    this.lonColumn = matchColumnIdentifier(columnNames, args.lon, offset);
    this.typeColumn = args.type ? matchColumnIdentifier(columnNames, args.type, offset) : null;
    this.geometryColumn = args.geometry ? matchColumnIdentifier(columnNames, args.geometry, offset) : null;
    this.idColumn = args.key ? matchColumnIdentifier(columnNames, args.key, offset) : null;
  }

  /**
   * The FeatureCollection of every row, with its bbox unless --no-bbox and its crs with --crs.
   * @param {object} table an agate Table
   * @returns {Map}
   * @throws {Error} as featureForRow() and GeoJsonBounds.addFeature()
   */
  generateFeatureCollection(table) {
    const features = [];
    const bounds = new GeoJsonBounds();
    for (const row of table.rows) {
      const feature = this.featureForRow(row);
      if (!this.args.no_bbox) bounds.addFeature(feature);
      features.push(feature);
    }
    const items = [['type', 'FeatureCollection'], ['features', features]];
    if (!this.args.no_bbox) items.splice(1, 0, ['bbox', bounds.bbox()]);
    if (this.args.crs) items.push(['crs', new Map([['type', 'name'], ['properties', new Map([['name', this.args.crs]])]])]);
    return new Map(items);
  }

  /**
   * GeoJsonGenerator.feature_for_row: the row's non-empty other columns become properties, the -k column the id.
   * @param {Array} row
   * @returns {Map}
   * @throws {Error} pyName IndexError for a row longer than the header, and geometryForRow()'s errors
   */
  featureForRow(row) {
    const feature = new Map([['type', 'Feature'], ['properties', new Map()]]);
    const skipped = [this.typeColumn, this.latColumn, this.lonColumn, this.geometryColumn];
    row.forEach((c, i) => {
      if (c === null || skipped.includes(i)) return;
      if (i === this.idColumn) feature.set('id', c);
      else if (truthy(c)) {
        if (i >= this.columnNames.length) throw pyError('IndexError', 'list index out of range');
        feature.get('properties').set(this.columnNames[i], c);
      }
    });
    feature.set('geometry', this.geometryForRow(row));
    return feature;
  }

  /**
   * GeoJsonGenerator.geometry_for_row: the --geometry column parsed as JSON, else a Point from --lon and --lat
   * (none when either is missing, zero or not a number).
   * @param {Array} row
   * @returns {Map|*|null}
   * @throws {Error} pyName IndexError for a row without the geometry column, json.decoder.JSONDecodeError or
   *   TypeError for a geometry value that is not a JSON string
   */
  geometryForRow(row) {
    if (this.geometryColumn !== null) {
      if (this.geometryColumn >= row.length) throw pyError('IndexError', 'list index out of range');
      return jsonLoads(row[this.geometryColumn]);
    }
    let lon = null;
    let lat = null;
    try {
      lon = pyFloat(row[this.lonColumn]);
      lat = pyFloat(row[this.latColumn]);
    } catch (e) {
      if (e.pyName !== 'ValueError') throw e;
      lon = null;
      lat = null;
    }
    // Python float truthiness: NaN is true.
    if (lon !== null && lon !== 0 && lat !== null && lat !== 0) return new Map([['type', 'Point'], ['coordinates', [new PyFloat(lon), new PyFloat(lat)]]]);
    return null;
  }
}

// agate's DataType.jsonify for each column type.
function jsonify(v, type) {
  if (v === null) return null;
  if (type instanceof T.NumberType) return new PyFloat(v.toNumber());
  if (type instanceof T.BooleanType) return v;
  if (type instanceof T.DateType || type instanceof T.DateTimeType) return v.pyStr();
  return pycsv.pyStr(v);
}

/** csvjson: converts a CSV file to a JSON array, a JSON object keyed by a column, newline-delimited JSON, or GeoJSON. */
class CSVJSON extends Utility {
  constructor() {
    super('csvjson', 'Convert a CSV file into JSON (or GeoJSON).');
  }

  /**
   * CSVJSON.add_arguments: -i, -k, --lat, --lon, --type, --geometry, --crs, --no-bbox, --stream, -y and -I.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['-i', '--indent'], { dest: 'indent', type: 'int', help: 'Indent the output JSON this many spaces. Disabled by default.' });
    p.addArgument(['-k', '--key'], { dest: 'key', help: 'Output JSON as an object keyed by a given column, KEY, rather than as an array. All column values must be unique. If --lat and --lon are specified, this column is used as the GeoJSON Feature ID.' });
    p.addArgument(['--lat'], { dest: 'lat', help: 'A column index or name containing a latitude. Output will be GeoJSON instead of JSON. Requires --lon.' });
    p.addArgument(['--lon'], { dest: 'lon', help: 'A column index or name containing a longitude. Output will be GeoJSON instead of JSON. Requires --lat.' });
    p.addArgument(['--type'], { dest: 'type', help: 'A column index or name containing a GeoJSON type. Output will be GeoJSON instead of JSON. Requires --lat and --lon.' });
    p.addArgument(['--geometry'], { dest: 'geometry', help: 'A column index or name containing a GeoJSON geometry. Output will be GeoJSON instead of JSON. Requires --lat and --lon.' });
    p.addArgument(['--crs'], { dest: 'crs', help: 'A coordinate reference system string to be included with GeoJSON output. Requires --lat and --lon.' });
    p.addArgument(['--no-bbox'], { dest: 'no_bbox', action: 'store_true', help: 'Disable the calculation of a bounding box.' });
    p.addArgument(['--stream'], { dest: 'streamOutput', action: 'store_true', help: 'Output JSON as a stream of newline-separated objects, rather than an as an array.' });
    addSniffAndInference(p);
  }

  /**
   * CSVJSON.main: checks the option combinations, then streams (--stream with -I, no sniffing and no -K) or converts
   * the whole table.
   * @returns {void}
   * @throws {ExitError} with status 2 for an invalid option combination or no input on a terminal
   * @throws {Error} the errors of the output method chosen
   */
  main() {
    const a = this.args;
    const error = (m) => this.argparser.error(m);
    if (a.lat && !a.lon) error('--lon is required whenever --lat is specified.');
    if (a.lon && !a.lat) error('--lat is required whenever --lon is specified.');
    if (a.crs && !a.lat) error('--crs is only allowed when --lat and --lon are also specified.');
    if (a.type && !a.lat) error('--type is only allowed when --lat and --lon are also specified.');
    if (a.geometry && !a.lat) error('--geometry is only allowed when --lat and --lon are also specified.');
    if (a.key && a.streamOutput && !(a.lat && a.lon)) error('--key is only allowed with --stream when --lat and --lon are also specified.');
    const isGeo = Boolean(a.lat && a.lon);
    if (a.streamOutput && a.no_inference && a.sniff_limit === 0 && !a.skip_lines) {
      if (this.additionalInputExpected()) process.stderr.write('No input file or piped data provided. Waiting for standard input:\n');
      if (isGeo) this.streamingOutputNdgeojson();
      else this.streamingOutputNdjson();
    } else {
      if (this.additionalInputExpected()) error('You must provide an input file or piped data.');
      if (isGeo) this.outputGeojson();
      else this.outputJson();
    }
  }

  /**
   * CSVJSON.dump_json: json.dump with -i's indent, ensure_ascii off and default_str_decimal.
   * @param {*} data
   * @param {boolean} [newline] whether a newline follows
   * @returns {void}
   * @throws {Error} pyName TypeError for a value JSON cannot serialize
   */
  dumpJson(data, newline = false) {
    dump(data, this.out, { indent: this.args.indent, ensureAscii: false, default: defaultStrDecimal });
    if (newline) this.out.write('\n');
  }

  /**
   * CSVJSON.read_csv_to_table.
   * @returns {object} the agate Table
   * @throws {Error} the reader's and casts' errors, see Utility.tableFromCsv()
   */
  readCsvToTable() {
    const a = this.args;
    return this.tableFromCsv(this.input_file, {
      skipLines: a.skip_lines,
      sniffLimit: a.sniff_limit !== -1 ? a.sniff_limit : null,
      columnTypes: this.getColumnTypes(),
      kwargs: this.reader_kwargs,
    });
  }

  /**
   * agate.Table.to_json(output, key=args.key, newline=args.streamOutput, indent=args.indent).
   * @returns {void}
   * @throws {Error} pyName ValueError for -k with --stream, --stream with -i or a duplicate key value; KeyError for
   *   a -k column the table does not have
   */
  outputJson() {
    const table = this.readCsvToTable();
    const { key, streamOutput: newline, indent } = this.args;
    if (key !== null && newline) throw pyError('ValueError', 'key and newline may not be specified together.');
    if (newline && indent !== null) throw pyError('ValueError', 'newline and indent may not be specified together.');
    const opts = { ensureAscii: false, indent };
    const rowObject = (row) => new Map(table.columnNames.map((name, i) => [name, jsonify(row[i], table.columnTypes[i])]));
    if (key !== null) {
      const keyIndex = table.columnNames.indexOf(key);
      if (keyIndex < 0) throw pyError('KeyError', pyRepr(key));
      const output = new Map();
      for (const row of table.rows) {
        const v = row[keyIndex];
        let k;
        if (v !== null && v.isDecimal) k = v.normalize().pyStr();
        else if (v instanceof T.PyDateTime) k = v.pyStr(' ');
        else k = v === null ? 'None' : pycsv.pyStr(v);
        if (output.has(k)) throw pyError('ValueError', `Value ${k} is not unique in the key column.`);
        output.set(k, rowObject(row));
      }
      dump(output, this.out, opts);
    } else if (newline) {
      for (const row of table.rows) {
        dump(rowObject(row), this.out, opts);
        this.out.write('\n');
      }
    } else {
      dump(table.rows.map(rowObject), this.out, opts);
    }
  }

  /**
   * CSVJSON.output_geojson: the FeatureCollection, or one Feature per line with --stream.
   * @returns {void}
   * @throws {Error} as GeoJsonGenerator
   */
  outputGeojson() {
    const table = this.readCsvToTable();
    const generator = new GeoJsonGenerator(this.args, table.columnNames);
    if (this.args.streamOutput) {
      for (const row of table.rows) this.dumpJson(generator.featureForRow(row), true);
    } else {
      this.dumpJson(generator.generateFeatureCollection(table));
    }
  }

  /**
   * The header row and the remaining rows of an un-inferred, unsniffed stream.
   * @returns {Array} [column names, row iterator]
   * @throws {Error} pyName StopIteration for an empty input
   */
  streamRows() {
    const rows = agateReader(this.input_file.lines(), this.reader_kwargs);
    const first = rows.next();
    if (first.done) throw pyError('StopIteration', '');
    return [first.value, rows];
  }

  /**
   * CSVJSON.streaming_output_ndjson: one JSON object per row, as text.
   * @returns {void}
   * @throws {Error} as streamRows()
   */
  streamingOutputNdjson() {
    const [columnNames, rows] = this.streamRows();
    for (const row of rows) {
      this.dumpJson(new Map(columnNames.map((column, i) => [column, i < row.length ? row[i] : null])), true);
    }
  }

  /**
   * CSVJSON.streaming_output_ndgeojson: one GeoJSON Feature per row.
   * @returns {void}
   * @throws {Error} as streamRows() and GeoJsonGenerator
   */
  streamingOutputNdgeojson() {
    const [columnNames, rows] = this.streamRows();
    const generator = new GeoJsonGenerator(this.args, columnNames);
    for (const row of rows) this.dumpJson(generator.featureForRow(row), true);
  }
}

new CSVJSON().launch();
