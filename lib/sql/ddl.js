'use strict';
// Port of agatesql.table.make_sql_table and to_sql_create_statement (agate-sql 0.7.3, MIT) and of the parts of
// SQLAlchemy 2.1.8 (MIT) they use: the IdentifierPreparer of each dialect, the type compilers for the column types
// agate-sql emits, and the DDL compilers' CREATE TABLE and DROP TABLE statements.

const T = require('../types');
const { maxPrecision } = require('../table');
const { pyError } = require('../pyerrors');
const DIALECT_DATA = require('./dialects-data');

// Python's re.I lets [A-Z] match these non-ASCII letters too (simple case folding).
const LEGAL_CHARACTERS = /^[A-Za-z0-9_$İıſK]+$/;

/** A name that IdentifierPreparer.quote() renders as it is (SQLAlchemy's quoted_name with quote=False). */
class LiteralName {
  /** @param {string} text the name as it is rendered */
  constructor(text) { this.text = text; }
}

/** sqlalchemy.sql.compiler.IdentifierPreparer, configured for one dialect. */
class IdentifierPreparer {
  /** @param {string|null} dialect a dialect name, or null for SQLAlchemy's default string dialect */
  constructor(dialect) {
    const data = DIALECT_DATA[dialect || 'default'];
    this.dialect = dialect;
    this.initialQuote = data.initialQuote;
    this.finalQuote = data.finalQuote;
    this.escapeQuote = data.escapeQuote;
    this.doublePercents = data.doublePercents;
    this.illegalInitial = new Set(data.illegalInitialCharacters);
    this.reserved = new Set(data.reservedWords);
  }

  /**
   * IdentifierPreparer._escape_identifier: doubles the quote character (and "%" where the dialect doubles percent
   * signs); MSSQL doubles "]".
   * @param {string} value
   * @returns {string}
   */
  escapeIdentifier(value) {
    if (this.dialect === 'mssql') return value.replaceAll(']', ']]');
    let out = value.replaceAll(this.escapeQuote, this.escapeQuote + this.escapeQuote);
    if (this.doublePercents) out = out.replaceAll('%', '%%');
    return out;
  }

  /**
   * Quotes an identifier unconditionally.
   * @param {string} value
   * @returns {string}
   */
  quoteIdentifier(value) {
    return this.initialQuote + this.escapeIdentifier(value) + this.finalQuote;
  }

  /**
   * IdentifierPreparer._requires_quotes: an empty name, a reserved word, an illegal first character, a character
   * outside LEGAL_CHARACTERS or any upper-case letter.
   * @param {string} value
   * @returns {boolean}
   */
  requiresQuotes(value) {
    if (!value) return true;
    const lower = value.toLowerCase();
    return this.reserved.has(lower) || this.illegalInitial.has(value[0]) || !LEGAL_CHARACTERS.test(value)
      || lower !== value;
  }

  /**
   * Quotes an identifier when it is reserved, case sensitive or contains characters that need quoting.
   * @param {string|LiteralName} ident
   * @returns {string}
   */
  quote(ident) {
    if (ident instanceof LiteralName) return ident.text;
    return this.requiresQuotes(ident) ? this.quoteIdentifier(ident) : ident;
  }

  /**
   * IdentifierPreparer.quote_schema; MSSQL quotes "database.owner" part by part.
   * @param {string} schema
   * @returns {string}
   */
  quoteSchema(schema) {
    if (this.dialect !== 'mssql') return this.quote(schema);
    const [dbname, owner] = mssqlSchemaElements(schema);
    if (dbname !== null) return `${this.quote(dbname)}.${this.quote(owner)}`;
    return owner ? this.quote(owner) : '';
  }

  /**
   * Renders a table name with its schema, as format_table() does.
   * @param {string|LiteralName} name
   * @param {string|null} schema
   * @returns {string}
   */
  formatTable(name, schema) {
    const result = this.quote(name);
    return schema ? `${this.quoteSchema(schema)}.${result}` : result;
  }
}

// sqlalchemy.dialects.mssql.base._schema_elements: splits "db.owner" (with [bracketed] parts) into its two names.
function mssqlSchemaElements(schema) {
  const push = [];
  let symbol = '';
  let bracket = false;
  let hasBrackets = false;
  for (const token of schema.split(/(\[|\]|\.)/)) {
    if (!token) continue;
    if (token === '[') {
      bracket = true;
      hasBrackets = true;
    } else if (token === ']') {
      bracket = false;
    } else if (!bracket && token === '.') {
      push.push(hasBrackets ? `[${symbol}]` : symbol);
      symbol = '';
      hasBrackets = false;
    } else {
      symbol += token;
    }
  }
  if (symbol) push.push(symbol);
  if (push.length > 1) {
    let dbname = push.slice(0, -1).join('.');
    if (/^.*\].*\[/s.test(dbname.slice(1, -1))) dbname = new LiteralName(dbname);
    else dbname = dbname.replace(/^\[+/, '').replace(/\]+$/, '');
    return [dbname, push[push.length - 1]];
  }
  if (push.length) return [null, push[0]];
  return [null, null];
}

function compileError(message) {
  return pyError('sqlalchemy.exc.CompileError', message);
}

/**
 * Renders a column type the way the dialect's type compiler does.
 * @param {{name: string, length?: number, precision?: number, scale?: number}} type
 * @param {string|null} dialect
 * @returns {string}
 */
function compileType(type, dialect) {
  switch (type.name) {
    case 'BOOLEAN':
      return dialect === 'mysql' ? 'BOOL' : 'BOOLEAN';
    case 'TIMESTAMP':
      return dialect === 'postgresql' ? 'TIMESTAMP WITHOUT TIME ZONE' : 'TIMESTAMP';
    case 'DECIMAL':
      if (type.precision === undefined) return 'DECIMAL';
      return `DECIMAL(${type.precision}, ${type.scale})`;
    case 'Interval':
      if (dialect === 'postgresql') return 'INTERVAL';
      if (dialect === 'oracle') return 'INTERVAL DAY TO SECOND';
      return 'DATETIME';
    case 'INTERVAL':
      return dialect === 'oracle' ? 'INTERVAL DAY TO SECOND' : 'INTERVAL';
    case 'VARCHAR':
      if (type.length === undefined) {
        if (dialect === 'mysql') throw compileError('VARCHAR requires a length on dialect mysql');
        return dialect === 'mssql' ? 'VARCHAR(max)' : 'VARCHAR';
      }
      return dialect === 'oracle' ? `VARCHAR(${type.length} CHAR)` : `VARCHAR(${type.length})`;
    default:
      return type.name;
  }
}

// agatesql's SQL_TYPE_MAP after make_sql_table() has adjusted it for the dialect.
function sqlTypeFor(dataType, dialect) {
  if (dataType instanceof T.BooleanType) return { name: dialect === 'mssql' ? 'BIT' : 'BOOLEAN' };
  if (dataType instanceof T.NumberType) return { name: dialect === 'sqlite' ? 'FLOAT' : 'DECIMAL' };
  if (dataType instanceof T.DateType) return { name: 'DATE' };
  if (dataType instanceof T.DateTimeType) return { name: dialect === 'mssql' ? 'DATETIME' : 'TIMESTAMP' };
  if (dataType instanceof T.TimeDeltaType) {
    return { name: dialect === 'postgresql' || dialect === 'oracle' ? 'INTERVAL' : 'Interval' };
  }
  return { name: 'VARCHAR' };
}

/**
 * agatesql.table.make_sql_table: the SQLAlchemy table (columns, types, nullability, unique constraint) for an agate
 * table.
 * @param {object} table an agate Table (columnNames, columnTypes, rows)
 * @param {string} name the table name
 * @param {object} opts dialect, dbSchema, constraints, uniqueConstraint, minColLen, colLenMultiplier
 * @returns {{name: string, schema: string|null, columns: object[], unique: string[]}}
 * @throws {Error} pyName sqlalchemy.exc.ConstraintColumnNotFoundError for a unique-constraint column the table
 *   does not have
 */
function makeSqlTable(table, name, opts) {
  const dialect = opts.dialect || null;
  const minColLen = opts.minColLen === undefined ? 1 : opts.minColLen;
  const colLenMultiplier = opts.colLenMultiplier === undefined ? 1 : opts.colLenMultiplier;
  const columns = table.columnNames.map((columnName, i) => {
    const dataType = table.columnTypes[i];
    const values = table.rows.map((row) => row[i]);
    let type = sqlTypeFor(dataType, dialect);
    let nullable = true;
    if (opts.constraints) {
      if (dataType instanceof T.TextType && dialect === 'mysql') {
        const lengths = values.filter((v) => v !== null).map((v) => [...v].length);
        const length = (lengths.length ? Math.max(...lengths) : 0) * colLenMultiplier;
        if (length > 21844) type = { name: 'TEXT' };
        else type = { name: 'VARCHAR', length: Math.trunc(length >= minColLen ? length : minColLen) };
      }
      if (dataType instanceof T.NumberType && ['mssql', 'mysql', 'oracle'].includes(dialect)) {
        type = { name: type.name, precision: 38, scale: maxPrecision(values.filter((v) => v !== null)) };
      }
      if (!(dataType instanceof T.DateTimeType)) nullable = values.includes(null);
    }
    return { name: columnName, type, nullable };
  });
  const unique = [];
  for (const columnName of opts.uniqueConstraint || []) {
    if (!table.columnNames.includes(columnName)) {
      throw pyError('sqlalchemy.exc.ConstraintColumnNotFoundError',
        `Can't create UniqueConstraint on table '${name}': no column named '${columnName}' is present.`);
    }
    if (!unique.includes(columnName)) unique.push(columnName);
  }
  return { name, schema: opts.dbSchema || null, columns, unique };
}

// The DDL compiler's get_column_specification() of each dialect, for the columns agate-sql creates.
function columnSpecification(column, dialect, preparer) {
  let spec = `${preparer.quote(column.name)} ${compileType(column.type, dialect)}`;
  if (!column.nullable) spec += ' NOT NULL';
  else if (dialect === 'mssql' || (dialect === 'mysql' && column.type.name === 'TIMESTAMP')) spec += ' NULL';
  return spec;
}

/**
 * Compiles CreateTable(sqlTable) for a dialect, exactly as SQLAlchemy renders it (leading newline and trailing blank
 * line included).
 * @param {object} sqlTable the result of makeSqlTable()
 * @param {string|null} dialect
 * @param {{ifNotExists?: boolean}} [opts]
 * @returns {string}
 * @throws {Error} pyName sqlalchemy.exc.CompileError, naming the table and column, for a column type the dialect
 *   cannot render
 */
function compileCreateTable(sqlTable, dialect, opts = {}) {
  const preparer = new IdentifierPreparer(dialect);
  let text = '\nCREATE TABLE ';
  if (opts.ifNotExists) text += 'IF NOT EXISTS ';
  text += `${preparer.formatTable(sqlTable.name, sqlTable.schema)} (`;
  let separator = '\n';
  for (const column of sqlTable.columns) {
    let spec;
    try {
      spec = columnSpecification(column, dialect, preparer);
    } catch (e) {
      if (e.pyName !== 'sqlalchemy.exc.CompileError') throw e;
      throw compileError(`(in table '${sqlTable.name}', column '${column.name}'): ${e.message}`);
    }
    text += `${separator}\t${spec}`;
    separator = ', \n';
  }
  if (sqlTable.unique.length) {
    text += `${separator}\tUNIQUE (${sqlTable.unique.map((c) => preparer.quote(c)).join(', ')})`;
  }
  return `${text}\n)\n\n`;
}

/**
 * Compiles DropTable for a dialect.
 * @param {object} sqlTable the result of makeSqlTable()
 * @param {string|null} dialect
 * @returns {string}
 */
function compileDropTable(sqlTable, dialect) {
  return `\nDROP TABLE ${new IdentifierPreparer(dialect).formatTable(sqlTable.name, sqlTable.schema)}`;
}

/**
 * agatesql's Table.to_sql_create_statement(): the CREATE TABLE statement csvsql prints.
 * @param {object} table an agate Table
 * @param {string} name the table name
 * @param {object} opts dialect, dbSchema, constraints, uniqueConstraint
 * @returns {string}
 * @throws {Error} as makeSqlTable() and compileCreateTable()
 */
function createStatement(table, name, opts) {
  const sqlTable = makeSqlTable(table, name, {
    dialect: opts.dialect, dbSchema: opts.dbSchema, constraints: opts.constraints, uniqueConstraint: opts.uniqueConstraint,
  });
  return `${compileCreateTable(sqlTable, opts.dialect || null).trim()};`;
}

module.exports = { IdentifierPreparer, makeSqlTable, compileCreateTable, compileDropTable, createStatement };
