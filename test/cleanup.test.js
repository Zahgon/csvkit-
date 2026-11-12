'use strict';
// Port of csvkit 2.2.0 tests/test_cleanup.py (MIT).

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { joinRows } = require('../lib/cleanup');

describe('TestCleanup', () => {
  test('test_fix_rows', () => {
    // Test to ensure that row merging yields correct results.
    const start = [['1', '2', '3'],
      [''],
      ['abc'],
      ['4', '5'],
    ];
    const fixed = joinRows(start, ' ');
    assert.equal(4, fixed.length);
    assert.equal(start[0][0], fixed[0]);
    assert.equal(start[0][1], fixed[1]);
    assert.equal([start[0].at(-1), start[1][0], start[2][0], start[3][0]].join(' '), fixed[2]);
    assert.equal(start[3][1], fixed[3]);
  });

  test('test_real_world_join_fail', () => {
    const start = [['168772', '1102', '$0.23 TO $0.72', 'HOUR', '1.5%'],
      ['GROSS', '1.5% '],
      ['GROSS', '430938']];
    const fixed = joinRows(start, ' ');
    assert.equal(7, fixed.length);
    assert.equal(start[0][0], fixed[0]);
    assert.equal(start[0][1], fixed[1]);
    assert.equal(start[0][2], fixed[2]);
    assert.equal(start[0][3], fixed[3]);
    const expected4 = [start[0].at(-1), start[1][0]].join(' ');
    assert.equal(expected4, fixed[4]);
    const expected5 = [start[1][1], start[2][0]].join(' ');
    assert.equal(expected5, fixed[5]);
    assert.equal(start[2][1], fixed[6]);
  });
});
