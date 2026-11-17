'use strict';
// Port of the database access csvsql and sql2csv do through SQLAlchemy 2.1.8 (MIT) and CPython 3.11's sqlite3
// module (PSF): create_engine() URL handling, the pysqlite dialect's connection setup, sqlite3's legacy transaction
// control and one-statement rule, and SQLAlchemy's wrapping of DB-API errors. Runs on node:sqlite.

const path = require('node:path');
const { pyError } = require('../pyerrors');
const { pyRepr, pyBytesRepr } = require('../pystr');
const { strToInt, strToFloat } = require('../pyunicode');
const { pyFloatRepr } = require('../pycsv');
const pyre = require('../pyre');
const warnings = require('../warnings');
const { registerSqlite340Functions } = require('./sqlite340');

const URL_PATTERN = new RegExp(String.raw`^([\p{L}\p{N}\p{Mn}\p{Pc}+]+)://(?:([^:/]*)(?::([^@]*))?@)?`
  + String.raw`(?:(?:\[([^/?]+)\]|([^/:?]+))?(?::([^/?]*))?)?(?:/([^?]*))?(?:\?(.*))?`, 'u');

// Dialect packages of SQLAlchemy and the driver modules each one exposes.
const DIALECT_DRIVERS = {
  sqlite: ['pysqlite', 'aiosqlite', 'pysqlcipher', 'base'],
  postgresql: ['psycopg2', 'psycopg', 'pg8000', 'asyncpg', 'psycopg2cffi', 'base'],
  mysql: ['mysqldb', 'pymysql', 'mysqlconnector', 'mariadbconnector', 'asyncmy', 'aiomysql', 'cymysql', 'pyodbc', 'base'],
  mariadb: ['mysqldb', 'pymysql', 'mysqlconnector', 'mariadbconnector', 'asyncmy', 'aiomysql', 'cymysql', 'pyodbc', 'base'],
  mssql: ['pyodbc', 'pymssql', 'aioodbc', 'mssqlpython', 'base'],
  oracle: ['oracledb', 'cx_oracle', 'base'],
};

// Keyword arguments create_engine() consumes for the pysqlite dialect, its pool and the Engine.
const ENGINE_KEYWORDS = new Set([
  'strategy', 'empty_in_strategy', '_is_async', '_coerce_config', 'module', 'enable_from_linting', 'connect_args',
  'pool', 'creator', 'poolclass', 'future', '_initialize', 'plugins', 'compiler_linting', 'dbapi', 'implicit_returning',
  'insertmanyvalues_page_size', 'isolation_level', 'json_deserializer', 'json_serializer', 'label_length',
  'max_identifier_length', 'native_datetime', 'paramstyle', 'server_side_cursors', 'skip_autocommit_rollback',
  'supports_native_boolean', 'use_insertmanyvalues', 'echo_pool', 'pool_logging_name', 'pool_size', 'pool_pre_ping',
  'pool_recycle', 'pool_reset_on_return', 'pool_events', 'dialect', 'echo', 'execution_options', 'hide_parameters',
  'logging_name', 'query_cache_size', 'url',
]);
const QUEUE_POOL_KEYWORDS = new Set(['max_overflow', 'pool_timeout', 'pool_use_lifo']);

const MISSING_BACKEND = "You don't appear to have the necessary database backend installed for connection string you're "
  + 'trying to use. Available backends include:\n\nPostgreSQL:\tpip install psycopg2\nMySQL:\t\tpip install '
  + 'mysql-connector-python OR pip install mysqlclient\n\nFor details on connection strings and other backends, '
  + 'please see the SQLAlchemy documentation on dialects at:\n\nhttps://www.sqlalchemy.org/docs/dialects/';

// sqlite3 exception classes by primary SQLite result code (CPython Modules/_sqlite/util.c) and the SQLAlchemy
// error-code suffix of the matching sqlalchemy.exc class.
const SQLITE_ERROR_CLASSES = {
  2: 'InternalError', 12: 'InternalError', 11: 'DatabaseError', 18: 'DataError',
  19: 'IntegrityError', 20: 'IntegrityError', 21: 'InterfaceError', 25: 'InterfaceError',
};
const ERROR_CODES = {
  OperationalError: 'e3q8', IntegrityError: 'gkpj', ProgrammingError: 'f405', InterfaceError: 'rvf5',
  DatabaseError: '4xp6', DataError: '9h9h', InternalError: '2j85',
};

/** An exception raised by a user-defined SQL function, which sqlite3 reports without its details. */
class UserFunctionError extends Error {}

/** The DB-API error sqlite3 raises, before SQLAlchemy wraps it. */
class DBAPIError extends Error {
  /**
   * @param {string} className the sqlite3 exception class name
   * @param {string} message
   */
  constructor(className, message) {
    super(message);
    this.className = className;
  }
}

/**
 * The sqlite3 exception for an error node:sqlite or a user function raised, by SQLite's primary result code.
 * @param {Error} e
 * @returns {DBAPIError}
 * @throws {Error} e itself when it is not a SQLite error (a fault in the port)
 */
function sqliteError(e) {
  if (e instanceof DBAPIError) return e;
  if (e instanceof UserFunctionError) {
    return new DBAPIError('OperationalError', e.message || 'user-defined function raised exception');
  }
  if (e.code === 'ERR_SQLITE_ERROR' && typeof e.errcode === 'number') {
    return new DBAPIError(SQLITE_ERROR_CLASSES[e.errcode & 0xff] || 'OperationalError', e.message);
  }
  throw e;
}

// sqlalchemy.sql.util._repr_base.trunc
function truncRepr(rep) {
  const chars = [...rep];
  if (chars.length <= 300) return rep;
  return `${chars.slice(0, 150).join('')} ... (${chars.length - 300} characters truncated) ... ${chars.slice(-150).join('')}`;
}

/** Python's repr() of a value bound to a statement. */
function paramRepr(value) {
  if (value === null) return 'None';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return pyFloatRepr(value);
  return pyRepr(value);
}

function tupleRepr(params) {
  const items = params.map((v) => truncRepr(paramRepr(v)));
  return `(${items.join(', ')}${items.length === 1 ? ',' : ''})`;
}

// sqlalchemy.sql.util._repr_params with batches=10, for positional parameter sets.
function paramsRepr(paramSets, ismulti) {
  if (!ismulti) return tupleRepr(paramSets[0]);
  if (paramSets.length > 10) {
    const head = paramSets.slice(0, 8).map(tupleRepr).join(', ');
    const tail = paramSets.slice(-2).map(tupleRepr).join(', ');
    return `[${head}  ... displaying 10 of ${paramSets.length} total bound parameter sets ...  ${tail}]`;
  }
  return `[${paramSets.map(tupleRepr).join(', ')}]`;
}

/**
 * Wraps a DB-API error the way SQLAlchemy's DBAPIError.instance() and StatementError.__str__ render it.
 * @param {DBAPIError} error
 * @param {string|null} statement
 * @param {Array[]} [paramSets]
 * @param {boolean} [ismulti]
 * @returns {Error}
 */
function wrapError(error, statement, paramSets = [], ismulti = false) {
  const lines = [`(sqlite3.${error.className}) ${error.message}`];
  if (statement) {
    lines.push(`[SQL: ${statement}]`);
    if (paramSets.length && (ismulti || paramSets[0].length)) lines.push(`[parameters: ${paramsRepr(paramSets, ismulti)}]`);
  }
  lines.push(`(Background on this error at: https://sqlalche.me/e/21/${ERROR_CODES[error.className]})`);
  return pyError(`sqlalchemy.exc.${error.className}`, lines.join('\n'));
}

/**
 * CPython's lstrip_sql(): skips whitespace and comments.
 * @param {string} sql
 * @param {number} [start]
 * @returns {number} the index of the first SQL character, or -1 when only whitespace and comments remain
 */
function lstripSql(sql, start = 0) {
  let i = start;
  while (i < sql.length) {
    const c = sql[i];
    if (c === ' ' || c === '\t' || c === '\f' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
    } else {
      return i;
    }
  }
  return -1;
}

function isDml(sql) {
  const i = lstripSql(sql);
  if (i < 0) return false;
  const head = sql.slice(i, i + 7).toLowerCase();
  return head.startsWith('insert') || head.startsWith('update') || head.startsWith('delete') || head === 'replace';
}

/**
 * The rows of a statement, read the way a sqlite3 cursor reads them: execute() steps to the first row, and each
 * fetch steps one row ahead of the row it returns. SQLAlchemy reports errors while fetching without the statement.
 */
class Result {
  /**
   * Steps to the first row at once, as cursor.execute() does.
   * @param {string[]|null} keys the column names, or null for a statement without rows
   * @param {Iterator<Array>|null} iterator node:sqlite's row iterator
   * @param {string} statement the SQL, for an error raised by the first step
   * @throws {Error} pyName sqlalchemy.exc.<DB-API error> when the first step fails
   */
  constructor(keys, iterator, statement) {
    this.keys = keys;
    this.returnsRows = keys !== null;
    this.iterator = iterator;
    this.pending = iterator ? this.step(statement) : null;
  }

  /**
   * Reads the next row.
   * @param {string|null} statement the SQL an error names (null while fetching)
   * @returns {Array|null} the row, or null after the last
   * @throws {Error} pyName sqlalchemy.exc.<DB-API error> when SQLite fails
   */
  step(statement) {
    try {
      const next = this.iterator.next();
      return next.done ? null : next.value;
    } catch (e) {
      throw wrapError(sqliteError(e), statement);
    }
  }

  /**
   * The rows, each read one step ahead.
   * @returns {Generator<Array>}
   * @throws {Error} as step()
   */
  * [Symbol.iterator]() {
    while (this.pending !== null) {
      const row = this.pending;
      this.pending = this.step(null);
      yield row;
    }
  }
}

/** A SQLAlchemy Connection to a SQLite database through the pysqlite dialect. */
class Connection {
  /** @param {object} db a node:sqlite DatabaseSync */
  constructor(db) {
    this.db = db;
  }

  /**
   * Compiles one statement, as sqlite3 does before running it.
   * @param {string} sql
   * @returns {object|null} the prepared statement, or null for SQL that compiles to nothing
   * @throws {DBAPIError} ProgrammingError "You can only execute one statement at a time." when SQL follows the
   *   first statement; node:sqlite's error for SQL that does not compile
   */
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    let source;
    try {
      source = stmt.sourceSQL;
      stmt.columns();
    } catch (e) {
      if (e.code === 'ERR_INVALID_STATE') return null;
      throw e;
    }
    if (lstripSql(sql, source.length) >= 0) {
      throw new DBAPIError('ProgrammingError', 'You can only execute one statement at a time.');
    }
    return stmt;
  }

  /**
   * Opens a transaction before INSERT, UPDATE, DELETE or REPLACE, as sqlite3's legacy transaction control does.
   * @param {string} sql
   * @returns {void}
   */
  beginIfDml(sql) {
    if (isDml(sql) && !this.db.isTransaction) this.db.exec('BEGIN ');
  }

  /**
   * Connection.exec_driver_sql(): runs one statement as sqlite3's cursor.execute() does.
   * @param {string} sql
   * @returns {Result}
   * @throws {Error} pyName sqlalchemy.exc.OperationalError, ProgrammingError, IntegrityError and the like, rendered
   *   with the statement as SQLAlchemy renders them
   */
  execDriverSql(sql) {
    try {
      const stmt = lstripSql(sql) < 0 ? null : this.prepare(sql);
      if (stmt === null) return new Result(null, null, sql);
      this.beginIfDml(sql);
      const columns = stmt.columns();
      stmt.setReadBigInts(true);
      if (!columns.length) {
        stmt.run();
        return new Result(null, null, sql);
      }
      stmt.setReturnArrays(true);
      return new Result(columns.map((c) => c.name), stmt.iterate(), sql);
    } catch (e) {
      throw wrapError(sqliteError(e), sql);
    }
  }

  /**
   * Executes a statement once per parameter set (cursor.execute() for one set, executemany() for more).
   * @param {string} sql
   * @param {Array[]} paramSets positional parameters
   * @returns {void}
   * @throws {Error} pyName sqlalchemy.exc.<DB-API error>, rendered with the statement and parameters
   */
  executeMany(sql, paramSets) {
    try {
      const stmt = this.prepare(sql);
      this.beginIfDml(sql);
      for (const params of paramSets) stmt.run(...params);
    } catch (e) {
      throw wrapError(sqliteError(e), sql, paramSets, paramSets.length > 1);
    }
  }

  /** Commits the DB-API transaction, if one is open. */
  commit() {
    if (this.db.isTransaction) this.db.exec('COMMIT');
  }

  /** Closes the connection; SQLAlchemy rolls back a transaction left open. */
  close() {
    if (this.db.isTransaction) this.db.exec('ROLLBACK');
    this.db.close();
  }
}

function loadSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    if (type !== 'ExperimentalWarning') emitWarning.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

// Where the pysqlite dialect's regexp() calls re.search(), the location of the warnings it emits.
const REGEXP_SITE = {
  file: `${warnings.SITE_PACKAGES}/sqlalchemy/dialects/sqlite/pysqlite.py`,
  line: 718,
  source: '  return re.search(a, b) is not None',
};

// The functions SQLAlchemy's pysqlite dialect registers on each new connection (regexp and floor).
function registerPysqliteFunctions(db) {
  db.function('regexp', { deterministic: true, varargs: false }, (pattern, string) => {
    if (string === null) return null;
    if (typeof pattern !== 'string' || typeof string !== 'string') throw new UserFunctionError();
    try {
      const compiled = pyre.compile(pattern, {
        warn: (category, message) => warnings.warn(REGEXP_SITE.file, REGEXP_SITE.line, category, message, REGEXP_SITE.source),
      });
      return compiled.search(string) ? 1n : 0n;
    } catch (e) {
      throw new UserFunctionError();
    }
  });
  db.function('floor', { deterministic: true, useBigIntArguments: true }, (x) => {
    if (typeof x === 'bigint') return x;
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new UserFunctionError();
    const value = BigInt(Math.floor(x));
    if (value > 0x7fffffffffffffffn || value < -0x8000000000000000n) throw new UserFunctionError();
    return value;
  });
}

// urllib.parse.unquote_to_bytes over ASCII text: each %XX becomes its byte, any other % stays.
function unquoteToBytes(text) {
  const [first, ...items] = text.split('%');
  const bytes = [Buffer.from(first, 'latin1')];
  for (const item of items) {
    if (/^[0-9a-fA-F]{2}/.test(item)) {
      bytes.push(Buffer.from([parseInt(item.slice(0, 2), 16)]), Buffer.from(item.slice(2), 'latin1'));
    } else {
      bytes.push(Buffer.from(`%${item}`, 'latin1'));
    }
  }
  return Buffer.concat(bytes);
}

// urllib.parse.unquote(text) (UTF-8, errors='replace'): each run of ASCII characters is unquoted and decoded on its
// own, so a malformed escape stays as it is and undecodable bytes become U+FFFD.
function unquote(text) {
  if (!text.includes('%')) return text;
  return text.replace(/[\x00-\x7f]+/g, (run) => unquoteToBytes(run).toString('utf8'));
}

// The components of a SQLAlchemy URL (sqlalchemy.engine.url._parse_url), the query as a Map of each key to its
// value, or to an array (a tuple) of its values when the key is repeated.
function parseUrl(url) {
  const m = URL_PATTERN.exec(url);
  if (!m) throw pyError('sqlalchemy.exc.ArgumentError', 'Could not parse SQLAlchemy URL from given URL string');
  const [, drivername, username, password, ipv6host, ipv4host, port, database, query] = m;
  let parsedQuery = null;
  if (query !== undefined) {
    parsedQuery = new Map();
    for (const [key, value] of parseQuery(query)) {
      if (parsedQuery.has(key)) parsedQuery.set(key, [].concat(parsedQuery.get(key), value));
      else parsedQuery.set(key, value);
    }
  }
  return {
    drivername,
    username: username === undefined ? null : unquote(username),
    password: password === undefined ? null : unquote(password),
    host: ipv4host || ipv6host || null,
    // URL.create() reads the port with int().
    port: port ? strToInt(port) : null,
    database: database === undefined ? null : unquote(database),
    query: parsedQuery,
  };
}

// urllib.parse.parse_qsl(query) without blank values, as a list of [key, value] pairs.
function parseQuery(query) {
  const unquotePlus = (text) => unquote(text.replaceAll('+', ' '));
  return query.split('&').map((part) => part.split(/=(.*)/s)).filter((nv) => nv.length > 1 && nv[1])
    .map(([key, value]) => [unquotePlus(key), unquotePlus(value)]);
}

// urllib.parse.quote(text, safe): UTF-8 bytes other than letters, digits, '_.-~' and the safe characters as %XX.
function quote(text, safe) {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~]/.test(c) || safe.includes(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// urllib.parse.quote_plus(text): quote() with spaces as '+'.
function quotePlus(text) {
  return quote(text, ' ').replaceAll(' ', '+');
}

// str() of a URL query value: a string, or the repr of a tuple of strings.
function queryValueStr(value) {
  return Array.isArray(value) ? `(${value.map(pyRepr).join(', ')})` : value;
}

// sqlalchemy.util.asbool: a tuple of values is true.
function asBool(text) {
  if (Array.isArray(text)) return true;
  const t = text.trim().toLowerCase();
  if (['true', 'yes', 'on', 'y', 't', '1'].includes(t)) return true;
  if (['false', 'no', 'off', 'n', 'f', '0'].includes(t)) return false;
  throw pyError('ValueError', `String is not true/false: ${pyRepr(text)}`);
}

// float() and int() of a URL query value, which is a tuple for a repeated key.
function queryFloat(value) {
  if (Array.isArray(value)) throw pyError('TypeError', "float() argument must be a string or a real number, not 'tuple'");
  return strToFloat(value);
}
function queryInt(value) {
  if (Array.isArray(value)) {
    throw pyError('TypeError', "int() argument must be a string, a bytes-like object or a real number, not 'tuple'");
  }
  return strToInt(value);
}

// The URL query arguments the pysqlite dialect passes to sqlite3.connect(), with their coercions.
const PYSQLITE_ARGS = {
  uri: asBool, timeout: queryFloat, isolation_level: queryValueStr, detect_types: queryInt, check_same_thread: asBool,
  cached_statements: queryInt,
};

// SQLiteDialect_pysqlite.create_connect_args(): the database to open, and whether it is a file database (which
// gets a QueuePool rather than a SingletonThreadPool).
function sqliteConnectArgs(parsed, caller) {
  const opts = parsed.query || new Map();
  const coerced = {};
  for (const [key, coerce] of Object.entries(PYSQLITE_ARGS)) if (opts.has(key)) coerced[key] = coerce(opts.get(key));
  let filename;
  if (coerced.uri) {
    const uriOpts = [...opts.keys()].filter((k) => !(k in PYSQLITE_ARGS)).sort();
    filename = (parsed.database || '')
      + (uriOpts.length ? `?${uriOpts.map((k) => `${k}=${queryValueStr(opts.get(k))}`).join('&')}` : '');
  } else {
    const ignored = [...opts.keys()].filter((k) => !(k in PYSQLITE_ARGS)).sort();
    if (ignored.length) {
      warnings.warn(caller.file, caller.line, 'SAWarning', `Query string argument(s) ${ignored.map((k) => `'${k}'`).join(', ')} `
        + 'are not accepted by the pysqlite driver and are being ignored; SQLite URI arguments require that '
        + "'uri=true' also be present in the URL. (Background on this warning at: https://sqlalche.me/e/21/squa)",
      caller.source);
    }
    filename = parsed.database || ':memory:';
    if (filename !== ':memory:') filename = path.resolve(filename);
  }
  const fileDb = Boolean(parsed.database) && parsed.database !== ':memory:' && opts.get('mode') !== 'memory';
  return { filename, fileDb };
}

/**
 * The keyword names of csvkit's parse_list() over --engine-option pairs, in dictionary order.
 * @param {Array<[string, string]>} pairs
 * @returns {string[]}
 */
function parseEngineOptions(pairs) {
  return [...new Set((pairs || []).map(([key]) => key))];
}

// URL.__str__ (render_as_string) with the password hidden.
function renderUrl(parsed) {
  let text = `${parsed.drivername}://`;
  if (parsed.username !== null) {
    text += quote(parsed.username, ' +');
    if (parsed.password !== null) text += ':***';
    text += '@';
  }
  if (parsed.host) text += parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host;
  if (parsed.port !== null) text += `:${parsed.port}`;
  if (parsed.database !== null) text += `/${quote(parsed.database, ' +/')}`;
  if (parsed.query && parsed.query.size) {
    const keys = [...parsed.query.keys()].sort();
    text += `?${keys.flatMap((k) => [].concat(parsed.query.get(k)).map((v) => `${quotePlus(k)}=${quotePlus(v)}`)).join('&')}`;
  }
  return text;
}

/**
 * create_engine() followed by engine.connect(), for the SQLite databases csvsql and sql2csv can reach.
 * @param {string} url a SQLAlchemy connection string
 * @param {string[]} engineOptions create_engine() keyword names
 * @param {{file: string, line: number, source: string}} caller the create_engine() call, where warnings point
 * @returns {Connection}
 * @throws {Error} pyName sqlalchemy.exc.NoSuchModuleError for an unknown dialect or driver, ImportError for a
 *   dialect whose driver is not installed (every backend but SQLite), sqlalchemy.exc.ArgumentError for a SQLite
 *   URL with a host or credentials, TypeError for engine options create_engine() rejects, and
 *   sqlalchemy.exc.OperationalError when the database cannot be opened
 */
function connect(url, engineOptions, caller) {
  const parsed = parseUrl(url);
  const [backend, driver = 'base'] = parsed.drivername.split('+');
  const drivers = DIALECT_DRIVERS[backend];
  if (!drivers || !drivers.includes(driver) || parsed.drivername.split('+').length > 2) {
    throw pyError('sqlalchemy.exc.NoSuchModuleError', `Can't load plugin: sqlalchemy.dialects:${parsed.drivername.replace('+', '.')}`);
  }
  if (backend !== 'sqlite' || (driver !== 'pysqlite' && driver !== 'base')) throw pyError('ImportError', MISSING_BACKEND);
  if (parsed.username || parsed.password || parsed.host || parsed.port) {
    throw pyError('sqlalchemy.exc.ArgumentError', `Invalid SQLite URL: ${renderUrl(parsed)}\nValid SQLite URL forms are:\n`
      + ' sqlite:///:memory: (or, sqlite://)\n sqlite:///relative/path/to/file.db\n sqlite:////absolute/path/to/file.db');
  }
  const { filename, fileDb } = sqliteConnectArgs(parsed, caller);
  const invalid = engineOptions.filter((k) => !ENGINE_KEYWORDS.has(k) && !(fileDb && QUEUE_POOL_KEYWORDS.has(k)));
  if (invalid.length) {
    throw pyError('TypeError', `Invalid argument(s) ${invalid.map((k) => `'${k}'`).join(',')} sent to create_engine(), `
      + `using configuration SQLiteDialect_pysqlite/${fileDb ? 'QueuePool' : 'SingletonThreadPool'}/Engine.  `
      + 'Please check that the keyword arguments are appropriate for this combination of components.');
  }
  // sqlite3.connect() converts the path with os.fsencode(), which rejects NUL
  if (filename.includes('\0')) throw pyError('ValueError', 'embedded null byte');
  const { DatabaseSync } = loadSqlite();
  let db;
  try {
    db = new DatabaseSync(filename, { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true });
  } catch (e) {
    throw wrapError(sqliteError(e), null);
  }
  registerPysqliteFunctions(db);
  registerSqlite340Functions(db, UserFunctionError);
  return new Connection(db);
}

/**
 * A value read from SQLite as the CSV writer prints the Python object sqlite3 returns for it.
 * @param {null|bigint|number|string|Uint8Array} value
 * @returns {*}
 */
function csvValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return { isDecimal: false, pyStr: () => pyFloatRepr(value) };
  if (value instanceof Uint8Array) return pyBytesRepr(value);
  return value;
}

module.exports = { connect, parseEngineOptions, csvValue, Connection };
