'use strict';
// Port of csvkit.utilities.csvjson's GeoJSON output (csvkit 2.2.0, MIT): the GeoJsonGenerator that turns each row
// into a Feature and the GeoJsonBounds that computes the FeatureCollection's bbox, with the Python semantics of
// float(), json.loads, len(), indexing and iteration they rely on.

const { matchColumnIdentifier } = require('./cli');
const { pyError } = require('./pyerrors');
const { PyFloat } = require('./pyjson');
const { loads } = require('./jsonparse');
const T = require('./types');
const { strToFloat } = require('./pyunicode');

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

module.exports = { GeoJsonBounds, GeoJsonGenerator };
