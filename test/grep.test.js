'use strict';
// Port of csvkit 2.2.0 tests/test_grep.py (MIT). A Python dict of patterns is a Map here, keyed by column index
// (a number) or column name (a string).

const assert = require('node:assert/strict');
const { beforeEach, describe, test } = require('node:test');
const { ColumnIdentifierError } = require('../lib/cli');
const { FilteringCSVReader } = require('../lib/grep');
const pyre = require('../lib/pyre');

/** re.compile(pattern); the patterns of these tests emit no warnings. */
function compile(pattern) {
  return pyre.compile(pattern, { warn: () => {} });
}

/** next(iterator), raising when the iterator is exhausted. */
function next(iterator) {
  const r = iterator.next();
  if (r.done) throw new Error('StopIteration');
  return r.value;
}

/** The iterator has no rows left. */
function assertExhausted(iterator) {
  assert.ok(iterator.next().done, 'Should be no more rows left.');
}

describe('TestGrep', () => {
  let tab1;
  let tab2;

  beforeEach(() => {
    tab1 = [
      ['id', 'name', 'i_work_here'],
      ['1', 'Chicago Reader', 'first'],
      ['2', 'Chicago Sun-Times', 'only'],
      ['3', 'Chicago Tribune', 'only'],
      ['1', 'Chicago Reader', 'second']];

    tab2 = [
      ['id', 'age', 'i_work_here'],
      ['1', 'first', '0'],
      ['4', 'only', '0'],
      ['1', 'second', '0'],
      ['2', 'only', '0', '0']]; // Note extra value in this column
  });

  test('test_pattern', () => {
    const fcr = new FilteringCSVReader(tab1.values(), ['1']);
    assert.deepEqual(tab1[0], next(fcr));
    assert.deepEqual(tab1[1], next(fcr));
    assert.deepEqual(tab1[4], next(fcr));
    assertExhausted(fcr);
  });

  test('test_no_header', () => {
    const fcr = new FilteringCSVReader(tab1.values(), new Map([[2, 'only']]), { header: false });
    assert.deepEqual(tab1[2], next(fcr));
    assert.deepEqual(tab1[3], next(fcr));
    assertExhausted(fcr);
  });

  test('test_regex', () => {
    const pattern = compile('.*(Reader|Tribune).*');
    const fcr = new FilteringCSVReader(tab1.values(), new Map([[1, pattern]]));

    assert.deepEqual(tab1[0], next(fcr));
    assert.deepEqual(tab1[1], next(fcr));
    assert.deepEqual(tab1[3], next(fcr));
    assert.deepEqual(tab1[4], next(fcr));
    assertExhausted(fcr);
  });

  test('test_inverse', () => {
    const fcr = new FilteringCSVReader(tab2.values(), ['1'], { inverse: true });
    assert.deepEqual(tab2[0], next(fcr));
    assert.deepEqual(tab2[2], next(fcr));
    assert.deepEqual(tab2[4], next(fcr));
    assertExhausted(fcr);
  });

  test('test_column_names_in_patterns', () => {
    const fcr = new FilteringCSVReader(tab2.values(), new Map([['age', 'only']]));
    assert.deepEqual(tab2[0], next(fcr));
    assert.deepEqual(tab2[2], next(fcr));
    assert.deepEqual(tab2[4], next(fcr));
    assertExhausted(fcr);
  });

  test('test_mixed_indices_and_column_names_in_patterns', () => {
    const fcr = new FilteringCSVReader(tab2.values(), new Map([['age', 'only'], [0, '2']]));
    assert.deepEqual(tab2[0], next(fcr));
    assert.deepEqual(tab2[4], next(fcr));
    assertExhausted(fcr);
  });

  test('test_duplicate_column_ids_in_patterns', () => {
    assert.throws(
      () => new FilteringCSVReader(tab2.values(), new Map([['age', 'only'], [1, 'second']])),
      ColumnIdentifierError,
      'Should be an exception.',
    );
  });

  test('test_index_out_of_range', () => {
    const fcr = new FilteringCSVReader(tab2.values(), new Map([[3, '0']]));
    assert.deepEqual(tab2[0], next(fcr));
    assert.deepEqual(tab2[4], next(fcr));
    assertExhausted(fcr);
  });

  test('test_any_match', () => {
    const fcr = new FilteringCSVReader(tab2.values(), new Map([['age', 'only'], [0, '2']]), { anyMatch: true });
    assert.deepEqual(tab2[0], next(fcr));
    assert.deepEqual(tab2[2], next(fcr));
    assert.deepEqual(tab2[4], next(fcr));
    assertExhausted(fcr);
  });

  test('test_any_match_and_inverse', () => {
    const fcr = new FilteringCSVReader(tab2.values(), new Map([['age', 'only'], [0, '2']]),
      { anyMatch: true, inverse: true });
    assert.deepEqual(tab2[0], next(fcr));
    assert.deepEqual(tab2[1], next(fcr));
    assert.deepEqual(tab2[3], next(fcr));
    assertExhausted(fcr);
  });

  test('test_multiline', () => {
    const table = [
      ['a', 'b'],
      ['1', 'foo\nbar'],
    ];
    const fcr = new FilteringCSVReader(table.values(), new Map([['b', compile('bar')]]));
    assert.deepEqual(table[0], next(fcr));
    assert.deepEqual(table[1], next(fcr));
    assertExhausted(fcr);
  });
});
