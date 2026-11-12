'use strict';
// Port of csvkit 2.2.0 tests/test_cli.py (MIT).

const assert = require('node:assert/strict');
const { beforeEach, describe, test } = require('node:test');
const { matchColumnIdentifier, parseColumnIdentifiers } = require('../lib/cli');

describe('TestCli', () => {
  let headers;

  beforeEach(() => {
    headers = ['id', 'name', 'i_work_here', '1', 'more-header-values', 'stuff', 'blueberry'];
  });

  test('test_match_column_identifier_string', () => {
    assert.equal(2, matchColumnIdentifier(headers, 'i_work_here'));
    assert.equal(2, matchColumnIdentifier(headers, 'i_work_here', 0));
  });

  test('test_match_column_identifier_numeric', () => {
    assert.equal(2, matchColumnIdentifier(headers, 3));
    assert.equal(3, matchColumnIdentifier(headers, 3, 0));
  });

  test('test_match_column_which_could_be_integer_name_is_treated_as_positional_id', () => {
    assert.equal(0, matchColumnIdentifier(headers, '1'));
    assert.equal(1, matchColumnIdentifier(headers, '1', 0));
  });

  test('test_parse_column_identifiers', () => {
    assert.deepEqual([2, 0, 1], parseColumnIdentifiers('i_work_here,1,name', headers));
    assert.deepEqual([2, 1, 1], parseColumnIdentifiers('i_work_here,1,name', headers, 0));
    assert.deepEqual(
      [1, 1],
      parseColumnIdentifiers(
        'i_work_here,1,name',
        headers,
        0,
        'i_work_here,foobar',
      ),
    );
  });

  test('test_range_notation', () => {
    assert.deepEqual([0, 1, 2], parseColumnIdentifiers('1:3', headers));
    assert.deepEqual([1, 2, 3], parseColumnIdentifiers('1:3', headers, 0));
    assert.deepEqual([1, 2, 3], parseColumnIdentifiers('2-4', headers));
    assert.deepEqual([2, 3, 4], parseColumnIdentifiers('2-4', headers, 0));
    assert.deepEqual([0, 1, 2, 3], parseColumnIdentifiers('1,2:4', headers));
    assert.deepEqual([1, 2, 3, 4], parseColumnIdentifiers('1,2:4', headers, 0));
    assert.deepEqual([4, 2, 5], parseColumnIdentifiers('more-header-values,3,stuff', headers));
    assert.deepEqual([4, 3, 5], parseColumnIdentifiers(
      'more-header-values,3,stuff', headers, 0));
  });

  test('test_range_notation_open_ended', () => {
    assert.deepEqual([0, 1, 2], parseColumnIdentifiers(':3', headers));

    const target = Array.from({ length: headers.length - 3 }, (_, i) => i + 3); // protect against devs adding to headers
    target.unshift(0);
    assert.deepEqual(target, parseColumnIdentifiers('1,4:', headers));

    assert.deepEqual(Array.from({ length: headers.length }, (_, i) => i), parseColumnIdentifiers('1:', headers));
  });
});
