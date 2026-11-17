'use strict';
// Port of agate.Table.to_json (agate 1.14.2, MIT) with agate's DataType.jsonify, and of csvkit.cli.default_str_decimal
// (csvkit 2.2.0, MIT): the JSON values of table cells, written with the json.dump port in pyjson.js.

const { pyError } = require('./pyerrors');
const { dump, PyFloat } = require('./pyjson');
const T = require('./types');
const { pyRepr } = require('./pystr');
const pycsv = require('./pycsv');

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

// agate's DataType.jsonify for each column type.
function jsonify(v, type) {
  if (v === null) return null;
  if (type instanceof T.NumberType) return new PyFloat(v.toNumber());
  if (type instanceof T.BooleanType) return v;
  if (type instanceof T.DateType || type instanceof T.DateTimeType) return v.pyStr();
  return pycsv.pyStr(v);
}

/**
 * agate.Table.to_json(output, key=key, newline=newline, indent=indent): the rows as a JSON array, an object keyed by
 * the key column's values, or one object per line.
 * @param {object} table an agate Table
 * @param {{write: function(string): void}} out
 * @param {{key: (string|null), newline: boolean, indent: (number|null)}} options
 * @returns {void}
 * @throws {Error} pyName ValueError for key with newline, newline with indent or a duplicate key value; KeyError for
 *   a key column the table does not have
 */
function tableToJson(table, out, { key, newline, indent }) {
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
    dump(output, out, opts);
  } else if (newline) {
    for (const row of table.rows) {
      dump(rowObject(row), out, opts);
      out.write('\n');
    }
  } else {
    dump(table.rows.map(rowObject), out, opts);
  }
}

module.exports = { defaultStrDecimal, tableToJson };
