#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvpy (csvkit 2.2.0, MIT).

const repl = require('node:repl');
const { Readable } = require('node:stream');
const { Utility, readBytes, stdinIsTTY } = require('../lib/cli');
const { addSniffAndInference } = require('../lib/common');
const { agateReader } = require('../lib/table');
const { DictReader } = require('../lib/dict-csv');

/** csvpy: loads a CSV file into a reader, an agate Table or a DictReader and opens an interactive console on it. */
class CSVPy extends Utility {
  constructor() {
    super('csvpy', 'Load a CSV file into a CSV reader and then drop into a Python shell.', '', ['l', 'zero', 'add-bom']);
  }

  /**
   * CSVPy.add_arguments: --dict, --agate, --no-number-ellipsis, -y and -I.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['--dict'], { dest: 'as_dict', action: 'store_true', help: 'Load the CSV file into a DictReader.' });
    p.addArgument(['--agate'], { dest: 'as_agate', action: 'store_true', help: 'Load the CSV file into an agate table.' });
    p.addArgument(['--no-number-ellipsis'], { dest: 'no_number_ellipsis', action: 'store_true', help: 'Disable the ellipsis if the max precision is exceeded.' });
    addSniffAndInference(p);
  }

  /**
   * CSVPy.main: prints the banner and runs the console on standard input.
   * @returns {void}
   * @throws {ExitError} with status 2 when the input is standard input (csvpy needs a file)
   */
  main() {
    if (this.input_file.isStdin) this.argparser.error('csvpy cannot accept input as piped data via STDIN.');
    const f = this.input_file;
    // The original reads input_file.name first, which opens its LazyFile: a missing or unreadable file fails here.
    f.load();
    let variable;
    let welcome;
    if (this.args.as_dict) {
      variable = new DictReader(this.skipLines().lines(), this.reader_kwargs);
      welcome = `Welcome! "${f.name}" has been loaded in an agate.csv.DictReader object named "reader".`;
    } else if (this.args.as_agate) {
      variable = this.tableFromCsv(f, { skipLines: this.args.skip_lines, sniffLimit: this.args.sniff_limit !== -1 ? this.args.sniff_limit : null, columnTypes: this.getColumnTypes(), kwargs: this.reader_kwargs });
      welcome = `Welcome! "${f.name}" has been loaded in an agate.Table object named "table".`;
    } else {
      variable = [...agateReader(this.skipLines().lines(), this.reader_kwargs)];
      welcome = `Welcome! "${f.name}" has been loaded in an agate.csv.reader object named "reader".`;
    }
    // code.interact(): the banner goes to stderr; at end of input the console prints a newline and its exit message.
    process.stderr.write(`${welcome}\n`);
    let input = process.stdin;
    if (!stdinIsTTY()) {
      const text = readBytes(null).toString('utf8');
      if (text === '') {
        this.out.write('>>> ');
        process.stderr.write('\nnow exiting InteractiveConsole...\n');
        return;
      }
      input = Readable.from([text]);
    }
    const r = repl.start({ prompt: '>>> ', input, output: process.stdout });
    r.context[this.args.as_agate && !this.args.as_dict ? 'table' : 'reader'] = variable;
    r.on('exit', () => process.stderr.write('\nnow exiting InteractiveConsole...\n'));
  }
}

new CSVPy().launch();
