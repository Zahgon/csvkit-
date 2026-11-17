'use strict';
// agate.Table.from_json and Table.from_object (agate/table/from_json.py, from_object.py) with agate.utils.parse_object,
// over the JSON values of lib/jsonparse (Map objects, arrays, numbers, strings, booleans and null).

const { Table } = require('./table');
const { loads } = require('./jsonparse');
const { pyError } = require('./pyerrors');
const { pyRepr } = require('./pystr');
const { SITE_PACKAGES } = require('./warnings');

// Where Table.from_object builds the table, for the location of agate's "Column names not specified" warning.
const FROM_OBJECT_CALL = [`${SITE_PACKAGES}/agate/table/from_object.py`, 93,
  '  return Table(rows, column_names, row_names=row_names, column_types=column_types)'];

/**
 * agate.utils.parse_object: a JSON value flattened into a Map; nested objects and arrays become "a/b/0" keys and a
 * scalar is stored under its path without the surrounding slashes.
 * @param {*} obj a JSON value
 * @param {string} [path] the key prefix of obj
 * @returns {Map<string, *>}
 */
function parseObject(obj, path = '') {
  let entries;
  if (obj instanceof Map) entries = [...obj.entries()];
  else if (Array.isArray(obj)) entries = obj.map((v, i) => [String(i), v]);
  else return new Map([[path.replace(/^\/+|\/+$/g, ''), obj]]);
  const d = new Map();
  for (const [k, v] of entries) for (const [kk, vv] of parseObject(v, `${path}${k}/`)) d.set(kk, vv);
  return d;
}

/**
 * agate.Table.from_object: one row per element, flattened with parseObject; the columns are the keys in order of
 * first appearance and a key an element lacks is null.
 * @param {Iterable<*>} js the elements
 * @param {TypeTester|Array<object>} columnTypes
 * @returns {Table}
 * @throws {Error} the errors new Table() raises
 */
function fromObject(js, columnTypes) {
  const columnNames = [];
  const objects = [];
  for (const sub of js) {
    const parsed = parseObject(sub);
    for (const k of parsed.keys()) if (!columnNames.includes(k)) columnNames.push(k);
    objects.push(parsed);
  }
  const rows = objects.map((o) => columnNames.map((n) => (o.has(n) ? o.get(n) : null)));
  return new Table(rows, columnNames, columnTypes, { caller: FROM_OBJECT_CALL });
}

/**
 * agate.Table.from_json: a JSON array (or the array under key of a top-level object), or with newline one JSON
 * value per line (NDJSON), as a table through fromObject.
 * @param {{read: function(): string, lines: function(): Iterable<string>}} f the input file
 * @param {{key?: string|null, newline?: boolean, columnTypes: TypeTester|Array<object>}} opts
 * @returns {Table}
 * @throws {Error} pyName ValueError for a key with newline, TypeError for a top-level object without a key, KeyError
 *   for a key the object does not have, json.decoder.JSONDecodeError for invalid JSON, and fromObject()'s errors
 */
function fromJson(f, { key = null, newline = false, columnTypes }) {
  if (key != null && newline) throw pyError('ValueError', 'key and newline may not be specified together.');
  let js = newline ? [...f.lines()].map((line) => loads(line)) : loads(f.read());
  if (js instanceof Map) {
    if (!key) {
      throw pyError('TypeError',
        'When converting a JSON document with a top-level dictionary element, a key must be specified.');
    }
    if (!js.has(key)) throw pyError('KeyError', pyRepr(key));
    js = js.get(key);
  }
  return fromObject(js, columnTypes);
}

module.exports = { parseObject, fromObject, fromJson };
