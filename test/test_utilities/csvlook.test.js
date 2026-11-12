'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvlook.py (MIT). Each run is its own process, so the agate
// truncation_chars option the upstream tearDown resets cannot leak from one test into the next.

const { describe, test } = require('node:test');
const { CSVKitTestCase, emptyFileTests } = require('../utils');

describe('TestCSVLook', () => {
  const t = new CSVKitTestCase('csvlook');
  emptyFileTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_runs', () => {
    t.assertLines(['examples/test_utf8.csv'], [
      '| foo | bar | baz |',
      '| --- | --- | --- |',
      '|   1 |   2 | 3   |',
      '|   4 |   5 | ʤ   |',
    ]);
  });

  test('test_encoding', () => {
    t.assertLines(['-e', 'latin1', 'examples/test_latin1.csv'], [
      '| a | b | c |',
      '| - | - | - |',
      '| 1 | 2 | 3 |',
      '| 4 | 5 | © |',
    ]);
  });

  test('test_simple', () => {
    t.assertLines(['examples/dummy3.csv'], [
      '|    a | b | c |',
      '| ---- | - | - |',
      '| True | 2 | 3 |',
      '| True | 4 | 5 |',
    ]);
  });

  test('test_no_blanks', () => {
    t.assertLines(['examples/blanks.csv'], [
      '| a | b | c | d | e | f |',
      '| - | - | - | - | - | - |',
      '|   |   |   |   |   |   |',
    ]);
  });

  test('test_blanks', () => {
    t.assertLines(['--blanks', 'examples/blanks.csv'], [
      '| a | b  | c   | d    | e    | f |',
      '| - | -- | --- | ---- | ---- | - |',
      '|   | NA | N/A | NONE | NULL | . |',
    ]);
  });

  test('test_no_header_row', () => {
    t.assertLines(['--no-header-row', 'examples/no_header_row3.csv'], [
      '| a | b | c |',
      '| - | - | - |',
      '| 1 | 2 | 3 |',
      '| 4 | 5 | 6 |',
    ]);
  });

  test('test_unicode', () => {
    t.assertLines(['examples/test_utf8.csv'], [
      '| foo | bar | baz |',
      '| --- | --- | --- |',
      '|   1 |   2 | 3   |',
      '|   4 |   5 | ʤ   |',
    ]);
  });

  test('test_unicode_bom', () => {
    t.assertLines(['examples/test_utf8_bom.csv'], [
      '| foo | bar | baz |',
      '| --- | --- | --- |',
      '|   1 |   2 | 3   |',
      '|   4 |   5 | ʤ   |',
    ]);
  });

  test('test_linenumbers', () => {
    t.assertLines(['--linenumbers', 'examples/dummy3.csv'], [
      '| line_numbers |    a | b | c |',
      '| ------------ | ---- | - | - |',
      '|            1 | True | 2 | 3 |',
      '|            2 | True | 4 | 5 |',
    ]);
  });

  test('test_no_inference', () => {
    t.assertLines(['--no-inference', 'examples/dummy3.csv'], [
      '| a | b | c |',
      '| - | - | - |',
      '| 1 | 2 | 3 |',
      '| 1 | 4 | 5 |',
    ]);
  });

  test('test_sniff_limit_no_limit', () => {
    t.assertLines(['examples/sniff_limit.csv'], [
      '|    a | b | c |',
      '| ---- | - | - |',
      '| True | 2 | 3 |',
    ]);
  });

  test('test_sniff_limit_zero_limit', () => {
    t.assertLines(['--snifflimit', '0', 'examples/sniff_limit.csv'], [
      '| a;b;c |',
      '| ----- |',
      '| 1;2;3 |',
    ]);
  });

  test('test_max_rows', () => {
    t.assertLines(['--max-rows', '0', 'examples/dummy.csv'], [
      '| a | b | c |',
      '| - | - | - |',
    ]);
  });

  test('test_max_columns', () => {
    t.assertLines(['--max-columns', '1', 'examples/dummy.csv'], [
      '|    a | ... |',
      '| ---- | --- |',
      '| True | ... |',
    ]);
  });

  test('test_max_column_width', () => {
    t.assertLines(['--max-column-width', '1', 'examples/dummy.csv'], [
      '|     a | b | c |',
      '| ----- | - | - |',
      '| Tr... | 2 | 3 |',
    ]);
  });

  test('test_max_precision', () => {
    t.assertLines(['--max-precision', '0', 'examples/test_precision.csv'], [
      '|  a |',
      '| -- |',
      '| 1… |',
    ]);
  });

  test('test_no_number_ellipsis', () => {
    t.assertLines(['--no-number-ellipsis', 'examples/test_precision.csv'], [
      '|     a |',
      '| ----- |',
      '| 1.235 |',
    ]);
  });

  test('test_max_precision_no_number_ellipsis', () => {
    t.assertLines(['--max-precision', '0', '--no-number-ellipsis', 'examples/test_precision.csv'], [
      '| a |',
      '| - |',
      '| 1 |',
    ]);
  });

  test('test_stdin', () => {
    t.withStdin('a,b,c\n1,2,3\n4,5,6\n', () => {
      t.assertLines([], [
        '| a | b | c |',
        '| - | - | - |',
        '| 1 | 2 | 3 |',
        '| 4 | 5 | 6 |',
      ]);
    });
  });
});
