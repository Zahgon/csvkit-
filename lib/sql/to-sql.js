'use strict';
// Port of agatesql.table.to_sql (agate-sql 0.7.3, MIT) for SQLite, with the parts of SQLAlchemy 2.1.8 (MIT) it
// drives: Table.drop()/create() with checkfirst, the compiled INSERT statement, and the SQLite dialect's bind
// processors (how each agate value is stored).

const T = require('../types');
const { pyError } = require('../pyerrors');
const { IdentifierPreparer, makeSqlTable, compileCreateTable, compileDropTable } = require('./ddl');

const pad = (n, width = 2) => String(n).padStart(width, '0');

function formatDate(y, m, d) {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

// SQLite DATETIME storage format: "%Y-%m-%d %H:%M:%S.%f".
function formatDateTime(y, mo, d, h, mi, s, us) {
  return `${formatDate(y, mo, d)} ${pad(h)}:${pad(mi)}:${pad(s)}.${pad(us, 6)}`;
}

// sqlalchemy.types.Interval stores a timedelta as the datetime 1970-01-01 + delta.
function intervalValue(delta) {
  const us = ((delta.us % 1e6) + 1e6) % 1e6;
  const date = new Date((delta.us - us) / 1000);
  return formatDateTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(),
    date.getUTCMinutes(), date.getUTCSeconds(), us);
}

/**
 * The value the SQLite dialect's bind processor hands to sqlite3 for an agate value.
 * @param {*} value
 * @returns {null|bigint|number|string}
 */
function bindValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (value.isDecimal) return value.toNumber();
  if (value instanceof T.PyDate) return formatDate(value.y, value.m, value.d);
  if (value instanceof T.PyDateTime) return formatDateTime(value.y, value.mo, value.d, value.h, value.mi, value.s, value.us);
  if (value instanceof T.PyTimeDelta) return intervalValue(value);
  return value;
}

// SQLiteDialect.has_table(), with the queries it runs.
function hasTable(conn, name, schema) {
  const preparer = new IdentifierPreparer('sqlite');
  if (schema !== null) {
    const names = [...conn.execDriverSql('PRAGMA database_list')].map((row) => row[1]);
    if (!names.includes(schema)) return false;
  }
  const prefixes = schema !== null ? [`PRAGMA ${preparer.quoteIdentifier(schema)}.`] : ['PRAGMA main.', 'PRAGMA temp.'];
  return prefixes.some((prefix) => {
    const result = conn.execDriverSql(`${prefix}table_info(${preparer.quoteIdentifier(name)})`);
    return result.returnsRows && [...result].length > 0;
  });
}

function insertStatement(sqlTable, prefixes) {
  const preparer = new IdentifierPreparer('sqlite');
  const columns = sqlTable.columns.map((c) => preparer.quote(c.name)).join(', ');
  const marks = sqlTable.columns.map(() => '?').join(', ');
  const prefix = prefixes.length ? ` ${prefixes.join(' ')}` : '';
  return `INSERT${prefix} INTO ${preparer.formatTable(sqlTable.name, sqlTable.schema)} (${columns}) VALUES (${marks})`;
}

// Python's seq[start:end] for non-negative or negative bounds.
function pySlice(rows, start, end) {
  const norm = (i) => (i < 0 ? Math.max(rows.length + i, 0) : Math.min(i, rows.length));
  return rows.slice(norm(start), norm(end));
}

/**
 * agatesql's Table.to_sql() on an open SQLite connection.
 * @param {object} table an agate Table
 * @param {import('./engine').Connection} conn
 * @param {string} name the table name
 * @param {object} opts overwrite, create, createIfNotExists, insert, prefixes, dbSchema, constraints,
 *   uniqueConstraint, chunkSize, minColLen, colLenMultiplier
 * @returns {void}
 * @throws {Error} pyName sqlalchemy.exc.ConstraintColumnNotFoundError or CompileError from the DDL, and the
 *   sqlalchemy.exc errors (OperationalError, IntegrityError ...) of the statements it runs
 */
function toSql(table, conn, name, opts) {
  const sqlTable = makeSqlTable(table, name, {
    dialect: 'sqlite',
    dbSchema: opts.dbSchema,
    constraints: opts.constraints,
    uniqueConstraint: opts.uniqueConstraint,
    minColLen: opts.minColLen,
    colLenMultiplier: opts.colLenMultiplier,
  });
  if (opts.create) {
    if (opts.overwrite && hasTable(conn, sqlTable.name, sqlTable.schema)) {
      conn.execDriverSql(compileDropTable(sqlTable, 'sqlite'));
    }
    if (!opts.createIfNotExists || !hasTable(conn, sqlTable.name, sqlTable.schema)) {
      conn.execDriverSql(compileCreateTable(sqlTable, 'sqlite'));
    }
  }
  if (!opts.insert) return;
  const statement = insertStatement(sqlTable, opts.prefixes);
  const paramSets = (rows) => rows.map((row) => row.map(bindValue));
  if (opts.chunkSize === null || opts.chunkSize === undefined) {
    conn.executeMany(statement, paramSets(table.rows));
    return;
  }
  const size = opts.chunkSize;
  if (size === 0) throw pyError('ZeroDivisionError', 'integer division or modulo by zero');
  const count = Math.floor((table.rows.length - 1) / size) + 1;
  for (let index = 0; index < count; index++) {
    const end = Math.min((index + 1) * size, table.rows.length);
    const chunk = pySlice(table.rows, index * size, end);
    if (chunk.length) conn.executeMany(statement, paramSets(chunk));
  }
}

module.exports = { toSql };
