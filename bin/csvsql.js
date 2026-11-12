#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvsql (csvkit 2.2.0, MIT).

const fs = require('node:fs');
const path = require('node:path');
const { Utility, stdinIsTTY } = require('../lib/cli');
const { pyError } = require('../lib/pyerrors');
const { LineWriter } = require('../lib/table');
const { addSniffAndInference } = require('../lib/common');
const { connect, parseEngineOptions, csvValue } = require('../lib/sql/engine');
const { createStatement } = require('../lib/sql/ddl');
const { toSql } = require('../lib/sql/to-sql');
const warnings = require('../lib/warnings');

const DIALECTS = ['mssql', 'mysql', 'oracle', 'postgresql', 'sqlite'];

// Where csvkit calls create_engine(), the location SQLAlchemy's warnings report.
const CREATE_ENGINE_CALL = {
  file: `${warnings.SITE_PACKAGES}/csvkit/utilities/csvsql.py`,
  line: 149,
  source: '  engine = create_engine(self.args.connection_string, **parse_list(self.args.engine_option))',
};

/** csvsql: prints CREATE TABLE statements for CSV files, or loads them into a database and runs queries on it. */
class CSVSQL extends Utility {
  constructor() {
    super('csvsql', 'Generate SQL statements for one or more CSV files, or execute those statements directly on a database, and execute one or more SQL queries.', '', ['f']);
  }

  /**
   * CSVSQL.add_arguments: the files, the dialect and database options, the insert options, the table options, -y,
   * -I and the column length options.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['FILE'], { metavar: 'FILE', nargs: '*', dest: 'input_paths', default: ['-'], help: 'The CSV file(s) to operate on. If omitted, will accept input as piped data via STDIN.' });
    p.addArgument(['-i', '--dialect'], { dest: 'dialect', choices: DIALECTS, help: 'Dialect of SQL to generate. Cannot be used with --db.' });
    p.addArgument(['--db'], { dest: 'connection_string', help: 'If present, a SQLAlchemy connection string to use to directly execute generated SQL on a database.' });
    p.addArgument(['--engine-option'], { dest: 'engine_option', nargs: 2, action: 'append', default: [], help: "A keyword argument to SQLAlchemy's create_engine(), as a space-separated pair. This option can be specified multiple times. For example: thick_mode True" });
    p.addArgument(['--query'], { dest: 'queries', action: 'append', help: 'Execute one or more SQL queries delimited by --sql-delimiter, and output the result of the last query as CSV. QUERY may be a filename. --query may be specified multiple times.' });
    p.addArgument(['--insert'], { dest: 'insert', action: 'store_true', help: 'Insert the data into the table. Requires --db.' });
    p.addArgument(['--prefix'], { dest: 'prefix', action: 'append', default: [], help: 'Add an expression following the INSERT keyword, like OR IGNORE or OR REPLACE.' });
    p.addArgument(['--before-insert'], { dest: 'before_insert', help: 'Before the INSERT command, execute one or more SQL queries delimited by --sql-delimiter. Requires --insert.' });
    p.addArgument(['--after-insert'], { dest: 'after_insert', help: 'After the INSERT command, execute one or more SQL queries delimited by --sql-delimiter. Requires --insert.' });
    p.addArgument(['--sql-delimiter'], { dest: 'sql_delimiter', default: ';', help: 'Delimiter separating SQL queries in --query, --before-insert, and --after-insert.' });
    p.addArgument(['--tables'], { dest: 'table_names', help: 'A comma-separated list of names of tables to be created. By default, the tables will be named after the filenames without extensions or "stdin".' });
    p.addArgument(['--no-constraints'], { dest: 'no_constraints', action: 'store_true', help: 'Generate a schema without length limits or null checks. Useful when sampling big tables.' });
    p.addArgument(['--unique-constraint'], { dest: 'unique_constraint', help: 'A column-separated list of names of columns to include in a UNIQUE constraint.' });
    p.addArgument(['--no-create'], { dest: 'no_create', action: 'store_true', help: 'Skip creating the table. Requires --insert.' });
    p.addArgument(['--create-if-not-exists'], { dest: 'create_if_not_exists', action: 'store_true', help: 'Create the table if it does not exist, otherwise keep going. Requires --insert.' });
    p.addArgument(['--overwrite'], { dest: 'overwrite', action: 'store_true', help: 'Drop the table if it already exists. Requires --insert. Cannot be used with --no-create.' });
    p.addArgument(['--db-schema'], { dest: 'db_schema', help: 'Optional name of database schema to create table(s) in.' });
    addSniffAndInference(p);
    p.addArgument(['--chunk-size'], { dest: 'chunk_size', type: 'int', help: 'Chunk size for batch insert into the table. Requires --insert.' });
    p.addArgument(['--min-col-len'], { dest: 'min_col_len', type: 'int', default: 1, help: 'The minimum length of text columns.' });
    p.addArgument(['--col-len-multiplier'], { dest: 'col_len_multiplier', type: 'int', default: 1, help: 'Multiply the maximum column length by this multiplier to accomodate larger values in later runs.' });
  }

  /**
   * CSVSQL.run: like Utility.run but without opening a single input file (csvsql opens each of its FILE arguments).
   * @returns {void}
   * @throws {Error} whatever main() raises
   */
  run() {
    if (this.args.add_bom) this.out.write('\ufeff');
    if (this.args.no_header_row) warnings.ignore('Column names not specified');
    this.main();
  }

  /**
   * CSVSQL.main: checks the option combinations, connects with --db (an in-memory SQLite database for --query alone)
   * and closes the connection afterwards.
   * @returns {void}
   * @throws {ExitError} with status 2 for an invalid option combination or no input on a terminal
   * @throws {Error} pyName the errors connect() raises, and failsafeMain()'s
   */
  main() {
    const a = this.args;
    const err = (m) => this.argparser.error(m);
    if (stdinIsTTY() && a.input_paths.length === 1 && a.input_paths[0] === '-') err('You must provide an input file or piped data.');
    const tableNames = a.table_names ? a.table_names.split(',') : [];
    const unique = a.unique_constraint ? a.unique_constraint.split(',') : [];
    if (a.queries && !a.connection_string) { a.connection_string = 'sqlite:///:memory:'; a.insert = true; }
    if (a.dialect && a.connection_string) err('The --dialect option is only valid when neither --db nor --query are specified.');
    if (a.insert && !a.connection_string) err('The --insert option is only valid when either --db or --query is specified.');
    if (a.no_create && !a.insert) err('The --no-create option is only valid if --insert is also specified.');
    if (a.create_if_not_exists && !a.insert) err('The --create-if-not-exists option is only valid if --insert is also specified.');
    if (a.overwrite && !a.insert) err('The --overwrite option is only valid if --insert is also specified.');
    if (a.overwrite && a.no_create) err('The --overwrite option is only valid if --no-create is not specified.');
    if (a.before_insert && !a.insert) err('The --before-insert option is only valid if --insert is also specified.');
    if (a.after_insert && !a.insert) err('The --after-insert option is only valid if --insert is also specified.');
    if (a.chunk_size && !a.insert) err('The --chunk-size option is only valid if --insert is also specified.');
    if (a.no_create && a.create_if_not_exists) err('The --no-create and --create-if-not-exists options are mutually exclusive.');
    const files = a.input_paths.map((p) => this.openInputFile(p));
    let conn = null;
    if (a.connection_string) conn = connect(a.connection_string, parseEngineOptions(a.engine_option), CREATE_ENGINE_CALL);
    try {
      this.failsafeMain(files, conn, tableNames, unique);
    } finally {
      if (conn) conn.close();
    }
  }

  /**
   * CSVSQL._failsafe_main: one table per input file with rows, printed as CREATE TABLE or written to the database,
   * then the --query statements, the last one's rows printed as CSV.
   * @param {InputFile[]} files
   * @param {Connection|null} conn the database connection, or null to print statements
   * @param {string[]} tableNames the --tables names still unused
   * @param {string[]} unique the --unique-constraint columns
   * @returns {void}
   * @throws {Error} pyName ValueError for an empty --sql-delimiter, AttributeError when --query holds only blank
   *   statements, the sqlalchemy.exc errors of the statements, and the reader's and casts' errors
   */
  failsafeMain(files, conn, tableNames, unique) {
    const a = this.args;
    const runAll = (queries) => {
      for (const q of pySplit(queries, a.sql_delimiter)) conn.execDriverSql(q);
    };
    for (const f of files) {
      const name = tableNames.length ? tableNames.shift() : f.isStdin ? 'stdin' : splitext(path.basename(f.name));
      const table = this.tableFromCsv(f, {
        skipLines: a.skip_lines,
        sniffLimit: a.sniff_limit !== -1 ? a.sniff_limit : null,
        columnTypes: this.getColumnTypes(),
        kwargs: this.reader_kwargs,
      });
      if (!table.rows.length) continue;
      if (conn) {
        if (a.before_insert) runAll(a.before_insert);
        toSql(table, conn, name, {
          overwrite: a.overwrite,
          create: !a.no_create,
          createIfNotExists: a.create_if_not_exists,
          insert: a.insert,
          prefixes: a.prefix,
          dbSchema: a.db_schema,
          constraints: !a.no_constraints,
          uniqueConstraint: unique,
          chunkSize: a.chunk_size,
          minColLen: a.min_col_len,
          colLenMultiplier: a.col_len_multiplier,
        });
        if (a.after_insert) runAll(a.after_insert);
      } else {
        const statement = createStatement(table, name, {
          dialect: a.dialect, dbSchema: a.db_schema, constraints: !a.no_constraints, uniqueConstraint: unique,
        });
        this.out.write(`${statement}\n`);
      }
    }
    if (!conn) return;
    if (a.queries) {
      let queries = [];
      for (let q of a.queries) {
        if (fs.existsSync(q)) q = fs.readFileSync(q, 'utf8');
        queries = queries.concat(pySplit(q, a.sql_delimiter));
      }
      let result = null;
      for (const q of queries) if (q.trim()) result = conn.execDriverSql(q);
      if (result === null) throw pyError('AttributeError', "'NoneType' object has no attribute 'returns_rows'");
      if (result.returnsRows) {
        const out = new LineWriter(this.out, this.writer_kwargs);
        out.writerow(result.keys);
        for (const row of result) out.writerow(row.map(csvValue));
      }
    }
    conn.commit();
  }
}

// Python's str.split(sep).
function pySplit(text, sep) {
  if (sep === '') throw pyError('ValueError', 'empty separator');
  return text.split(sep);
}

// os.path.splitext(name)[0]: drops the last extension unless the name only starts with a dot.
function splitext(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || /^\.+$/.test(name.slice(0, dot))) return name;
  return name.slice(0, dot);
}

new CSVSQL().launch();
