'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvgrep.py (MIT).

const { describe, test } = require('node:test');
const { CSVKitTestCase, columnsTests, emptyFileTests, namesTests } = require('../utils');

describe('TestCSVGrep', () => {
  const t = new CSVKitTestCase('csvgrep', { defaultArgs: ['-c', '1', '-m', '1'], columnsArgs: ['-m', '1'] });
  columnsTests(t);
  emptyFileTests(t);
  namesTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance([...t.defaultArgs, 'examples/dummy.csv']);
  });

  test('test_options', async (s) => {
    for (const [args, message] of [
      [[], 'You must specify at least one column to search using the -c option.'],
      [['-c', '1'], 'One of -r, -m or -f must be specified, unless using the -n option.'],
    ]) {
      await s.test(`args=${JSON.stringify(args)}`, () => {
        t.assertError(args, message);
      });
    }
  });

  test('test_skip_lines', () => {
    t.assertRows(['--skip-lines', '3', '-c', '1', '-m', '1', 'examples/test_skip_lines.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_match', () => {
    t.assertRows(['-c', '1', '-m', '1', 'examples/dummy.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_any_match', () => {
    t.assertRows(['-c', '1,2,3', '-a', '-m', '1', 'examples/dummy.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_match_utf8', () => {
    t.assertRows(['-c', '3', '-m', 'ʤ', 'examples/test_utf8.csv'], [
      ['foo', 'bar', 'baz'],
      ['4', '5', 'ʤ'],
    ]);
  });

  test('test_match_utf8_bom', () => {
    t.assertRows(['-c', '3', '-m', 'ʤ', 'examples/test_utf8_bom.csv'], [
      ['foo', 'bar', 'baz'],
      ['4', '5', 'ʤ'],
    ]);
  });

  test('test_no_match', () => {
    t.assertRows(['-c', '1', '-m', 'NO MATCH', 'examples/dummy.csv'], [
      ['a', 'b', 'c'],
    ]);
  });

  test('test_invert_match', () => {
    t.assertRows(['-c', '1', '-i', '-m', 'NO MATCH', 'examples/dummy.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_re_match', () => {
    t.assertRows(['-c', '3', '-r', '^(3|9)$', 'examples/dummy.csv'], [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('test_re_match_utf8', () => {
    t.assertRows(['-c', '3', '-r', 'ʤ', 'examples/test_utf8.csv'], [
      ['foo', 'bar', 'baz'],
      ['4', '5', 'ʤ'],
    ]);
  });

  test('test_string_match', () => {
    t.assertRows(['-c', '1', '-m', 'ILLINOIS',
      'examples/realdata/FY09_EDU_Recipients_by_State.csv'], [
      ['State Name', 'State Abbreviate', 'Code', 'Montgomery GI Bill-Active Duty',
        'Montgomery GI Bill- Selective Reserve', 'Dependents\' Educational Assistance',
        'Reserve Educational Assistance Program', 'Post-Vietnam Era Veteran\'s Educational Assistance Program',
        'TOTAL', ''],
      ['ILLINOIS', 'IL', '17', '15,659', '2,491', '2,025', '1,770', '19', '21,964', ''],
    ]);
  });

  test('test_match_with_line_numbers', () => {
    t.assertRows(['-c', '1', '-m', 'ILLINOIS', '--linenumbers',
      'examples/realdata/FY09_EDU_Recipients_by_State.csv'], [
      ['line_numbers', 'State Name', 'State Abbreviate', 'Code', 'Montgomery GI Bill-Active Duty',
        'Montgomery GI Bill- Selective Reserve', 'Dependents\' Educational Assistance',
        'Reserve Educational Assistance Program', 'Post-Vietnam Era Veteran\'s Educational Assistance Program',
        'TOTAL', ''],
      ['14', 'ILLINOIS', 'IL', '17', '15,659', '2,491', '2,025', '1,770', '19', '21,964', ''],
    ]);
  });

  test('test_kwargs_with_line_numbers', () => {
    t.assertRows(['-t', '-c', '1', '-m', '1', '--linenumbers', 'examples/dummy.tsv'], [
      ['line_numbers', 'a', 'b', 'c'],
      ['1', '1', '2', '3'],
    ]);
  });
});
