'use strict';
// Port of csvkit 2.2.0 tests/test_convert/test_fixed.py (MIT). The port's fixed2csv always streams to an output
// object, so the non-streaming upstream calls collect the output the same way.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { InputFile } = require('../../lib/cli');
const fixed = require('../../lib/convert');
const { CSVKitTestCase, readText, splitLinesKeepEnds } = require('../utils');

/** open(path) as the port reads input files. */
function open(file) {
  return new InputFile(file, 'utf-8', false);
}

/** fixed2csv(f, schema, skip_lines=...): the converted CSV text. */
function fixed2csv(f, schema, skipLines = 0) {
  let output = '';
  fixed.fixed2csv(f, schema, { write: (s) => { output += s; } }, skipLines);
  return output;
}

describe('TestFixed', () => {
  const t = new CSVKitTestCase('in2csv');

  test('test_fixed', () => {
    const output = fixed2csv(open('examples/testfixed'), open('examples/testfixed_schema.csv'));

    assert.equal(readText('examples/testfixed_converted.csv'), output);
  });

  test('test_fixed_skip_lines', () => {
    const output = fixed2csv(open('examples/testfixed_skip_lines'), open('examples/testfixed_schema.csv'), 3);

    assert.equal(readText('examples/testfixed_converted.csv'), output);
  });

  test('test_fixed_no_inference', () => {
    t.withStdin('     1   2 3', () => {
      t.assertLines(['--no-inference', '-f', 'fixed', '--schema',
        'examples/testfixed_schema_no_inference.csv'], [
        'a,b,c',
        '1,2,3',
      ]);
    });
  });

  test('test_fixed_streaming', () => {
    let output = '';
    const outputFile = { write: (s) => { output += s; } };
    fixed.fixed2csv(open('examples/testfixed'), open('examples/testfixed_schema.csv'), outputFile, 0);

    assert.equal(readText('examples/testfixed_converted.csv'), output);
  });

  test('test_schema_decoder_init', () => {
    const rd = new fixed.SchemaDecoder(['column', 'start', 'length']);
    assert.equal(1, rd.start);
    assert.equal(2, rd.length);
    assert.equal(0, rd.column);
  });

  test('test_schema_decoder_in_action', () => {
    const rd = new fixed.SchemaDecoder(['comment', 'start', 'length', 'column']);

    let { name: column, start, length } = rd.decode(['This is a comment', '0', '1', 'column_name']);
    assert.equal(false, rd.oneBased);
    assert.equal('column_name', column);
    assert.equal(0, start);
    assert.equal(1, length);

    ({ name: column, start, length } = rd.decode(['This is another comment', '1', '5', 'column_name2']));
    assert.equal(false, rd.oneBased);
    assert.equal('column_name2', column);
    assert.equal(1, start);
    assert.equal(5, length);

    ({ name: column, start, length } = rd.decode(['yet another comment', '9', '14', 'column_name3']));
    assert.equal(false, rd.oneBased);
    assert.equal('column_name3', column);
    assert.equal(9, start);
    assert.equal(14, length);
  });

  test('test_one_based_row_decoder', () => {
    const rd = new fixed.SchemaDecoder(['column', 'start', 'length']);

    let { name: column, start, length } = rd.decode(['LABEL', '1', '5']);
    assert.equal(true, rd.oneBased);
    assert.equal('LABEL', column);
    assert.equal(0, start);
    assert.equal(5, length);

    ({ name: column, start, length } = rd.decode(['LABEL2', '6', '15']));
    assert.equal('LABEL2', column);
    assert.equal(5, start);
    assert.equal(15, length);
  });

  test('test_schematic_line_parser', () => {
    const schema = `column,start,length
foo,1,5
bar,6,2
baz,8,5`;

    const parser = new fixed.FixedWidthRowParser(splitLinesKeepEnds(schema));

    assert.equal('foo', parser.headers[0]);
    assert.equal('bar', parser.headers[1]);
    assert.equal('baz', parser.headers[2]);

    let parsed = parser.parse('111112233333');
    assert.equal('11111', parsed[0]);
    assert.equal('22', parsed[1]);
    assert.equal('33333', parsed[2]);

    parsed = parser.parse('    1 2    3');
    assert.equal('1', parsed[0]);
    assert.equal('2', parsed[1]);
    assert.equal('3', parsed[2]);

    parsed = parser.parse('1  1  233  3');
    assert.equal('1  1', parsed[0]);
    assert.equal('2', parsed[1]);
    assert.equal('33  3', parsed[2]);
  });
});
