'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvcut.py (MIT).

const { describe, test } = require('node:test');
const { CSVKitTestCase, columnsTests, emptyFileTests, namesTests } = require('../utils');

describe('TestCSVCut', () => {
  const t = new CSVKitTestCase('csvcut');
  columnsTests(t);
  emptyFileTests(t);
  namesTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_skip_lines', () => {
    t.assertRows(['--skip-lines', '3', '-c', '1,3', 'examples/test_skip_lines.csv'], [
      ['a', 'c'],
      ['1', '3'],
    ]);
  });

  test('test_simple', () => {
    t.assertRows(['-c', '1,3', 'examples/dummy.csv'], [
      ['a', 'c'],
      ['1', '3'],
    ]);
  });

  test('test_linenumbers', () => {
    t.assertRows(['-c', '1,3', '-l', 'examples/dummy.csv'], [
      ['line_number', 'a', 'c'],
      ['1', '1', '3'],
    ]);
  });

  test('test_unicode', () => {
    t.assertRows(['-c', '1,3', 'examples/test_utf8.csv'], [
      ['foo', 'baz'],
      ['1', '3'],
      ['4', 'ʤ'],
    ]);
  });

  test('test_with_gzip', () => {
    t.assertRows(['-c', '1,3', 'examples/dummy.csv.gz'], [
      ['a', 'c'],
      ['1', '3'],
    ]);
  });

  test('test_with_bzip2', () => {
    t.assertRows(['-c', '1,3', 'examples/dummy.csv.bz2'], [
      ['a', 'c'],
      ['1', '3'],
    ]);
  });

  test('test_exclude', () => {
    t.assertRows(['-C', '1,3', 'examples/dummy.csv'], [
      ['b'],
      ['2'],
    ]);
  });

  test('test_exclude_unknown_columns', () => {
    t.assertRows(['-C', '1,foo,42', 'examples/dummy.csv'], [
      ['b', 'c'],
      ['2', '3'],
    ]);
  });

  test('test_include_and_exclude', () => {
    t.assertRows(['-c', '1,3', '-C', '3', 'examples/dummy.csv'], [
      ['a'],
      ['1'],
    ]);
  });

  test('test_delete_empty', () => {
    t.assertRows(['-c', 'column_c', '--delete-empty-rows', 'examples/bad.csv'], [
      ['column_c'],
      ['17'],
    ]);
  });

  test('test_no_header_row', () => {
    t.assertRows(['-c', '2', '--no-header-row', 'examples/no_header_row.csv'], [
      ['b'],
      ['2'],
    ]);
  });

  test('test_ragged', () => {
    // Test that csvcut doesn't error when a row is short.
    t.getOutput(['-c', 'column_c', 'examples/bad.csv']);
  });

  test('test_truncate', () => {
    // Test that csvcut truncates long rows.
    t.assertRows(['-C', 'column_a,column_b', '--delete-empty-rows', 'examples/bad.csv'], [
      ['column_c'],
      ['17'],
    ]);
  });

  test('test_names_with_skip_lines', () => {
    t.assertLines(['--names', '--skip-lines', '3', 'examples/test_skip_lines.csv'], [
      '  1: a',
      '  2: b',
      '  3: c',
    ]);
  });

  test('test_null_byte', () => {
    // Test that csvcut doesn't error on a null byte.
    t.getOutput(['-C', '', 'examples/null_byte.csv']);
  });
});
