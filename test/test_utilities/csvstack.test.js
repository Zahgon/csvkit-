'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvstack.py (MIT).

const fs = require('node:fs');
const { describe, test } = require('node:test');
const { CSVKitTestCase, emptyFileTests } = require('../utils');

/** The tests of TestCSVStack, which TestNoHeaderRow inherits. */
function csvStackTests(t) {
  emptyFileTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_options', () => {
    t.assertError(
      ['-g', '1,2'],
      'The number of grouping values must be equal to the number of CSV files being stacked.',
    );
  });

  test('test_glob', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    t.assertRows(['examples/dummy*.csv'], [
      ['a', 'b', 'c', 'd'],
      ['1', '2', '3', ''],
      ['1', '2', '3', ''],
      ['1', '2', '3', ''],
      ['1', '4', '5', ''],
      ['1', '2', '3', ''],
      ['1', '2', '3', '4'],
    ]);
  });

  test('test_skip_lines', () => {
    t.assertRows(['--skip-lines', '3', 'examples/test_skip_lines.csv', 'examples/test_skip_lines.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['1', '2', '3'],
    ]);
  });

  test('test_skip_lines_stdin', () => {
    t.withStdin(fs.readFileSync('examples/test_skip_lines.csv'), () => {
      t.assertRows(['--skip-lines', '3', '-', 'examples/test_skip_lines.csv'], [
        ['a', 'b', 'c'],
        ['1', '2', '3'],
        ['1', '2', '3'],
      ]);
    });
  });

  test('test_single_file_stack', () => {
    t.assertRows(['examples/dummy.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_multiple_file_stack', () => {
    t.assertRows(['examples/dummy.csv', 'examples/dummy2.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['1', '2', '3'],
    ]);
  });

  test('test_multiple_file_stack_col', () => {
    t.assertRows(['examples/dummy.csv', 'examples/dummy_col_shuffled.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['1', '2', '3'],
    ]);

    t.assertRows(['examples/dummy_col_shuffled.csv', 'examples/dummy.csv'], [
      ['b', 'c', 'a'],
      ['2', '3', '1'],
      ['2', '3', '1'],
    ]);
  });

  test('test_multiple_file_stack_col_ragged', () => {
    t.assertRows(['examples/dummy.csv', 'examples/dummy_col_shuffled_ragged.csv'], [
      ['a', 'b', 'c', 'd'],
      ['1', '2', '3', ''],
      ['1', '2', '3', '4'],
    ]);
  });

  test('test_multiple_file_stack_col_ragged_stdin', () => {
    t.withStdin(fs.readFileSync('examples/dummy.csv'), () => {
      t.assertRows(['-', 'examples/dummy_col_shuffled_ragged.csv'], [
        ['a', 'b', 'c', 'd'],
        ['1', '2', '3', ''],
        ['1', '2', '3', '4'],
      ]);
    });

    t.withStdin(fs.readFileSync('examples/dummy.csv'), () => {
      t.assertRows(['examples/dummy_col_shuffled_ragged.csv', '-'], [
        ['b', 'c', 'a', 'd'],
        ['2', '3', '1', '4'],
        ['2', '3', '1', ''],
      ]);
    });
  });

  test('test_explicit_grouping', () => {
    t.assertRows(['--groups', 'asd,sdf', '-n', 'foo', 'examples/dummy.csv', 'examples/dummy2.csv'], [
      ['foo', 'a', 'b', 'c'],
      ['asd', '1', '2', '3'],
      ['sdf', '1', '2', '3'],
    ]);
  });

  test('test_filenames_grouping', () => {
    t.assertRows(['--filenames', '-n', 'path', 'examples/dummy.csv', 'examples/dummy2.csv'], [
      ['path', 'a', 'b', 'c'],
      ['dummy.csv', '1', '2', '3'],
      ['dummy2.csv', '1', '2', '3'],
    ]);
  });
}

describe('TestCSVStack', () => {
  const t = new CSVKitTestCase('csvstack', { defaultArgs: ['-'] });
  csvStackTests(t);
});

describe('TestNoHeaderRow', () => {
  const t = new CSVKitTestCase('csvstack', { defaultArgs: ['-'] });
  csvStackTests(t);

  test('test_no_header_row_basic', () => {
    t.assertRows(['--no-header-row', 'examples/no_header_row.csv', 'examples/no_header_row2.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  test('test_no_header_row_basic_stdin', () => {
    t.withStdin(fs.readFileSync('examples/no_header_row.csv'), () => {
      t.assertRows(['--no-header-row', '-', 'examples/no_header_row2.csv'], [
        ['a', 'b', 'c'],
        ['1', '2', '3'],
        ['4', '5', '6'],
      ]);
    });

    t.withStdin(fs.readFileSync('examples/no_header_row.csv'), () => {
      t.assertRows(['--no-header-row', 'examples/no_header_row2.csv', '-'], [
        ['a', 'b', 'c'],
        ['4', '5', '6'],
        ['1', '2', '3'],
      ]);
    });
  });

  test('test_grouped_manual_and_named_column', () => {
    t.assertRows(
      [
        '--no-header-row',
        '--groups',
        'foo,bar',
        '-n',
        'hey',
        'examples/dummy.csv',
        'examples/dummy3.csv',
      ],
      [
        ['hey', 'a', 'b', 'c'],
        ['foo', 'a', 'b', 'c'],
        ['foo', '1', '2', '3'],
        ['bar', 'a', 'b', 'c'],
        ['bar', '1', '2', '3'],
        ['bar', '1', '4', '5'],
      ],
    );
  });

  test('test_grouped_filenames', () => {
    t.assertRows(
      [
        '-H',
        '--filenames',
        'examples/no_header_row.csv',
        'examples/no_header_row2.csv',
      ],
      [
        ['group', 'a', 'b', 'c'],
        ['no_header_row.csv', '1', '2', '3'],
        ['no_header_row2.csv', '4', '5', '6'],
      ],
    );
  });

  test('test_grouped_filenames_and_named_column', () => {
    t.assertRows(
      [
        '-H',
        '--filenames',
        '-n',
        'hello',
        'examples/no_header_row.csv',
        'examples/no_header_row2.csv',
      ],
      [
        ['hello', 'a', 'b', 'c'],
        ['no_header_row.csv', '1', '2', '3'],
        ['no_header_row2.csv', '4', '5', '6'],
      ],
    );
  });
});
