#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvjson (csvkit 2.2.0, MIT).
const { Utility } = require('../lib/cli');
const { addSniffAndInference } = require('../lib/common');
const { dump } = require('../lib/pyjson');
const { defaultStrDecimal, tableToJson } = require('../lib/json-output');
const { GeoJsonGenerator } = require('../lib/geojson');
const { pyError } = require('../lib/pyerrors');
const { agateReader } = require('../lib/table');

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
   * CSVJSON.output_json: agate.Table.to_json(output, key=args.key, newline=args.streamOutput, indent=args.indent).
   * @returns {void}
   * @throws {Error} pyName ValueError for -k with --stream, --stream with -i or a duplicate key value; KeyError for
   *   a -k column the table does not have
   */
  outputJson() {
    const table = this.readCsvToTable();
    tableToJson(table, this.out, { key: this.args.key, newline: this.args.streamOutput, indent: this.args.indent });
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
