'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvjoin.py (MIT).

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { CSVKitTestCase, emptyFileTests, readText, splitLinesKeepEnds } = require('../utils');

describe('TestCSVJoin', () => {
  const t = new CSVKitTestCase('csvjoin', { defaultArgs: ['examples/dummy.csv', '-'] });
  emptyFileTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/join_a.csv', 'examples/join_b.csv']);
  });

  test('test_options', async (s) => {
    for (const [args, message] of [
      [
        // Upstream writes ['-c' '1,2'], which Python concatenates into one argument.
        ['-c1,2'],
        'The number of join column names must match the number of files, '
        + 'or be a single column name that exists in all files.',
      ],
      [['-c', '1', '--left', '--right'], 'It is not valid to specify both a left and a right join.'],
    ]) {
      await s.test(`args=${JSON.stringify(args)}`, () => {
        t.assertError(args, message);
      });
    }
  });

  test('test_join_options', async (s) => {
    for (const option of ['--left', '--right', '--outer']) {
      await s.test(`option=${option}`, () => {
        t.assertError(
          [option],
          'You must provide join column names when performing an outer join.',
        );
      });
    }
  });

  test('test_glob', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    t.assertRows(['--no-inference', '-c', 'a', 'examples/dummy?.csv'], [
      ['a', 'b', 'c', 'b2', 'c2'],
      ['1', '2', '3', '2', '3'],
      ['1', '2', '3', '4', '5'],
    ]);
  });

  test('test_sequential', () => {
    const output = t.getOutputAsIo(['examples/join_a.csv', 'examples/join_b.csv']);
    assert.equal(output.length, 4);
  });

  test('test_inner', () => {
    const output = t.getOutputAsIo(['-c', 'a', 'examples/join_a.csv', 'examples/join_b.csv']);
    assert.equal(output.length, 3);
  });

  test('test_left', () => {
    const output = t.getOutputAsIo(['-c', 'a', '--left', 'examples/join_a.csv', 'examples/join_b.csv']);
    assert.equal(output.length, 5);
  });

  test('test_right', () => {
    const output = t.getOutputAsIo(['-c', 'a', '--right', 'examples/join_a.csv', 'examples/join_b.csv']);
    assert.equal(output.length, 4);
  });

  test('test_right_indices', () => {
    const output = t.getOutputAsIo(['-c', '1,4', '--right', 'examples/join_a.csv', 'examples/blanks.csv']);
    assert.equal(output.length, 2);
  });

  test('test_outer', () => {
    const output = t.getOutputAsIo(['-c', 'a', '--outer', 'examples/join_a.csv', 'examples/join_b.csv']);
    assert.equal(output.length, 6);
  });

  test('test_left_short_columns', () => {
    const output = t.getOutputAsIo(['-c', 'a', 'examples/join_a_short.csv', 'examples/join_b.csv']);
    assert.deepEqual(output, splitLinesKeepEnds(readText('examples/join_short.csv')));
  });

  test('test_single', () => {
    t.assertRows(['examples/dummy.csv', '--no-inference'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_no_blanks', () => {
    t.assertRows(['examples/blanks.csv', 'examples/blanks.csv'], [
      ['a', 'b', 'c', 'd', 'e', 'f', 'a2', 'b2', 'c2', 'd2', 'e2', 'f2'],
      ['', '', '', '', '', '', '', '', '', '', '', ''],
    ]);
  });

  test('test_blanks', () => {
    t.assertRows(['--blanks', 'examples/blanks.csv', 'examples/blanks.csv'], [
      ['a', 'b', 'c', 'd', 'e', 'f', 'a2', 'b2', 'c2', 'd2', 'e2', 'f2'],
      ['', 'NA', 'N/A', 'NONE', 'NULL', '.', '', 'NA', 'N/A', 'NONE', 'NULL', '.'],
    ]);
  });

  test('test_no_header_row', () => {
    const output = t.getOutputAsIo(
      ['-c', '1', '--no-header-row', 'examples/join_a.csv', 'examples/join_no_header_row.csv'],
    );
    assert.equal(output.length, 3);
  });

  test('test_no_inference', () => {
    t.assertRows(['--no-inference', 'examples/join_a.csv', 'examples/join_short.csv'], [
      ['a', 'b', 'c', 'a2', 'b2', 'c2', 'b2_2', 'c2_2'],
      ['1', 'b', 'c', '1', 'b', '', 'b', 'c'],
      ['2', 'b', 'c', '1', 'b', '', 'b', 'c'],
      ['3', 'b', 'c', '', '', '', '', ''],
    ]);
  });

  test('test_sniff_limit_no_limit', () => {
    t.assertRows(['examples/join_a.csv', 'examples/sniff_limit.csv'], [
      ['a', 'b', 'c', 'a2', 'b2', 'c2'],
      ['1', 'b', 'c', 'True', '2', '3'],
      ['2', 'b', 'c', '', '', ''],
      ['3', 'b', 'c', '', '', ''],
    ]);
  });

  test('test_sniff_limit_zero_limit', () => {
    t.assertRows(['--snifflimit', '0', 'examples/join_a.csv', 'examples/sniff_limit.csv'], [
      ['a', 'b', 'c', 'a;b;c'],
      ['1', 'b', 'c', '1;2;3'],
      ['2', 'b', 'c', ''],
      ['3', 'b', 'c', ''],
    ]);
  });
});
