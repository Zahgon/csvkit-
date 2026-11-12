'use strict';
// Port of csvkit 2.2.0 tests/utils.py (MIT): the CSVKitTestCase helpers and the EmptyFileTests, NamesTests and
// ColumnsTests mixins. Each tool runs as a child process of this repository's bin/<tool>.js, in the repository root,
// the way the upstream tests ran a Utility from the repository root.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const pycsv = require('../lib/pycsv');

const ROOT = path.join(__dirname, '..');
const TOOL_TIMEOUT_MS = 60000;

// The upstream tests open 'examples/...' relative to the repository root.
process.chdir(ROOT);

/**
 * The error a failed tool run raises, named after the Python exception the tool reported: csvkit prints an
 * uncaught exception as "Name: message", where the message may span several lines.
 */
class ToolError extends Error {
  constructor(result) {
    const lines = result.stderr.split('\n');
    const at = lines.findLastIndex((l) => /^[A-Za-z_][\w.]*: /.test(l));
    super(at < 0 ? `exit status ${result.status}: ${result.stderr}` : lines.slice(at).join('\n').trimEnd());
    this.name = at < 0 ? 'SystemExit' : lines[at].slice(0, lines[at].indexOf(':'));
    this.code = result.status;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/** Splits text into lines that keep their '\n', as iterating an io.StringIO does. */
function splitLinesKeepEnds(text) {
  return text.split(/(?<=\n)/).filter((l) => l);
}

/**
 * open(path).read(): the file decoded as UTF-8 with universal newlines.
 * @param {string} file path relative to the repository root
 * @returns {string}
 */
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

/** agate.csv.reader over text: the parsed rows. */
function csvRows(text) {
  return [...new pycsv.Reader(splitLinesKeepEnds(text))];
}

/**
 * The kind of each number in a JSON document, 'float' or 'int' as Python's json module would load it, in a copy of
 * the document's structure (assertIsInstance(value, float) looks the value up here).
 * @param {string} text JSON text
 * @returns {*}
 */
function jsonNumberKinds(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value !== 'number') return value;
    return /[.eE]/.test(context.source) ? 'float' : 'int';
  });
}

/**
 * CSVKitTestCase: runs one tool with arguments and an optional standard input.
 */
class CSVKitTestCase {
  /**
   * @param {string} command the tool name (Utility.__name__.lower())
   * @param {{defaultArgs?: string[], columnsArgs?: string[]}} [options] the class's default_args and columns_args
   */
  constructor(command, { defaultArgs = [], columnsArgs = [] } = {}) {
    this.command = command;
    this.defaultArgs = defaultArgs;
    this.columnsArgs = columnsArgs;
    this.stdin = Buffer.alloc(0);
  }

  /**
   * Runs the tool (or another one) and returns its exit status, standard output and standard error.
   * @param {string[]} args command line arguments
   * @param {string} [command] tool name, this test case's tool by default
   * @returns {{status: number, stdout: string, stderr: string}}
   */
  run(args, command = this.command) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', `${command}.js`), ...args], {
      cwd: ROOT,
      input: this.stdin,
      env: { ...process.env, COLUMNS: '80', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
      encoding: 'utf8',
      timeout: TOOL_TIMEOUT_MS,
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  /**
   * stdin_as_string: runs fn with content as the tools' standard input.
   * @param {Buffer|string} content standard input
   * @param {Function} fn body of the with block
   */
  withStdin(content, fn) {
    const saved = this.stdin;
    this.stdin = Buffer.from(content);
    try {
      fn();
    } finally {
      this.stdin = saved;
    }
  }

  /**
   * launch_new_instance with sys.argv patched: the tool must run without raising.
   * @param {string[]} args command line arguments
   */
  launchNewInstance(args) {
    const r = this.run(args);
    if (r.status !== 0) throw new ToolError(r);
  }

  /**
   * get_output: the tool's standard output; a failing run throws a ToolError named after the Python exception.
   * @param {string[]} args command line arguments
   * @param {string} [command] tool name
   * @returns {string}
   */
  getOutput(args, command = this.command) {
    const r = this.run(args, command);
    if (r.status !== 0) throw new ToolError(r);
    return r.stdout;
  }

  /**
   * get_output_as_io: the lines of the output, each with its line ending.
   * @param {string[]} args command line arguments
   * @returns {string[]}
   */
  getOutputAsIo(args) {
    return splitLinesKeepEnds(this.getOutput(args));
  }

  /**
   * get_output_as_list: the output split on '\n'.
   * @param {string[]} args command line arguments
   * @returns {string[]}
   */
  getOutputAsList(args) {
    return this.getOutput(args).split('\n');
  }

  /**
   * get_output_as_reader: the output parsed as CSV.
   * @param {string[]} args command line arguments
   * @returns {string[][]}
   */
  getOutputAsReader(args) {
    return csvRows(this.getOutput(args));
  }

  /**
   * assertError: the tool exits with status 2 and its last line of standard error is the usage error.
   * @param {string[]} options options before the arguments
   * @param {string} message expected error message
   * @param {string[]} [args] arguments, examples/dummy.csv by default
   */
  assertError(options, message, args = ['examples/dummy.csv']) {
    const r = this.run([...options, ...args]);
    assert.equal(r.status, 2);
    const lines = r.stderr.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    assert.equal(lines[lines.length - 1], `${this.command}: error: ${message}`);
  }

  /**
   * assertRows: the output parses to exactly these CSV rows.
   * @param {string[]} args command line arguments
   * @param {string[][]} rows expected rows
   */
  assertRows(args, rows) {
    assert.deepEqual(this.getOutputAsReader(args), rows);
  }

  /**
   * assertLines: the output is exactly these lines.
   * @param {string[]} args command line arguments
   * @param {string[]} rows expected lines
   * @param {boolean} [newlineAtEof] whether the output ends with a newline
   */
  assertLines(args, rows, newlineAtEof = true) {
    const expected = newlineAtEof ? [...rows, ''] : rows;
    assert.deepEqual(this.getOutputAsList(args), expected);
  }
}

/**
 * EmptyFileTests: the tool runs on an empty standard input with its default arguments.
 * @param {CSVKitTestCase} t test case
 */
function emptyFileTests(t) {
  test('test_empty', () => {
    t.withStdin(fs.readFileSync('examples/empty.csv'), () => {
      t.getOutput(t.defaultArgs);
    });
  });
}

/**
 * NamesTests: -n lists the column names, and refuses --no-header-row.
 * @param {CSVKitTestCase} t test case
 */
function namesTests(t) {
  test('test_names', () => {
    const output = t.getOutputAsIo(['-n', 'examples/dummy.csv']);

    assert.equal(output[0], '  1: a\n');
    assert.equal(output[1], '  2: b\n');
    assert.equal(output[2], '  3: c\n');
  });

  test('test_invalid_options', () => {
    const args = ['-n', '--no-header-row', 'examples/dummy.csv'];

    assert.throws(() => t.getOutput(args), { name: 'RequiredHeaderError' });
  });
}

/**
 * ColumnsTests: column 0 is an invalid column identifier.
 * @param {CSVKitTestCase} t test case
 */
function columnsTests(t) {
  test('test_invalid_column', () => {
    const args = [...t.columnsArgs, '-c', '0', 'examples/dummy.csv'];

    assert.throws(() => t.getOutput(args), { name: 'ColumnIdentifierError' });
  });
}

module.exports = {
  CSVKitTestCase, emptyFileTests, namesTests, columnsTests, csvRows, readText, splitLinesKeepEnds, jsonNumberKinds,
};
