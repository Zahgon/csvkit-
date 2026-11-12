'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_in2csv.py (MIT).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { describe, test } = require('node:test');
const { CSVKitTestCase, emptyFileTests, readText } = require('../utils');

describe('TestIn2CSV', () => {
  const t = new CSVKitTestCase('in2csv', { defaultArgs: ['-f', 'csv'] });
  emptyFileTests(t);

  function assertConverted(inputFormat, inputFilename, outputFilename, additionalArgs = []) {
    const output = t.getOutput(['-f', inputFormat, inputFilename, ...additionalArgs]);

    assert.equal(output, readText(outputFilename));
  }

  function removeIfExists(file) {
    fs.rmSync(file, { force: true });
  }

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_version', () => {
    const r = t.run(['-V']);

    assert.equal(r.status, 0);
  });

  test('test_args', async (s) => {
    for (const args of [[], ['-']]) {
      await s.test(`args=${JSON.stringify(args)}`, () => {
        t.assertError(
          [],
          'You must specify a format when providing input as piped data via STDIN.',
          args,
        );
      });
    }
  });

  test('test_options', async (s) => {
    for (const [options, args, message] of [
      [
        [],
        ['dummy.unknown'],
        'Unable to automatically determine the format of the input file. '
        + 'Try specifying a format with --format.',
      ],
      [
        ['-n'],
        ['dummy.csv'],
        'You cannot use the -n or --names options with non-Excel files.',
      ],
    ]) {
      await s.test(`args=${JSON.stringify([...options, ...args])}`, () => {
        t.assertError(options, message, args);
      });
    }
  });

  test('test_locale', () => {
    assertConverted('csv', 'examples/test_locale.csv',
      'examples/test_locale_converted.csv', ['--locale', 'de_DE']);
  });

  test('test_add_bom', () => {
    assertConverted('csv', 'examples/test_utf8.csv',
      'examples/test_utf8_bom.csv', ['--add-bom']);
  });

  test('test_no_blanks', () => {
    assertConverted('csv', 'examples/blanks.csv', 'examples/blanks_converted.csv');
  });

  test('test_blanks', () => {
    assertConverted('csv', 'examples/blanks.csv', 'examples/blanks.csv', ['--blanks']);
  });

  test('test_null_value', () => {
    t.withStdin('a,b\nn/a,\\N', () => {
      t.assertLines(['-f', 'csv', '--null-value', '\\N'], [
        'a,b',
        ',',
      ]);
    });
  });

  test('test_null_value_blanks', () => {
    t.withStdin('a,b\nn/a,\\N', () => {
      t.assertLines(['-f', 'csv', '--null-value', '\\N', '--blanks'], [
        'a,b',
        'n/a,',
      ]);
    });
  });

  test('test_no_leading_zeroes', () => {
    assertConverted('csv', 'examples/test_no_leading_zeroes.csv',
      'examples/test_no_leading_zeroes.csv', ['--no-leading-zeroes']);
  });

  test('test_date_format', () => {
    assertConverted('csv', 'examples/test_date_format.csv',
      'examples/test_date_format_converted.csv', ['--date-format', '%d/%m/%Y']);
  });

  test('test_date_format_default', () => {
    assertConverted('csv', 'examples/test_date_format.csv', 'examples/test_date_format.csv');
  });

  test('test_numeric_date_format', () => {
    assertConverted('csv', 'examples/test_numeric_date_format.csv',
      'examples/test_date_format_converted.csv', ['--date-format', '%Y%m%d']);
  });

  test('test_numeric_date_format_default', () => {
    assertConverted('csv', 'examples/test_numeric_date_format.csv', 'examples/test_numeric_date_format.csv');
  });

  test('test_date_like_number', () => {
    assertConverted('csv', 'examples/date_like_number.csv', 'examples/date_like_number.csv');
  });

  test('test_convert_csv', () => {
    assertConverted('csv', 'examples/testfixed_converted.csv', 'examples/testfixed_converted.csv');
  });

  test('test_convert_csv_with_skip_lines', () => {
    assertConverted('csv', 'examples/test_skip_lines.csv', 'examples/dummy.csv',
      ['--skip-lines', '3', '--no-inference']);
  });

  test('test_convert_tsv', () => {
    assertConverted('csv', 'examples/dummy.tsv', 'examples/dummy.csv', ['--no-inference']);
  });

  test('test_convert_tsv_streaming', () => {
    assertConverted('csv', 'examples/dummy.tsv', 'examples/dummy.csv',
      ['--no-inference', '--snifflimit', '0', '--tabs']);
  });

  test('test_convert_dbf', () => {
    assertConverted('dbf', 'examples/testdbf.dbf', 'examples/testdbf_converted.csv');
  });

  test('test_convert_json', () => {
    assertConverted('json', 'examples/testjson.json', 'examples/testjson_converted.csv');
  });

  test('test_convert_geojson', () => {
    assertConverted('geojson', 'examples/test_geojson.json', 'examples/test_geojson.csv');
  });

  test('test_convert_ndjson', () => {
    assertConverted('ndjson', 'examples/testjson_multiline.json', 'examples/testjson_multiline_converted.csv');
  });

  test('test_convert_nested_json', () => {
    assertConverted('json', 'examples/testjson_nested.json', 'examples/testjson_nested_converted.csv');
  });

  test('test_convert_xls', () => {
    assertConverted('xls', 'examples/test.xls', 'examples/testxls_converted.csv');
  });

  test('test_convert_xls_with_sheet', () => {
    assertConverted('xls', 'examples/sheets.xls', 'examples/testxls_converted.csv', ['--sheet', 'data']);
  });

  test('test_convert_xls_with_unicode_sheet', () => {
    t.assertLines(['--sheet', 'ʤ', 'examples/sheets.xls'], [
      'a,b,c',
      '1.0,2.0,3.0',
    ]);
  });

  test('test_convert_xls_with_skip_lines', () => {
    assertConverted('xls', 'examples/test_skip_lines.xls',
      'examples/testxls_converted.csv', ['--skip-lines', '3']);
  });

  test('test_convert_xlsx', () => {
    assertConverted('xlsx', 'examples/test.xlsx', 'examples/testxlsx_converted.csv');
  });

  test('test_convert_xlsx_with_sheet', () => {
    assertConverted('xlsx', 'examples/sheets.xlsx', 'examples/testxlsx_converted.csv', ['--sheet', 'data']);
  });

  test('test_convert_xlsx_with_unicode_sheet', () => {
    t.assertLines(['--sheet', 'ʤ', '--no-inference', 'examples/sheets.xlsx'], [
      'a,b,c',
      '1,2,3',
    ]);
  });

  test('test_convert_xlsx_with_skip_lines', () => {
    assertConverted('xlsx', 'examples/test_skip_lines.xlsx',
      'examples/testxlsx_converted.csv', ['--skip-lines', '3']);
  });

  test('test_names', () => {
    t.assertLines(['--names', 'examples/sheets.xlsx'], [
      'not this one',
      'data',
      'ʤ',
    ]);
  });

  test('test_csv_no_headers', () => {
    assertConverted('csv', 'examples/no_header_row.csv', 'examples/dummy.csv',
      ['--no-header-row', '--no-inference']);
  });

  test('test_csv_no_headers_streaming', () => {
    assertConverted('csv', 'examples/no_header_row.csv', 'examples/dummy.csv',
      ['--no-header-row', '--no-inference', '--snifflimit', '0']);
  });

  test('test_csv_datetime_inference', () => {
    t.withStdin('a\n2015-01-01T00:00:00Z', () => {
      t.assertLines(['-f', 'csv'], [
        'a',
        '2015-01-01T00:00:00+00:00',
      ]);
    });
  });

  test('test_csv_no_inference', () => {
    t.assertLines(['--no-inference', 'examples/dummy.csv'], [
      'a,b,c',
      '1,2,3',
    ]);
  });

  test('test_xls_no_inference', () => {
    t.assertLines(['--no-inference', 'examples/dummy.xls'], [
      'a,b,c',
      '1.0,2.0,3.0',
    ]);
  });

  test('test_xlsx_no_inference', () => {
    t.assertLines(['--no-inference', 'examples/dummy.xlsx'], [
      'a,b,c',
      '1,2,3',
    ]);
  });

  test('test_geojson_no_inference', () => {
    t.withStdin(
      '{"a": 1, "b": 2, "type": "FeatureCollection", "features": [{"geometry": {}, "properties": '
      + '{"a": 1, "b": 2, "c": 3}}]}',
      () => {
        t.assertLines(['--no-inference', '-f', 'geojson'], [
          'id,a,b,c,geojson,type,longitude,latitude',
          ',1,2,3,{},,,',
        ]);
      },
    );
  });

  test('test_json_no_inference', () => {
    t.withStdin('[{"a": 1, "b": 2, "c": 3}]', () => {
      t.assertLines(['--no-inference', '-f', 'json'], [
        'a,b,c',
        '1,2,3',
      ]);
    });
  });

  test('test_ndjson_no_inference', () => {
    t.withStdin('{"a": 1, "b": 2, "c": 3}', () => {
      t.assertLines(['--no-inference', '-f', 'ndjson'], [
        'a,b,c',
        '1,2,3',
      ]);
    });
  });

  test('test_names_xls', () => {
    const output = t.getOutputAsIo(['-n', 'examples/sheets.xls']);

    assert.equal(output[0], 'not this one\n');
    assert.equal(output[1], 'data\n');
  });

  test('test_names_xlsx', () => {
    const output = t.getOutputAsIo(['-n', 'examples/sheets.xlsx']);

    assert.equal(output[0], 'not this one\n');
    assert.equal(output[1], 'data\n');
  });

  test('test_convert_xls_with_write_sheets', () => {
    try {
      assertConverted('xls', 'examples/sheets.xls', 'examples/testxls_converted.csv',
        ['--sheet', 'data', '--write-sheets', 'ʤ,1']);
      assert.equal(readText('examples/sheets_0.csv'), readText('examples/testxls_unicode_converted.csv'));
      assert.equal(readText('examples/sheets_1.csv'), readText('examples/testxls_converted.csv'));
      assert.ok(!fs.existsSync('examples/sheets_2.csv'));
    } finally {
      for (const suffix of [0, 1]) {
        removeIfExists(`examples/sheets_${suffix}.csv`);
      }
    }
  });

  test('test_convert_xlsx_with_write_sheets', () => {
    try {
      assertConverted('xlsx', 'examples/sheets.xlsx', 'examples/testxlsx_noinference_converted.csv',
        ['--no-inference', '--sheet', 'data', '--write-sheets', 'ʤ,1']);
      assert.equal(readText('examples/sheets_0.csv'), readText('examples/testxlsx_unicode_converted.csv'));
      assert.equal(readText('examples/sheets_1.csv'), readText('examples/testxlsx_noinference_converted.csv'));
      assert.ok(!fs.existsSync('examples/sheets_2.csv'));
    } finally {
      for (const suffix of [0, 1]) {
        removeIfExists(`examples/sheets_${suffix}.csv`);
      }
    }
  });

  test('test_convert_xls_with_write_sheets_with_names', () => {
    try {
      assertConverted('xls', 'examples/sheets.xls', 'examples/testxls_converted.csv',
        ['--sheet', 'data', '--write-sheets', 'ʤ,1', '--use-sheet-names']);
      assert.equal(readText('examples/sheets_ʤ.csv'), readText('examples/testxls_unicode_converted.csv'));
      assert.equal(readText('examples/sheets_data.csv'), readText('examples/testxls_converted.csv'));
      assert.ok(!fs.existsSync('examples/sheets_0.csv'));
      assert.ok(!fs.existsSync('examples/sheets_1.csv'));
      assert.ok(!fs.existsSync('examples/sheets_2.csv'));
    } finally {
      for (const suffix of ['ʤ', 'data']) {
        removeIfExists(`examples/sheets_${suffix}.csv`);
      }
    }
  });

  test('test_convert_xlsx_with_write_sheets_with_names', () => {
    try {
      assertConverted('xlsx', 'examples/sheets.xlsx', 'examples/testxlsx_noinference_converted.csv',
        ['--no-inference', '--sheet', 'data', '--write-sheets', 'ʤ,1', '--use-sheet-names']);
      assert.equal(readText('examples/sheets_ʤ.csv'), readText('examples/testxlsx_unicode_converted.csv'));
      assert.equal(readText('examples/sheets_data.csv'), readText('examples/testxlsx_noinference_converted.csv'));
      assert.ok(!fs.existsSync('examples/sheets_0.csv'));
      assert.ok(!fs.existsSync('examples/sheets_1.csv'));
      assert.ok(!fs.existsSync('examples/sheets_2.csv'));
    } finally {
      for (const suffix of ['ʤ', 'data']) {
        removeIfExists(`examples/sheets_${suffix}.csv`);
      }
    }
  });
});
