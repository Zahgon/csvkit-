#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvformat (csvkit 2.2.0, MIT).

const { Utility, QUOTING_CHOICES, makeDefaultHeaders } = require('../lib/cli');
const { pyError } = require('../lib/pyerrors');
const { LineWriter, agateReader } = require('../lib/table');

/** csvformat: rewrites a CSV file with another dialect (delimiter, quoting, escaping, line terminator). */
class CSVFormat extends Utility {
  constructor() {
    super('csvformat', 'Convert a CSV file to a custom output format.', '', ['I']);
  }

  /**
   * CSVFormat.add_arguments: the output dialect options.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['-E', '--skip-header'], { dest: 'skip_header', action: 'store_true', help: 'Do not output a header row.' });
    p.addArgument(['-D', '--out-delimiter'], { dest: 'out_delimiter', help: 'Delimiting character of the output file.' });
    p.addArgument(['-T', '--out-tabs'], { dest: 'out_tabs', action: 'store_true', help: 'Specify that the output file is delimited with tabs. Overrides "-D".' });
    p.addArgument(['-A', '--out-asv'], { dest: 'out_asv', action: 'store_true', help: 'Specify that the output file is delimited with the ASCII unit separator and record separator. Overrides "-T", "-D" and "-M".' });
    p.addArgument(['-Q', '--out-quotechar'], { dest: 'out_quotechar', help: 'Character used to quote strings in the output file.' });
    p.addArgument(['-U', '--out-quoting'], { dest: 'out_quoting', type: 'int', choices: QUOTING_CHOICES, help: 'Quoting style used in the output file: 0 quote minimal, 1 quote all, 2 quote non-numeric, 3 quote none.' });
    p.addArgument(['-B', '--out-no-doublequote'], { dest: 'out_doublequote', action: 'store_false', help: 'Whether or not double quotes are doubled in the output file.' });
    p.addArgument(['-P', '--out-escapechar'], { dest: 'out_escapechar', help: 'Character used to escape the delimiter in the output file if --quoting 3 ("Quote None") is specified and to escape the QUOTECHAR if --out-no-doublequote is specified.' });
    p.addArgument(['-M', '--out-lineterminator'], { dest: 'out_lineterminator', help: 'Character used to terminate lines in the output file.' });
  }

  /**
   * CSVFormat._extract_csv_writer_kwargs: the output dialect from the -D, -T, -Q, -U, -B, -P and -M options.
   * @returns {object} csv writer options
   */
  writerKwargs() {
    const a = this.args;
    const k = {};
    if (a.line_numbers) k.lineNumbers = true;
    if (a.out_asv) k.delimiter = '\x1f';
    else if (a.out_tabs) k.delimiter = '\t';
    else if (a.out_delimiter) k.delimiter = a.out_delimiter;
    if (a.out_asv) k.lineterminator = '\x1e';
    else if (a.out_lineterminator) k.lineterminator = a.out_lineterminator;
    for (const arg of ['quotechar', 'quoting', 'doublequote', 'escapechar']) {
      const v = a[`out_${arg}`];
      if (v !== null && v !== undefined) k[arg] = v;
    }
    return k;
  }

  /**
   * CSVFormat.main.
   * @returns {void}
   * @throws {Error} pyName StopIteration for -H on an empty input, TypeError for an invalid output
   *   dialect, and the csv reader's and writer's _csv.Error
   */
  main() {
    if (this.additionalInputExpected()) process.stderr.write('No input file or piped data provided. Waiting for standard input:\n');
    const writer = new LineWriter(this.out, this.writer_kwargs);
    if (this.args.out_quoting === 2) {
      const t = this.tableFromCsv(this.input_file, { skipLines: this.args.skip_lines, columnTypes: this.getColumnTypes(), kwargs: this.reader_kwargs });
      if (!this.args.skip_header) writer.writerow(t.columnNames);
      writer.writerows(t.rows.map((r) => r.map((v) => (v && v.isDecimal ? { pyStr: () => v.pyStr(), isDecimal: true } : v))));
    } else {
      let reader = agateReader(this.skipLines().lines(), this.reader_kwargs);
      // next(reader), which raises StopIteration at the end
      const next = (it) => {
        const r = it.next();
        if (r.done) throw pyError('StopIteration', '');
        return r;
      };
      if (this.args.no_header_row) {
        const r = next(reader);
        const headers = makeDefaultHeaders(r.value.length);
        const rest = reader;
        reader = (function* chain() { yield headers; yield r.value; yield* rest; }());
      }
      if (this.args.skip_header) next(reader);
      for (const row of reader) writer.writerow(row);
    }
  }
}

new CSVFormat().launch();
