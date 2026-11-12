'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvsql.py (MIT). The database file lives in a temporary folder
// instead of foo.db in the repository root, so that test files running in parallel do not share it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');
const { CSVKitTestCase, emptyFileTests } = require('../utils');

describe('TestCSVSQL', () => {
  const t = new CSVKitTestCase('csvsql');
  emptyFileTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_options', async (s) => {
    for (const [args, message] of [
      [
        ['--db', 'sqlite:///:memory:', '--dialect', 'sqlite'],
        'The --dialect option is only valid when neither --db nor --query are specified.',
      ],
      [
        ['--insert'],
        'The --insert option is only valid when either --db or --query is specified.',
      ],
      [
        ['--db', 'sqlite:///:memory:', '--insert', '--no-create', '--overwrite'],
        'The --overwrite option is only valid if --no-create is not specified.',
      ],
      [
        ['--db', 'sqlite:///:memory:', '--insert', '--no-create', '--create-if-not-exists'],
        'The --no-create and --create-if-not-exists options are mutually exclusive.',
      ],
    ]) {
      await s.test(`args=${JSON.stringify(args)}`, () => {
        t.assertError(args, message);
      });
    }
  });

  test('test_insert_options', async (s) => {
    for (const args of [
      ['--no-create'],
      ['--create-if-not-exists'],
      ['--overwrite'],
      ['--before-insert'],
      ['--after-insert'],
      ['--chunk-size', '1'],
    ]) {
      await s.test(`args=${JSON.stringify(args)}`, () => {
        t.assertError(
          args,
          `The ${args[0]} option is only valid if --insert is also specified.`,
        );
      });
    }
  });

  let tmpDir;
  let dbFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvkit-csvsql-'));
    dbFile = path.join(tmpDir, 'foo.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('test_glob', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    const sql = t.getOutput(['examples/dummy?.csv']);

    assert.equal(sql.replaceAll('\t', '  '), [
      'CREATE TABLE dummy2 (',
      '  a BOOLEAN NOT NULL, ',
      '  b DECIMAL NOT NULL, ',
      '  c DECIMAL NOT NULL',
      ');',
      'CREATE TABLE dummy3 (',
      '  a BOOLEAN NOT NULL, ',
      '  b DECIMAL NOT NULL, ',
      '  c DECIMAL NOT NULL',
      ');',
      '',
    ].join('\n'));
  });

  test('test_create_table', () => {
    const sql = t.getOutput(['--tables', 'foo', 'examples/testfixed_converted.csv']);

    assert.equal(sql.replaceAll('\t', '  '), [
      'CREATE TABLE foo (',
      '  text VARCHAR NOT NULL, ',
      '  date DATE, ',
      '  integer DECIMAL, ',
      '  boolean BOOLEAN, ',
      '  float DECIMAL, ',
      '  time DATETIME, ',
      '  datetime TIMESTAMP, ',
      '  empty_column BOOLEAN',
      ');',
      '',
    ].join('\n'));
  });

  test('test_no_blanks', () => {
    const sql = t.getOutput(['--tables', 'foo', 'examples/blanks.csv']);

    assert.equal(sql.replaceAll('\t', '  '), [
      'CREATE TABLE foo (',
      '  a BOOLEAN, ',
      '  b BOOLEAN, ',
      '  c BOOLEAN, ',
      '  d BOOLEAN, ',
      '  e BOOLEAN, ',
      '  f BOOLEAN',
      ');',
      '',
    ].join('\n'));
  });

  test('test_blanks', () => {
    const sql = t.getOutput(['--tables', 'foo', '--blanks', 'examples/blanks.csv']);

    assert.equal(sql.replaceAll('\t', '  '), [
      'CREATE TABLE foo (',
      '  a VARCHAR NOT NULL, ',
      '  b VARCHAR NOT NULL, ',
      '  c VARCHAR NOT NULL, ',
      '  d VARCHAR NOT NULL, ',
      '  e VARCHAR NOT NULL, ',
      '  f VARCHAR NOT NULL',
      ');',
      '',
    ].join('\n'));
  });

  test('test_no_inference', () => {
    const sql = t.getOutput(['--tables', 'foo', '--no-inference', 'examples/testfixed_converted.csv']);

    assert.equal(sql.replaceAll('\t', '  '), [
      'CREATE TABLE foo (',
      '  text VARCHAR NOT NULL, ',
      '  date VARCHAR, ',
      '  integer VARCHAR, ',
      '  boolean VARCHAR, ',
      '  float VARCHAR, ',
      '  time VARCHAR, ',
      '  datetime VARCHAR, ',
      '  empty_column VARCHAR',
      ');',
      '',
    ].join('\n'));
  });

  test('test_no_header_row', () => {
    const sql = t.getOutput(['--tables', 'foo', '--no-header-row', 'examples/no_header_row.csv']);

    assert.equal(sql.replaceAll('\t', '  '), [
      'CREATE TABLE foo (',
      '  a BOOLEAN NOT NULL, ',
      '  b DECIMAL NOT NULL, ',
      '  c DECIMAL NOT NULL',
      ');',
      '',
    ].join('\n'));
  });

  test('test_linenumbers', () => {
    const sql = t.getOutput(['--tables', 'foo', '--linenumbers', 'examples/dummy.csv']);

    assert.equal(sql.replaceAll('\t', '  '), [
      'CREATE TABLE foo (',
      '  a BOOLEAN NOT NULL, ',
      '  b DECIMAL NOT NULL, ',
      '  c DECIMAL NOT NULL',
      ');',
      '',
    ].join('\n'));
  });

  test('test_stdin', () => {
    t.withStdin('a,b,c\n4,2,3\n', () => {
      const sql = t.getOutput(['--tables', 'foo']);

      assert.equal(sql.replaceAll('\t', '  '), [
        'CREATE TABLE foo (',
        '  a DECIMAL NOT NULL, ',
        '  b DECIMAL NOT NULL, ',
        '  c DECIMAL NOT NULL',
        ');',
        '',
      ].join('\n'));
    });
  });

  test('test_stdin_and_filename', () => {
    t.withStdin('a,b,c\n1,2,3\n', () => {
      const sql = t.getOutput(['-', 'examples/dummy.csv']);

      assert.ok(sql.includes('CREATE TABLE stdin'));
      assert.ok(sql.includes('CREATE TABLE dummy'));
    });
  });

  test('test_query', () => {
    t.withStdin('a,b,c\n1,2,3\n', () => {
      const sql = t.getOutput(['--query', 'SELECT m.usda_id, avg(i.sepal_length) AS mean_sepal_length FROM iris '
        + 'AS i JOIN irismeta AS m ON (i.species = m.species) GROUP BY m.species',
      'examples/iris.csv', 'examples/irismeta.csv']);

      assert.ok(sql.includes('usda_id,mean_sepal_length'));
      assert.ok(sql.includes('IRSE,5.00'));
      assert.ok(sql.includes('IRVE2,5.936'));
      assert.ok(sql.includes('IRVI,6.58'));
    });
  });

  test('test_query_empty', () => {
    t.withStdin('', () => {
      const output = t.getOutput(['--query', 'SELECT 1']);
      assert.equal(output, '1\n1\n');
    });
  });

  test('test_query_text', () => {
    const sql = t.getOutput(['--query', 'SELECT text FROM testfixed_converted WHERE text LIKE "Chicago%"',
      'examples/testfixed_converted.csv']);

    assert.equal(sql,
      'text\n'
      + 'Chicago Reader\n'
      + 'Chicago Sun-Times\n'
      + 'Chicago Tribune\n');
  });

  test('test_query_file', () => {
    const sql = t.getOutput(['--query', 'examples/test_query.sql', 'examples/testfixed_converted.csv']);

    assert.equal(sql,
      'question,text\n'
      + '36,©\n');
  });

  test('test_query_update', () => {
    const sql = t.getOutput(['--query', 'UPDATE dummy SET a=10 WHERE a=1', '--no-inference', 'examples/dummy.csv']);

    assert.equal(sql, '');
  });

  test('test_before_after_insert', () => {
    t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert', 'examples/dummy.csv', '--before-insert',
      'SELECT 1; CREATE TABLE foobar (date DATE)', '--after-insert',
      'INSERT INTO dummy VALUES (0, 5, 6)']);

    let output = t.getOutput(['--db', `sqlite:///${dbFile}`, '--query', 'SELECT * FROM foobar'], 'sql2csv');
    assert.equal(output, 'date\n');

    output = t.getOutput(['--db', `sqlite:///${dbFile}`, '--query', 'SELECT * FROM dummy'], 'sql2csv');
    assert.equal(output, 'a,b,c\n1,2.0,3.0\n0,5.0,6.0\n');
  });

  test('test_no_prefix_unique_constraint', () => {
    t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert',
      'examples/dummy.csv', '--unique-constraint', 'a']);
    assert.throws(
      () => t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert', 'examples/dummy.csv', '--no-create']),
      { name: 'IntegrityError' },
    );
  });

  test('test_prefix_unique_constraint', () => {
    t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert',
      'examples/dummy.csv', '--unique-constraint', 'a']);
    t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert',
      'examples/dummy.csv', '--no-create', '--prefix', 'OR IGNORE']);
  });

  test('test_no_create_if_not_exists', () => {
    t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert', '--tables', 'foo', 'examples/foo1.csv']);
    assert.throws(
      () => t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert', '--tables', 'foo', 'examples/foo2.csv']),
      { name: 'OperationalError' },
    );
  });

  test('test_create_if_not_exists', () => {
    t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert', '--tables', 'foo', 'examples/foo1.csv']);
    t.getOutput(['--db', `sqlite:///${dbFile}`, '--insert', '--tables',
      'foo', 'examples/foo2.csv', '--create-if-not-exists']);
  });
});
