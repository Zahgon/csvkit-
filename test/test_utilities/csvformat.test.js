'use strict';
// Port of csvkit 2.2.0 tests/test_utilities/test_csvformat.py (MIT).

const { describe, test } = require('node:test');
const { CSVKitTestCase, emptyFileTests } = require('../utils');

describe('TestCSVFormat', () => {
  const t = new CSVKitTestCase('csvformat');
  emptyFileTests(t);

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_skip_lines', () => {
    t.assertLines(['--skip-lines', '3', '-D', '|', 'examples/test_skip_lines.csv'], [
      'a|b|c',
      '1|2|3',
    ]);
  });

  test('test_skip_header', () => {
    t.assertLines(['--skip-header', 'examples/dummy.csv'], [
      '1,2,3',
    ]);
  });

  test('test_skip_header_no_header_row', () => {
    t.assertLines(['--no-header-row', '--skip-header', 'examples/no_header_row.csv'], [
      '1,2,3',
    ]);
  });

  test('test_no_header_row', () => {
    t.assertLines(['--no-header-row', 'examples/no_header_row.csv'], [
      'a,b,c',
      '1,2,3',
    ]);
  });

  test('test_linenumbers', () => {
    t.assertLines(['--linenumbers', 'examples/dummy.csv'], [
      'line_number,a,b,c',
      '1,1,2,3',
    ]);
  });

  test('test_delimiter', () => {
    t.assertLines(['-D', '|', 'examples/dummy.csv'], [
      'a|b|c',
      '1|2|3',
    ]);
  });

  test('test_tabs', () => {
    t.assertLines(['-T', 'examples/dummy.csv'], [
      'a\tb\tc',
      '1\t2\t3',
    ]);
  });

  test('test_asv', () => {
    t.assertLines(['-A', 'examples/dummy.csv'], [
      'a\x1fb\x1fc\x1e1\x1f2\x1f3\x1e',
    ], false);
  });

  test('test_quotechar', () => {
    t.withStdin('a,b,c\n1#2,3,4\n', () => {
      t.assertLines(['-Q', '#'], [
        'a,b,c',
        '#1##2#,3,4',
      ]);
    });
  });

  test('test_doublequote', () => {
    t.withStdin('a\n"a ""quoted"" string"', () => {
      t.assertLines(['-P', '#', '-B'], [
        'a',
        'a #"quoted#" string',
      ]);
    });
  });

  test('test_escapechar', () => {
    t.withStdin('a,b,c\n1"2,3,4\n', () => {
      t.assertLines(['-P', '#', '-U', '3'], [
        'a,b,c',
        '1#"2,3,4',
      ]);
    });
  });

  test('test_lineterminator', () => {
    t.assertLines(['-M', 'XYZ', 'examples/dummy.csv'], [
      'a,b,cXYZ1,2,3XYZ',
    ], false);
  });
});

describe('TestCSVFormatQuoteNonNumeric', () => {
  const t = new CSVKitTestCase('csvformat');
  emptyFileTests(t);

  // New test compared to TestCSVFormat.
  test('test_locale', () => {
    t.assertLines(['-U', '2', '--locale', 'de_DE', 'examples/test_locale.csv'], [
      '"a","b","c"',
      '1.7,200000000,""',
    ]);
  });

  test('test_launch_new_instance', () => {
    t.launchNewInstance(['examples/dummy.csv']);
  });

  test('test_skip_lines', () => {
    t.assertLines(['-U', '2', '--skip-lines', '3', '-D', '|', 'examples/test_skip_lines.csv'], [
      '"a"|"b"|"c"',
      '1|2|3',
    ]);
  });

  test('test_skip_header', () => {
    t.assertLines(['-U', '2', '--skip-header', 'examples/dummy.csv'], [
      '1,2,3',
    ]);
  });

  test('test_skip_header_no_header_row', () => {
    t.assertLines(['-U', '2', '--no-header-row', '--skip-header', 'examples/no_header_row.csv'], [
      '1,2,3',
    ]);
  });

  test('test_no_header_row', () => {
    t.assertLines(['-U', '2', '--no-header-row', 'examples/no_header_row.csv'], [
      '"a","b","c"',
      '1,2,3',
    ]);
  });

  test('test_linenumbers', () => {
    t.assertLines(['-U', '2', '--linenumbers', 'examples/dummy.csv'], [
      '"line_number","a","b","c"',
      '1,1,2,3',
    ]);
  });

  test('test_delimiter', () => {
    t.assertLines(['-U', '2', '-D', '|', 'examples/dummy.csv'], [
      '"a"|"b"|"c"',
      '1|2|3',
    ]);
  });

  test('test_tabs', () => {
    t.assertLines(['-U', '2', '-T', 'examples/dummy.csv'], [
      '"a"\t"b"\t"c"',
      '1\t2\t3',
    ]);
  });

  test('test_asv', () => {
    t.assertLines(['-U', '2', '-A', 'examples/dummy.csv'], [
      '"a"\x1f"b"\x1f"c"\x1e1\x1f2\x1f3\x1e',
    ], false);
  });

  test('test_quotechar', () => {
    t.withStdin('a,b,c\n1#2,3,4\n', () => {
      t.assertLines(['-U', '2', '-Q', '#'], [
        '#a#,#b#,#c#',
        '#1##2#,3,4',
      ]);
    });
  });

  test('test_doublequote', () => {
    t.withStdin('a\n"a ""quoted"" string"', () => {
      t.assertLines(['-U', '2', '-P', '#', '-B'], [
        '"a"',
        '"a #"quoted#" string"',
      ]);
    });
  });

  test('test_escapechar', () => {
    t.withStdin('a,b,c\n1"2,3,4\n', () => {
      t.assertLines(['-U', '2', '-P', '#', '-U', '3'], [
        'a,b,c',
        '1#"2,3,4',
      ]);
    });
  });

  test('test_lineterminator', () => {
    t.assertLines(['-U', '2', '-M', 'XYZ', 'examples/dummy.csv'], [
      '"a","b","c"XYZ1,2,3XYZ',
    ], false);
  });
});
