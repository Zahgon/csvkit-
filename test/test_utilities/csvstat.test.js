'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvstat.py (MIT).

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { CSVKitTestCase, columnsTests, csvRows, emptyFileTests, namesTests } = require('../utils');

describe('TestCSVStat', () => {
  const t = new CSVKitTestCase('csvstat');
  columnsTests(t);
  emptyFileTests(t);
  namesTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_options', () => {
    t.assertError(
      ['--min', '--max'],
      'Only one operation argument may be specified (--mean, --median, etc).',
    );
  });

  test('test_format_options', async (s) => {
    for (const option of ['csv', 'json', 'count']) {
      await s.test(`option=${option}`, () => {
        t.assertError(
          ['--min', `--${option}`],
          `You may not specify --${option} and an operation (--mean, --median, etc) at the same time.`,
        );
      });
    }
  });

  test('test_runs', () => {
    // Test that csvstat doesn't error on UTF-8 input.
    t.getOutput(['examples/test_utf8.csv']);
  });

  test('test_encoding', () => {
    // Test that csvstat doesn't error on Latin-1 input.
    t.getOutput(['-e', 'latin1', 'examples/test_latin1.csv']);
  });

  test('test_columns', () => {
    const output = t.getOutput(['-c', '2', 'examples/testxls_converted.csv']);
    assert.ok(!output.includes('1. "text"'));
    assert.ok(output.includes('2. "date"'));
  });

  test('test_linenumbers', () => {
    const output = t.getOutput(['-c', '2', '--linenumbers', 'examples/dummy.csv']);
    assert.ok(!output.includes('1. "a"'));
    assert.ok(output.includes('2. "b"'));
  });

  test('test_no_header_row', () => {
    const output = t.getOutput(['-c', '2', '--no-header-row', 'examples/no_header_row.csv']);
    assert.ok(!output.includes('1. "a"'));
    assert.ok(output.includes('2. "b"'));
  });

  test('test_count_only', () => {
    const output = t.getOutput(['--count', 'examples/realdata/ks_1033_data.csv']);
    assert.equal(output, '1575\n');
  });

  test('test_unique', () => {
    const output = t.getOutput(['-c', 'county', 'examples/realdata/ks_1033_data.csv']);
    assert.match(output, /Unique values:\s+73/);
  });

  test('test_max_length', () => {
    const output = t.getOutput(['-c', 'county', 'examples/realdata/ks_1033_data.csv']);
    assert.match(output, /Longest value:\s+12/);
  });

  test('test_freq_list', () => {
    const output = t.getOutput(['examples/realdata/ks_1033_data.csv']);

    assert.ok(output.includes('WYANDOTTE (123x)'));
    assert.ok(output.includes('SALINE (59x)'));
    assert.ok(!output.includes('MIAMI (56x)'));
  });

  test('test_freq', () => {
    const output = t.getOutput(['examples/realdata/ks_1033_data.csv', '--freq']);

    assert.ok(output.includes('  1. state: { "KS": 1575 }'));
  });

  test('test_freq_count', () => {
    const output = t.getOutput(['examples/realdata/ks_1033_data.csv', '--freq-count', '1']);

    assert.ok(output.includes('WYANDOTTE (123x)'));
    assert.ok(!output.includes('FINNEY (103x)'));
    assert.ok(!output.includes('MIAMI (56x)'));
  });

  test('test_csv', () => {
    const reader = csvRows(t.getOutput(['--csv', 'examples/realdata/ks_1033_data.csv']));

    const header = reader[0];

    assert.equal(header[1], 'column_name');
    assert.equal(header[5], 'unique');

    const row = reader[1];

    assert.equal(row[1], 'state');
    assert.equal(row[2], 'Text');
    assert.equal(row[6], '');
    assert.equal(row[12], '2');
  });

  test('test_csv_columns', () => {
    const reader = csvRows(t.getOutput(['--csv', '-c', '4', 'examples/realdata/ks_1033_data.csv']));

    const header = reader[0];

    assert.equal(header[1], 'column_name');
    assert.equal(header[5], 'unique');

    const row = reader[1];

    assert.equal(row[1], 'nsn');
    assert.equal(row[2], 'Text');
    assert.equal(row[6], '');
    assert.equal(row[12], '16');
  });

  test('test_json', () => {
    const data = JSON.parse(t.getOutput(['--json', 'examples/realdata/ks_1033_data.csv']));

    const header = Object.keys(data[0]);

    assert.equal(header[1], 'column_name');
    assert.equal(header[5], 'unique');

    const row = Object.values(data[0]);

    assert.equal(row[1], 'state');
    assert.equal(row[2], 'Text');
    assert.ok(!('min' in data[0]));
    assert.equal(row.at(-2), 2.0);
  });

  test('test_json_columns', () => {
    const data = JSON.parse(t.getOutput(['--json', '-c', '4', 'examples/realdata/ks_1033_data.csv']));

    const header = Object.keys(data[0]);

    assert.equal(header[1], 'column_name');
    assert.equal(header[5], 'unique');

    const row = Object.values(data[0]);

    assert.equal(row[1], 'nsn');
    assert.equal(row[2], 'Text');
    assert.ok(!('min' in data[0]));
    assert.equal(row.at(-2), 16.0);
  });

  // csvstat groups digits by the process locale (locale.setlocale(LC_ALL, '')): under C.UTF-8, the reference
  // environment, there is no grouping separator, and the original prints 9748.346 and fails this test too.
  test('test_decimal_format', { skip: 'needs a locale with a grouping separator; C.UTF-8 has none' }, () => {
    let output = t.getOutput(['-c', 'TOTAL', '--mean', 'examples/realdata/FY09_EDU_Recipients_by_State.csv']);

    assert.equal(output, '9,748.346\n');

    output = t.getOutput([
      '-c', 'TOTAL', '--mean', '--no-grouping-separator', 'examples/realdata/FY09_EDU_Recipients_by_State.csv',
    ]);

    assert.equal(output, '9748.346\n');

    output = t.getOutput([
      '-c', 'TOTAL', '--mean', '--decimal-format', '%.2f', 'examples/realdata/FY09_EDU_Recipients_by_State.csv',
    ]);

    assert.equal(output, '9,748.35\n');
  });
});
