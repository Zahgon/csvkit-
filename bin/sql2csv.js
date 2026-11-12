#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.sql2csv (csvkit 2.2.0, MIT).

const { Utility } = require('../lib/cli');
const { LineWriter } = require('../lib/table');
const { pyStrip } = require('../lib/pystr');
const { connect, parseEngineOptions, csvValue } = require('../lib/sql/engine');
const { SITE_PACKAGES } = require('../lib/warnings');

// Where csvkit calls create_engine(), the location SQLAlchemy's warnings report.
const CREATE_ENGINE_CALL = {
  file: `${SITE_PACKAGES}/csvkit/utilities/sql2csv.py`,
  line: 59,
  source: '  engine = create_engine(self.args.connection_string, **parse_list(self.args.engine_option))',
};

/** sql2csv: runs a SQL query on a database and prints its rows as CSV. */
class SQL2CSV extends Utility {
  constructor() {
    super('sql2csv', 'Execute a SQL query on a database and output the result to a CSV file.', '',
      ['f', 'b', 'd', 'e', 'H', 'I', 'K', 'L', 'p', 'q', 'S', 't', 'u', 'z', 'zero', 'add-bom']);
  }

  /**
   * SQL2CSV.add_arguments: --db, --engine-option, --execution-option, FILE, --query, -e and -H.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['--db'], { dest: 'connection_string', default: 'sqlite://', help: 'A SQLAlchemy connection string to connect to a database.' });
    p.addArgument(['--engine-option'], { dest: 'engine_option', nargs: 2, metavar: 'ENGINE_OPTION', action: 'append', default: [], help: "A keyword argument to SQLAlchemy's create_engine(), as a space-separated pair. This option can be specified multiple times. For example: thick_mode True" });
    p.addArgument(['--execution-option'], { dest: 'execution_option', nargs: 2, action: 'append', help: "A keyword argument to SQLAlchemy's execution_options(), as a space-separated pair. This option can be specified multiple times. For example: stream_results True" });
    p.addArgument(['FILE'], { metavar: 'FILE', nargs: '?', dest: 'input_path', help: 'The file to use as SQL query. If FILE and --query are omitted, the query is piped data via STDIN.' });
    p.addArgument(['--query'], { dest: 'query', help: 'The SQL query to execute. Overrides FILE and STDIN.' });
    p.addArgument(['-e', '--encoding'], { dest: 'encoding', default: 'utf-8', help: 'Specify the encoding of the input query file.' });
    p.addArgument(['-H', '--no-header-row'], { dest: 'no_header_row', action: 'store_true', help: 'Do not output column names.' });
  }

  /**
   * sql2csv keeps none of the input options Utility.run acts on, so it only runs main().
   * @returns {void}
   */
  run() { this.main(); }

  /**
   * SQL2CSV.main: the query from --query, else from FILE or standard input.
   * @returns {void}
   * @throws {ExitError} with status 2 when there is no query and standard input is a terminal
   * @throws {Error} pyName the errors connect() and Connection.execDriverSql() raise, and the query file's
   *   decoding errors
   */
  main() {
    const a = this.args;
    if (this.additionalInputExpected() && !a.query) this.argparser.error('You must provide an input file or piped data.');
    const conn = connect(a.connection_string, parseEngineOptions(a.engine_option), CREATE_ENGINE_CALL);
    try {
      let query;
      if (a.query) {
        query = pyStrip(a.query);
      } else {
        query = [...this.openInputFile(a.input_path).lines()].join('');
      }
      const result = conn.execDriverSql(query);
      const out = new LineWriter(this.out, this.writer_kwargs);
      if (result.returnsRows) {
        if (!a.no_header_row) out.writerow(result.keys);
        for (const row of result) out.writerow(row.map(csvValue));
      }
    } finally {
      conn.close();
    }
  }
}

new SQL2CSV().launch();
