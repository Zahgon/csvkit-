'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_sql2csv.py (MIT). The database file lives in a temporary folder
// instead of foo.db in the repository root, so that test files running in parallel do not share it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');
const { CSVKitTestCase, emptyFileTests, readText } = require('../utils');

describe('TestSQL2CSV', () => {
  const t = new CSVKitTestCase('sql2csv');
  emptyFileTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['--query', 'select 1']);
  });

  let tmpDir;
  let dbFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvkit-sql2csv-'));
    dbFile = path.join(tmpDir, 'foo.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Load test data into the DB and return it as a string for comparison.
  function csvsql(csvFile, db = `sqlite:///${dbFile}`) {
    const args = ['--db', db, '--tables', 'foo', '--insert', csvFile, '--no-inference'];

    t.getOutput(args, 'csvsql');

    return readText(csvFile).trim();
  }

  test('test_encoding', () => {
    // Test that csvstat doesn't error on Latin-1 input.
    t.getOutput(['-e', 'latin1', 'examples/test.sql']);
  });

  test('test_query', () => {
    const csv = t.getOutput(['--query', 'select 6*9 as question']);

    assert.ok(csv.includes('question'));
    assert.ok(csv.includes('54'));
  });

  test('test_file', () => {
    const csv = t.getOutput(['examples/test.sql']);

    assert.ok(csv.includes('question'));
    assert.ok(csv.includes('36'));
  });

  test('test_file_with_query', () => {
    const csv = t.getOutput(['examples/test.sql', '--query', 'select 6*9 as question']);

    assert.ok(csv.includes('question'));
    assert.ok(csv.includes('54'));
  });

  test('test_stdin', () => {
    t.withStdin('select cast(3.1415 * 13.37 as integer) as answer', () => {
      const csv = t.getOutput([]);

      assert.ok(csv.includes('answer'));
      assert.ok(csv.includes('42'));
    });
  });

  test('test_stdin_with_query', () => {
    t.withStdin('select cast(3.1415 * 13.37 as integer) as answer', () => {
      const csv = t.getOutput(['--query', 'select 6*9 as question']);

      assert.ok(csv.includes('question'));
      assert.ok(csv.includes('54'));
    });
  });

  test('test_stdin_with_file', () => {
    t.withStdin('select cast(3.1415 * 13.37 as integer) as answer', () => {
      const csv = t.getOutput(['examples/test.sql']);

      assert.ok(csv.includes('question'));
      assert.ok(csv.includes('36'));
    });
  });

  test('test_stdin_with_file_and_query', () => {
    t.withStdin('select cast(3.1415 * 13.37 as integer) as answer', () => {
      const csv = t.getOutput(['examples/test.sql', '--query', 'select 6*9 as question']);

      assert.ok(csv.includes('question'));
      assert.ok(csv.includes('54'));
    });
  });

  test('test_unicode', () => {
    const expected = csvsql('examples/test_utf8.csv');
    const csv = t.getOutput(['--db', `sqlite:///${dbFile}`, '--query', 'select * from foo']);
    assert.equal(csv.trim(), expected);
  });

  test('test_no_header_row', () => {
    csvsql('examples/dummy.csv');
    const csv = t.getOutput(['--db', `sqlite:///${dbFile}`, '--no-header-row', '--query', 'select * from foo']);

    assert.ok(!csv.includes('a,b,c'));
    assert.ok(csv.includes('1,2,3'));
  });

  test('test_linenumbers', () => {
    csvsql('examples/dummy.csv');
    const csv = t.getOutput(['--db', `sqlite:///${dbFile}`, '--linenumbers', '--query', 'select * from foo']);

    assert.ok(csv.includes('line_number,a,b,c'));
    assert.ok(csv.includes('1,1,2,3'));
  });

  test('test_wildcard_on_sqlite', () => {
    csvsql('examples/iris.csv');
    const csv = t.getOutput(['--db', `sqlite:///${dbFile}`, '--query',
      "select * from foo where species LIKE '%'"]);

    assert.ok(csv.includes('sepal_length,sepal_width,petal_length,petal_width,species'));
    assert.ok(csv.includes('5.1,3.5,1.4,0.2,Iris-setosa'));
  });

  // Upstream keeps test_wildcard_on_postgresql commented out: it needs a PostgreSQL server.
});
