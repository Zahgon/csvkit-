'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvclean.py (MIT).

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { CSVKitTestCase, csvRows, emptyFileTests } = require('../utils');

describe('TestCSVClean', () => {
  const t = new CSVKitTestCase('csvclean', { defaultArgs: ['--length-mismatch'] });
  emptyFileTests(t);

  // Error rows go to standard error and make csvclean exit with status 1.
  function assertCleaned(args, outputRows, errorRows = []) {
    const r = t.run(args);

    if (errorRows.length) {
      assert.equal(r.status, 1);
    } else {
      assert.equal(r.status, 0, r.stderr);
    }

    if (outputRows.length) {
      assert.deepEqual(csvRows(r.stdout), outputRows);
    }
    if (errorRows.length) {
      assert.deepEqual(csvRows(r.stderr), errorRows);
    }
  }

  test('test_launch_new_instance', () => {
    t.launchNewInstance([...t.defaultArgs, 'examples/dummy.csv']);
  });

  test('test_options', async (s) => {
    for (const [args, message] of [
      [
        [],
        'No checks or fixes were enabled. See available options with: csvclean --help',
      ],
      [
        ['--join-short-rows', '--fill-short-rows'],
        'The --join-short-rows and --fill-short-rows options are mutually exclusive.',
      ],
    ]) {
      await s.test(`args=${JSON.stringify(args)}`, () => {
        t.assertError(args, message);
      });
    }
  });

  test('test_skip_lines', () => {
    assertCleaned(
      ['--length-mismatch', '--omit-error-rows', '--skip-lines', '3', 'examples/bad_skip_lines.csv'],
      [
        ['column_a', 'column_b', 'column_c'],
        ['0', 'mixed types.... uh oh', '17'],
      ], [
        ['line_number', 'msg', 'column_a', 'column_b', 'column_c'],
        ['1', 'Expected 3 columns, found 4 columns', '1', '27', '', "I'm too long!"],
        ['2', 'Expected 3 columns, found 2 columns', '', "I'm too short!"],
      ],
    );
  });

  test('test_simple', () => {
    assertCleaned(['--length-mismatch', '--omit-error-rows', 'examples/bad.csv'], [
      ['column_a', 'column_b', 'column_c'],
      ['0', 'mixed types.... uh oh', '17'],
    ], [
      ['line_number', 'msg', 'column_a', 'column_b', 'column_c'],
      ['1', 'Expected 3 columns, found 4 columns', '1', '27', '', "I'm too long!"],
      ['2', 'Expected 3 columns, found 2 columns', '', "I'm too short!"],
    ]);
  });

  test('test_no_header_row', () => {
    assertCleaned(['--length-mismatch', 'examples/no_header_row.csv'], [
      ['1', '2', '3'],
    ]);
  });

  test('test_header_normalize_space', () => {
    assertCleaned(['--header-normalize-space', 'examples/test_header_newline.csv'], [
      ['start end', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  test('test_join_short_rows', () => {
    assertCleaned(['--omit-error-rows', '--join-short-rows', 'examples/test_join_short_rows.csv'], [
      ['a', 'b', 'c'],
      ['1', 'cat\ndog', 'c'],
      ['3', 'b', 'c'],
    ]);
  });

  test('test_join_short_rows_separator', () => {
    assertCleaned(
      ['--omit-error-rows', '--join-short-rows', '--separator', 'XYZ', 'examples/test_join_short_rows.csv'],
      [
        ['a', 'b', 'c'],
        ['1', 'catXYZdog', 'c'],
        ['3', 'b', 'c'],
      ],
    );
  });

  test('test_fill_short_rows', () => {
    assertCleaned(['--fill-short-rows', 'examples/test_join_short_rows.csv'], [
      ['a', 'b', 'c'],
      ['1', 'cat', ''],
      ['dog', 'c', ''],
      ['3', 'b', 'c'],
    ]);
  });

  test('test_fill_short_rows_separator', () => {
    assertCleaned(['--fill-short-rows', '--fillvalue', 'XYZ', 'examples/test_join_short_rows.csv'], [
      ['a', 'b', 'c'],
      ['1', 'cat', 'XYZ'],
      ['dog', 'c', 'XYZ'],
      ['3', 'b', 'c'],
    ]);
  });

  test('test_empty_columns', () => {
    assertCleaned(['--empty-columns', 'examples/test_empty_columns.csv'], [
      ['a', 'b', 'c', '', ''],
      ['a', '', '', '', ''],
      ['', '', 'c', ''],
      ['', '', '', '', ''],
    ], [
      ['line_number', 'msg', 'a', 'b', 'c', '', ''],
      ['1', "Empty columns named 'b', '', ''! Try: csvcut -C 2,4,5", '', '', '', '', ''],
    ]);
  });

  test('test_empty_columns_short_row', () => {
    assertCleaned(['--empty-columns', 'examples/test_empty_columns_short_row.csv'], [
      ['a', 'b', 'c'],
      ['', ''],
    ], [
      ['line_number', 'msg', 'a', 'b', 'c'],
      ['1', "Empty columns named 'a', 'b', 'c'! Try: csvcut -C 1,2,3", '', '', ''],
    ]);
  });

  test('test_empty_columns_long_row', () => {
    assertCleaned(['--empty-columns', 'examples/test_empty_columns_long_row.csv'], [
      ['a', 'b', 'c'],
      ['', '', '', ''],
    ], [
      ['line_number', 'msg', 'a', 'b', 'c'],
      ['1', "Empty columns named 'a', 'b', 'c'! Try: csvcut -C 1,2,3", '', '', ''],
    ]);
  });

  test('test_empty_columns_zero', () => {
    assertCleaned(['--empty-columns', '--zero', 'examples/test_empty_columns.csv'], [
      ['a', 'b', 'c', '', ''],
      ['a', '', '', '', ''],
      ['', '', 'c', ''],
      ['', '', '', '', ''],
    ], [
      ['line_number', 'msg', 'a', 'b', 'c', '', ''],
      ['1', "Empty columns named 'b', '', ''! Try: csvcut -C 1,3,4", '', '', '', '', ''],
    ]);
  });

  test('test_enable_all_checks', () => {
    assertCleaned(['-a', 'examples/test_empty_columns.csv'], [
      ['a', 'b', 'c', '', ''],
      ['a', '', '', '', ''],
      ['', '', 'c', ''],
      ['', '', '', '', ''],
    ], [
      ['line_number', 'msg', 'a', 'b', 'c', '', ''],
      ['2', 'Expected 5 columns, found 4 columns', '', '', 'c', ''],
      ['1', "Empty columns named 'b', '', ''! Try: csvcut -C 2,4,5", '', '', '', '', ''],
    ]);
  });

  test('test_label', () => {
    assertCleaned(['-a', '--label', 'xyz', 'examples/test_empty_columns.csv'], [
      ['a', 'b', 'c', '', ''],
      ['a', '', '', '', ''],
      ['', '', 'c', ''],
      ['', '', '', '', ''],
    ], [
      ['label', 'line_number', 'msg', 'a', 'b', 'c', '', ''],
      ['xyz', '2', 'Expected 5 columns, found 4 columns', '', '', 'c', ''],
      ['xyz', '1', "Empty columns named 'b', '', ''! Try: csvcut -C 2,4,5", '', '', '', '', ''],
    ]);
  });

  test('test_label_default', () => {
    assertCleaned(['-a', '--label', '-', 'examples/test_empty_columns.csv'], [
      ['a', 'b', 'c', '', ''],
      ['a', '', '', '', ''],
      ['', '', 'c', ''],
      ['', '', '', '', ''],
    ], [
      ['label', 'line_number', 'msg', 'a', 'b', 'c', '', ''],
      ['examples/test_empty_columns.csv', '2', 'Expected 5 columns, found 4 columns', '', '', 'c', ''],
      ['examples/test_empty_columns.csv', '1', "Empty columns named 'b', '', ''! Try: csvcut -C 2,4,5", '', '', '', '', ''],
    ]);
  });

  test('test_label_default_stdin', () => {
    t.withStdin('a,b,c\n,\n', () => {
      assertCleaned(['-a', '--label', '-'], [
        ['a', 'b', 'c'],
        ['', ''],
      ], [
        ['label', 'line_number', 'msg', 'a', 'b', 'c'],
        ['stdin', '1', 'Expected 3 columns, found 2 columns', '', ''],
        ['stdin', '1', "Empty columns named 'a', 'b', 'c'! Try: csvcut -C 1,2,3", '', '', ''],
      ]);
    });
  });

  test('test_removes_optional_quote_characters', () => {
    assertCleaned(['--length-mismatch', 'examples/optional_quote_characters.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_changes_line_endings', () => {
    assertCleaned(['--length-mismatch', 'examples/mac_newlines.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['Once upon\na time', '5', '6'],
    ]);
  });

  test('test_changes_character_encoding', () => {
    assertCleaned(['--length-mismatch', '-e', 'latin1', 'examples/test_latin1.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '©'],
    ]);
  });

  test('test_removes_bom', () => {
    assertCleaned(['--length-mismatch', 'examples/test_utf8_bom.csv'], [
      ['foo', 'bar', 'baz'],
      ['1', '2', '3'],
      ['4', '5', 'ʤ'],
    ]);
  });
});
