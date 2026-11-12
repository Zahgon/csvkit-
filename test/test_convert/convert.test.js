'use strict';
// Port of csvkit 2.2.0 tests/test_convert/test_convert.py (MIT).

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const convert = require('../../lib/convert');

describe('TestConvert', () => {
  test('test_guess_fixed', () => {
    assert.equal('fixed', convert.guessFormat('testdata'));
  });

  test('test_guess_xls', () => {
    assert.equal('xls', convert.guessFormat('testdata.xls'));
  });

  test('test_guess_xls_uppercase', () => {
    assert.equal('xls', convert.guessFormat('testdata.XLS'));
  });

  test('test_guess_xlsx', () => {
    assert.equal('xlsx', convert.guessFormat('testdata.xlsx'));
  });

  test('test_guess_csv', () => {
    assert.equal('csv', convert.guessFormat('testdata.csv'));
  });

  test('test_guess_dbf', () => {
    assert.equal('dbf', convert.guessFormat('testdata.dbf'));
  });

  test('test_guess_json', () => {
    assert.equal('json', convert.guessFormat('testdata.json'));
  });

  test('test_guess_invalid', () => {
    assert.equal(null, convert.guessFormat('testdata.invalid'));
  });
});
