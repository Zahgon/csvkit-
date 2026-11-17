'use strict';
// The parts of Python's struct.unpack and bytes indexing that the BIFF readers use, with Python's errors: a buffer
// whose length differs from the format's size raises struct.error, and an index past the end raises IndexError.

const { pyError, structError } = require('./pyerrors');

const SIZES = { x: 1, B: 1, H: 2, i: 4, I: 4, L: 4, d: 8, s: 1 };

const parsed = new Map();

/**
 * The (count, code) items of a little-endian format such as '<HH3sd'.
 * @param {string} fmt
 * @returns {Array<Array>} [count, code] pairs and the format's total size, as [items, size]
 */
function parse(fmt) {
  let hit = parsed.get(fmt);
  if (hit) return hit;
  const items = [];
  let size = 0;
  for (const [, digits, code] of fmt.slice(1).matchAll(/(\d*)([xBHiILds])/g)) {
    const count = digits === '' ? 1 : Number(digits);
    items.push([count, code]);
    size += count * SIZES[code];
  }
  hit = [items, size];
  parsed.set(fmt, hit);
  return hit;
}

/**
 * struct.unpack for a '<' format: integers and floats as numbers, 's' items as Buffers, pad bytes skipped.
 * @param {string} fmt a little-endian format, e.g. '<HHHd'
 * @param {Buffer} buf exactly as many bytes as the format describes
 * @returns {Array}
 * @throws {Error} pyName struct.error when buf's length is not the format's size
 */
function unpack(fmt, buf) {
  const [items, size] = parse(fmt);
  if (buf.length !== size) throw structError(size);
  const out = [];
  let p = 0;
  for (const [count, code] of items) {
    if (code === 's') {
      out.push(buf.subarray(p, p + count));
      p += count;
      continue;
    }
    for (let k = 0; k < count; k++) {
      switch (code) {
        case 'x': break;
        case 'B': out.push(buf[p]); break;
        case 'H': out.push(buf.readUInt16LE(p)); break;
        case 'i': out.push(buf.readInt32LE(p)); break;
        case 'I': case 'L': out.push(buf.readUInt32LE(p)); break;
        default: out.push(buf.readDoubleLE(p));
      }
      p += SIZES[code];
    }
  }
  return out;
}

/**
 * Python's bytes[i]: negative indices count from the end.
 * @param {Buffer} buf
 * @param {number} i
 * @returns {number} the byte
 * @throws {Error} pyName IndexError for an index outside the bytes
 */
function byteAt(buf, i) {
  const k = i < 0 ? i + buf.length : i;
  if (k < 0 || k >= buf.length) throw pyError('IndexError', 'index out of range');
  return buf[k];
}

module.exports = { unpack, byteAt };
