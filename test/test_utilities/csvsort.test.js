'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvsort.py (MIT).

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { CSVKitTestCase, columnsTests, emptyFileTests, namesTests } = require('../utils');

describe('TestCSVSort', () => {
  const t = new CSVKitTestCase('csvsort');
  columnsTests(t);
  emptyFileTests(t);
  namesTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_runs', () => {
    t.assertRows(['examples/test_utf8.csv'], [
      ['foo', 'bar', 'baz'],
      ['1', '2', '3'],
      ['4', '5', 'ʤ'],
    ]);
  });

  test('test_encoding', () => {
    t.assertRows(['-e', 'latin1', 'examples/test_latin1.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '©'],
    ]);
  });

  test('test_sort_string_reverse', () => {
    const reader = t.getOutputAsReader(['-c', '1', '-r', 'examples/testxls_converted.csv']);
    const testOrder = ['text', 'Unicode! Σ', 'This row has blanks',
      'Chicago Tribune', 'Chicago Sun-Times', 'Chicago Reader'];
    const newOrder = reader.map((r) => r[0]);
    assert.deepEqual(testOrder, newOrder);
  });

  test('test_sort_date', () => {
    const reader = t.getOutputAsReader(['-c', '2', 'examples/testxls_converted.csv']);
    const testOrder = ['text', 'Chicago Tribune', 'Chicago Sun-Times',
      'Chicago Reader', 'This row has blanks', 'Unicode! Σ'];
    const newOrder = reader.map((r) => r[0]);
    assert.deepEqual(testOrder, newOrder);
  });

  test('test_ignore_case', () => {
    t.assertRows(['-i', 'examples/test_ignore_case.csv'], [
      ['a', 'b', 'c'],
      ['3', '2009-01-01', 'd'],
      ['20', '2001-01-01', 'c'],
      ['20', '2002-01-01', 'b'],
      ['100', '2003-01-01', 'a'],
      ['100', '2003-01-01', 'A'],
    ]);
  });

  test('test_no_blanks', () => {
    const reader = t.getOutputAsReader(['examples/blanks.csv']);
    const testOrder = [
      ['a', 'b', 'c', 'd', 'e', 'f'],
      ['', '', '', '', '', ''],
    ];
    assert.deepEqual(testOrder, reader);
  });

  test('test_blanks', () => {
    const reader = t.getOutputAsReader(['--blanks', 'examples/blanks.csv']);
    const testOrder = [
      ['a', 'b', 'c', 'd', 'e', 'f'],
      ['', 'NA', 'N/A', 'NONE', 'NULL', '.'],
    ];
    assert.deepEqual(testOrder, reader);
  });

  test('test_no_header_row', () => {
    t.assertRows(['--no-header-row', '--no-inference', 'examples/no_header_row.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_no_inference', () => {
    const reader = t.getOutputAsReader(['--no-inference', '-c', '1', 'examples/test_literal_order.csv']);
    const testOrder = ['a', '192', '27', '3'];
    const newOrder = reader.map((r) => r[0]);
    assert.deepEqual(testOrder, newOrder);
  });

  test('test_sort_t_and_nulls', () => {
    const reader = t.getOutputAsReader(['-c', '2', 'examples/sort_ints_nulls.csv']);
    const testOrder = ['b', '1', '2', ''];
    const newOrder = reader.map((r) => r[1]);
    assert.deepEqual(testOrder, newOrder);
  });

  test('test_stdin', () => {
    t.withStdin('a,b,c\n4,5,6\n1,2,3\n', () => {
      t.assertLines([], [
        'a,b,c',
        '1,2,3',
        '4,5,6',
      ]);
    });
  });
});
