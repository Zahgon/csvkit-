'use strict';
// The decompressor behind Python's lzma.open (liblzma's FORMAT_AUTO): .xz streams (LZMA2 behind any chain of the
// delta and BCJ filters liblzma 5.4.1 decodes, every check type) and legacy .lzma streams, with liblzma's integrity
// checks (header, block header, index and footer CRC32s, the block check, the index against the blocks decoded).
// Trailing data after a stream is ignored when it is not another valid stream, and a truncated or corrupt stream
// delivers what lzma.open reads before it raises.

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pyError, traceStream, replayReads } = require('./pyerrors');

// liblzma's errors, as _lzma reports them
function formatError() {
  return pyError('_lzma.LZMAError', 'Input format not supported by decoder');
}
function optionsError() {
  return pyError('_lzma.LZMAError', 'Invalid or unsupported options');
}
function dataError() {
  return pyError('_lzma.LZMAError', 'Corrupt input data');
}

/** The LZMA range decoder over a byte buffer, consuming it through a DecompressTrace. */
class RangeDecoder {
  /**
   * @param {Buffer} buf
   * @param {number} pos the offset of the range coder's first byte
   * @param {number} end where its data ends (an LZMA2 chunk's compressed size), Infinity when unknown
   * @param {DecompressTrace} trace
   * @throws {Error} pyName EOFError when fewer than 5 bytes are left, _lzma.LZMAError when the first is not 0
   */
  constructor(buf, pos, end, trace) {
    this.buf = buf;
    this.end = end;
    this.trace = trace;
    trace.need(pos + 1);
    if (buf[pos] !== 0) throw dataError();
    this.pos = pos + 1;
    this.range = 0xffffffff;
    this.code = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.take()) >>> 0;
  }
  /**
   * Consumes the next byte.
   * @returns {number}
   * @throws {Error} pyName EOFError at the end of the input, _lzma.LZMAError past the end of the data
   */
  take() {
    this.trace.need(this.pos + 1);
    if (this.pos >= this.end) throw dataError();
    return this.buf[this.pos++];
  }
  /**
   * Shifts in the next byte when the range has narrowed below 2**24.
   * @returns {void}
   * @throws {Error} as take()
   */
  norm() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.take()) >>> 0;
    }
  }
  /**
   * Decodes one bit with an adaptive probability, updating it.
   * @param {Uint16Array} probs
   * @param {number} i the probability's index
   * @returns {number} 0 or 1
   * @throws {Error} pyName EOFError at the end of the input
   */
  bit(probs, i) {
    this.norm();
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      return 0;
    }
    this.range = (this.range - bound) >>> 0;
    this.code = (this.code - bound) >>> 0;
    probs[i] = p - (p >>> 5);
    return 1;
  }
  /**
   * Decodes n bits with fixed probability one half.
   * @param {number} n
   * @returns {number}
   * @throws {Error} pyName EOFError at the end of the input
   */
  direct(n) {
    let r = 0;
    for (let i = 0; i < n; i++) {
      this.norm();
      this.range >>>= 1;
      let t = 0;
      if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; t = 1; }
      r = ((r << 1) | t) >>> 0;
    }
    return r;
  }
  /**
   * Decodes a bit-tree symbol, most significant bit first.
   * @param {Uint16Array} probs
   * @param {number} off the tree's offset in probs
   * @param {number} bits the symbol width
   * @returns {number}
   * @throws {Error} pyName EOFError at the end of the input
   */
  tree(probs, off, bits) {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(probs, off + m);
    return m - (1 << bits);
  }
  /**
   * Decodes a bit-tree symbol, least significant bit first.
   * @param {Uint16Array} probs
   * @param {number} off the tree's offset in probs
   * @param {number} bits the symbol width
   * @returns {number}
   * @throws {Error} pyName EOFError at the end of the input
   */
  reverse(probs, off, bits) {
    let m = 1;
    let r = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(probs, off + m);
      m = (m << 1) | b;
      r |= b << i;
    }
    return r;
  }
}

/** An LZMA decoder's state: literal and match probabilities, the repeat distances and the output window. */
class LzmaState {
  /** @param {number[]} out the output so far; decoded bytes are appended to it */
  constructor(out) { this.out = out; this.dictStart = out.length; }
  /**
   * Sets the literal context, literal position and position bits, and resets every probability and the state.
   * @param {number} lc
   * @param {number} lp
   * @param {number} pb
   * @returns {void}
   */
  setProps(lc, lp, pb) {
    this.lc = lc; this.lp = lp; this.pb = pb;
    const n = (k) => new Uint16Array(k).fill(1024);
    this.literal = n(0x300 << (lc + lp));
    this.isMatch = n(192); this.isRep = n(12); this.isRep0 = n(12); this.isRep1 = n(12); this.isRep2 = n(12);
    this.isRep0Long = n(192);
    this.posSlot = n(256); this.posSpecial = n(115); this.align = n(16);
    const lenCoder = () => ({ choice: n(2), low: n(256), mid: n(256), high: n(256) });
    this.lenDec = lenCoder(); this.repLenDec = lenCoder();
    this.state = 0; this.reps = [0, 0, 0, 0];
  }
  /**
   * Decodes a match length (minus 2) with a length coder.
   * @param {RangeDecoder} rc
   * @param {object} l the length coder's probabilities
   * @param {number} posState
   * @returns {number}
   * @throws {Error} pyName EOFError at the end of the input
   */
  decodeLen(rc, l, posState) {
    if (!rc.bit(l.choice, 0)) return rc.tree(l.low, posState << 3, 3);
    if (!rc.bit(l.choice, 1)) return 8 + rc.tree(l.mid, posState << 3, 3);
    return 16 + rc.tree(l.high, 0, 8);
  }
  /**
   * Decodes LZMA data until outSize more bytes were produced (or the end marker, where one is allowed).
   * @param {RangeDecoder} rc
   * @param {number} outSize the bytes to produce, Infinity when the size is unknown
   * @param {boolean} endMarker whether an end-of-payload marker may end the data (a .lzma stream; LZMA2 has none)
   * @returns {void}
   * @throws {Error} pyName _lzma.LZMAError for corrupt data, EOFError at the end of the input
   */
  run(rc, outSize, endMarker) {
    const out = this.out;
    const end = out.length + outSize;
    while (out.length < end) {
      const pos = out.length - this.dictStart;
      const posState = pos & ((1 << this.pb) - 1);
      const s = this.state;
      if (!rc.bit(this.isMatch, (s << 4) + posState)) {
        const prev = out.length > this.dictStart ? out[out.length - 1] : 0;
        const base = 0x300 * (((pos & ((1 << this.lp) - 1)) << this.lc) + (prev >> (8 - this.lc)));
        let sym = 1;
        if (s >= 7) {
          let match = out[out.length - this.reps[0] - 1];
          do {
            const mb = (match >> 7) & 1;
            match <<= 1;
            const b = rc.bit(this.literal, base + ((1 + mb) << 8) + sym);
            sym = (sym << 1) | b;
            if (mb !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | rc.bit(this.literal, base + sym);
        out.push(sym & 0xff);
        this.state = s < 4 ? 0 : s < 10 ? s - 3 : s - 6;
        continue;
      }
      let len;
      if (rc.bit(this.isRep, s)) {
        if (out.length === this.dictStart) throw dataError();
        if (!rc.bit(this.isRep0, s)) {
          if (!rc.bit(this.isRep0Long, (s << 4) + posState)) {
            this.state = s < 7 ? 9 : 11;
            out.push(out[out.length - this.reps[0] - 1]);
            continue;
          }
        } else {
          let dist;
          if (!rc.bit(this.isRep1, s)) dist = this.reps[1];
          else {
            if (!rc.bit(this.isRep2, s)) dist = this.reps[2];
            else { dist = this.reps[3]; this.reps[3] = this.reps[2]; }
            this.reps[2] = this.reps[1];
          }
          this.reps[1] = this.reps[0];
          this.reps[0] = dist;
        }
        len = this.decodeLen(rc, this.repLenDec, posState);
        this.state = s < 7 ? 8 : 11;
      } else {
        this.reps[3] = this.reps[2]; this.reps[2] = this.reps[1]; this.reps[1] = this.reps[0];
        len = this.decodeLen(rc, this.lenDec, posState);
        this.state = s < 7 ? 7 : 10;
        const lenState = Math.min(len, 3);
        const slot = rc.tree(this.posSlot, lenState << 6, 6);
        let dist;
        if (slot < 4) dist = slot;
        else {
          const nd = (slot >> 1) - 1;
          dist = ((2 | (slot & 1)) << nd) >>> 0;
          if (slot < 14) dist += rc.reverse(this.posSpecial, dist - slot, nd);
          else {
            dist = (dist + (rc.direct(nd - 4) << 4)) >>> 0;
            dist += rc.reverse(this.align, 0, 4);
          }
        }
        this.reps[0] = dist >>> 0;
        if (this.reps[0] === 0xffffffff) {
          if (!endMarker) throw dataError();
          break;
        }
      }
      len += 2;
      const d = this.reps[0];
      if (d >= out.length - this.dictStart) throw dataError();
      for (let i = 0; i < len && out.length < end; i++) out.push(out[out.length - d - 1]);
    }
    // liblzma normalises the range once more after the last symbol (or the end marker) and wants the range coder
    // flushed
    rc.norm();
    if (rc.code !== 0) throw dataError();
  }
}

/**
 * Reads a variable-length integer as lzma_vli_decode does, consuming its bytes through the trace.
 * @param {Buffer} buf
 * @param {{p: number}} pos the offset, advanced past the integer
 * @param {DecompressTrace} trace
 * @param {number} [limit] where the field ends (a block header); running into it is corrupt data
 * @returns {number}
 * @throws {Error} pyName _lzma.LZMAError for an over-long or non-minimal encoding, EOFError at the end of the input
 */
function readVarint(buf, pos, trace, limit = Infinity) {
  let v = 0;
  for (let n = 0; ; n++) {
    if (pos.p >= limit) throw dataError();
    trace.need(pos.p + 1);
    const b = buf[pos.p++];
    v += (b & 0x7f) * 2 ** (7 * n);
    if (!(b & 0x80)) {
      if (b === 0 && n > 0) throw dataError();
      return v;
    }
    if (n === 8) throw dataError();
  }
}

// The size of a variable-length integer's encoding.
function varintSize(v) {
  let n = 1;
  while (v >= 0x80) { v = Math.floor(v / 0x80); n++; }
  return n;
}

// lzma_lzma_lclppb_decode: the lc/lp/pb byte, or null when it is invalid.
function lclppb(byte) {
  if (byte > (4 * 5 + 4) * 9 + 8) return null;
  const pb = Math.floor(byte / 45);
  const lp = Math.floor((byte - pb * 45) / 9);
  const lc = byte - pb * 45 - lp * 9;
  return lc + lp > 4 ? null : { lc, lp, pb };
}

const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let lo = i;
  let hi = 0;
  for (let k = 0; k < 8; k++) {
    const bit = lo & 1;
    lo = ((lo >>> 1) | (hi << 31)) >>> 0;
    hi >>>= 1;
    if (bit) { lo = (lo ^ 0xd7870f42) >>> 0; hi = (hi ^ 0xc96c5795) >>> 0; }
  }
  CRC64_LO[i] = lo;
  CRC64_HI[i] = hi;
}

// CRC-64/XZ (ECMA-182, reflected) as 8 little-endian bytes.
function crc64(data) {
  let lo = 0xffffffff;
  let hi = 0xffffffff;
  for (const b of data) {
    const i = (lo ^ b) & 0xff;
    lo = (((lo >>> 8) | (hi << 24)) ^ CRC64_LO[i]) >>> 0;
    hi = ((hi >>> 8) ^ CRC64_HI[i]) >>> 0;
  }
  const r = Buffer.alloc(8);
  r.writeUInt32LE(~lo >>> 0, 0);
  r.writeUInt32LE(~hi >>> 0, 4);
  return r;
}

/**
 * The integrity check of a block's uncompressed data, for the check types liblzma verifies (others are skipped).
 * @param {number} type the check ID
 * @param {Buffer} data
 * @returns {Buffer|null} the check field's expected bytes, null for a type not verified
 */
function blockCheck(type, data) {
  if (type === 1) {
    const r = Buffer.alloc(4);
    r.writeUInt32LE(zlib.crc32(data), 0);
    return r;
  }
  if (type === 4) return crc64(data);
  if (type === 10) return crypto.createHash('sha256').update(data).digest();
  return null;
}

// The BCJ conversions, ported from liblzma 5.4.1's decoders (simple/*.c). Each converts the branch targets in buf,
// which starts at stream position now, and returns how many bytes it is done with; the rest wait for more data.

// x86.c: the factory keeps prev_mask and prev_pos between calls.
function x86() {
  const ALLOWED = [true, true, true, false, true, false, false, false];
  const BIT = [0, 1, 2, 2, 3, 3, 3, 3];
  const msByte = (b) => b === 0 || b === 0xff;
  let prevMask = 0;
  let prevPos = -5 >>> 0;
  return (buf, now) => {
    if (buf.length < 5) return 0;
    if (((now - prevPos) >>> 0) > 5) prevPos = (now - 5) >>> 0;
    let i = 0;
    while (i <= buf.length - 5) {
      if (buf[i] !== 0xe8 && buf[i] !== 0xe9) { i++; continue; }
      const offset = (now + i - prevPos) >>> 0;
      prevPos = (now + i) >>> 0;
      if (offset > 5) prevMask = 0;
      else for (let k = 0; k < offset; k++) prevMask = (prevMask & 0x77) << 1;
      const b = buf[i + 4];
      if (!msByte(b) || !ALLOWED[(prevMask >> 1) & 7] || prevMask >> 1 >= 0x10) {
        i++;
        prevMask |= msByte(b) ? 0x11 : 1;
        continue;
      }
      let src = buf.readUInt32LE(i + 1);
      let dest;
      for (;;) {
        dest = (src - (now + i + 5)) >>> 0;
        if (prevMask === 0) break;
        const shift = 24 - BIT[prevMask >> 1] * 8;
        if (!msByte((dest >>> shift) & 0xff)) break;
        src = (dest ^ (2 ** (shift + 8) - 1)) >>> 0;
      }
      buf.writeUInt32LE(((dest & 0xffffff) | ((dest >>> 24) & 1 ? 0xff000000 : 0)) >>> 0, i + 1);
      i += 5;
      prevMask = 0;
    }
    return i;
  };
}

// powerpc.c
function powerpc(buf, now) {
  let i = 0;
  for (; i + 4 <= buf.length; i += 4) {
    if (buf[i] >> 2 !== 0x12 || (buf[i + 3] & 3) !== 1) continue;
    const dest = (buf.readUInt32BE(i) & 0x3fffffc) - (now + i);
    buf.writeUInt32BE((0x48000000 | (dest & 0x3fffffc) | 1) >>> 0, i);
  }
  return i;
}

// ia64.c: the bundle template says which of its three 41-bit slots may hold a branch.
const IA64_SLOTS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 6, 6, 0, 0, 7, 7, 4, 4, 0, 0, 4, 4, 0, 0];
function ia64(buf, now) {
  let i = 0;
  for (; i + 16 <= buf.length; i += 16) {
    const mask = IA64_SLOTS[buf[i] & 0x1f];
    for (let slot = 0, bitPos = 5; slot < 3; slot++, bitPos += 41) {
      if (!((mask >> slot) & 1)) continue;
      const at = i + (bitPos >> 3);
      const shift = BigInt(bitPos & 7);
      const instr = buf.readUIntLE(at, 6);
      let norm = BigInt(instr) >> shift;
      if (((norm >> 37n) & 0xfn) !== 5n || ((norm >> 9n) & 7n) !== 0n) continue;
      const src = Number(((norm >> 13n) & 0xfffffn) | (((norm >> 36n) & 1n) << 20n)) * 16;
      const dest = ((src - (now + i)) >>> 0) >>> 4;
      norm &= ~(0x8fffffn << 13n);
      norm |= BigInt(dest & 0xfffff) << 13n | BigInt(dest & 0x100000) << 16n;
      buf.writeUIntLE(Number(((norm << shift) | BigInt(instr & ((1 << (bitPos & 7)) - 1))) & 0xffffffffffffn), at, 6);
    }
  }
  return i;
}

// arm.c: BL
function arm(buf, now) {
  let i = 0;
  for (; i + 4 <= buf.length; i += 4) {
    if (buf[i + 3] !== 0xeb) continue;
    const dest = (buf.readUIntLE(i, 3) * 4 - (now + i + 8)) >>> 2;
    buf.writeUIntLE(dest & 0xffffff, i, 3);
  }
  return i;
}

// armthumb.c: the two halves of BL
function armThumb(buf, now) {
  let i = 0;
  for (; i + 4 <= buf.length; i += 2) {
    if ((buf[i + 1] & 0xf8) !== 0xf0 || (buf[i + 3] & 0xf8) !== 0xf8) continue;
    const src = ((buf[i + 1] & 7) << 19 | buf[i] << 11 | (buf[i + 3] & 7) << 8 | buf[i + 2]) << 1;
    const dest = ((src - (now + i + 4)) >>> 0) >>> 1;
    buf[i + 1] = 0xf0 | ((dest >>> 19) & 7);
    buf[i] = dest >>> 11;
    buf[i + 3] = 0xf8 | ((dest >>> 8) & 7);
    buf[i + 2] = dest;
    i += 2;
  }
  return i;
}

// sparc.c: CALL
function sparc(buf, now) {
  let i = 0;
  for (; i + 4 <= buf.length; i += 4) {
    if (!(buf[i] === 0x40 && (buf[i + 1] & 0xc0) === 0) && !(buf[i] === 0x7f && (buf[i + 1] & 0xc0) === 0xc0)) continue;
    const dest = (((buf.readUInt32BE(i) << 2) >>> 0) - (now + i)) >>> 2;
    buf.writeUInt32BE((((-((dest >>> 22) & 1) << 22) & 0x3fffffff) | (dest & 0x3fffff) | 0x40000000) >>> 0, i);
  }
  return i;
}

// arm64.c: BL, and ADRP within +/-512 MiB
function arm64(buf, now) {
  let i = 0;
  for (; i + 4 <= buf.length; i += 4) {
    const instr = buf.readUInt32LE(i);
    const pc = (now + i) >>> 0;
    if (instr >>> 26 === 0x25) {
      buf.writeUInt32LE((0x94000000 | ((instr - (pc >>> 2)) & 0x3ffffff)) >>> 0, i);
    } else if (((instr & 0x9f000000) >>> 0) === 0x90000000) {
      const src = ((instr >>> 29) & 3) | ((instr >>> 3) & 0x1ffffc);
      if ((src + 0x20000) & 0x1c0000) continue;
      const dest = src - (pc >>> 12);
      const out = (instr & 0x9000001f) | ((dest & 3) << 29) | ((dest & 0x3fffc) << 3) | (-(dest & 0x20000) & 0xe00000);
      buf.writeUInt32LE(out >>> 0, i);
    }
  }
  return i;
}

// The BCJ filters by ID: [a factory of the conversion, the alignment its start offset needs]
const BCJ = new Map([
  [4, [x86, 1]], [5, [() => powerpc, 4]], [6, [() => ia64, 16]], [7, [() => arm, 4]],
  [8, [() => armThumb, 2]], [9, [() => sparc, 4]], [10, [() => arm64, 4]],
]);
const DELTA = 3;
const LZMA2 = 0x21;

/**
 * A BCJ decoder as liblzma's simple coder runs it: each call converts the bytes held back with the new ones and
 * holds back the tail the conversion is not done with, until the end of the data lets it through as it is.
 * @param {function(Buffer, number): number} convert
 * @param {number} start the start offset
 * @returns {function(Buffer, boolean): Buffer} takes the next bytes and whether they are the last, returns the
 *   bytes decoded
 */
function bcjDecoder(convert, start) {
  let now = start;
  let held = Buffer.alloc(0);
  return (data, end) => {
    const buf = Buffer.concat([held, data]);
    const done = convert(buf, now);
    now = (now + done) >>> 0;
    held = buf.subarray(end ? buf.length : done);
    return buf.subarray(0, end ? buf.length : done);
  };
}

/**
 * The delta decoder (delta_decoder.c): each byte adds the decoded byte dist positions back, over the whole block.
 * @param {number} dist 1 to 256
 * @returns {function(Buffer): Buffer} decodes the next bytes in place
 */
function deltaDecoder(dist) {
  const history = new Uint8Array(256);
  let pos = 0;
  return (data) => {
    for (let i = 0; i < data.length; i++) {
      data[i] += history[(dist + pos) & 0xff];
      history[pos-- & 0xff] = data[i];
    }
    return data;
  };
}

/**
 * Decodes one filter's properties as lzma_properties_decode does.
 * @param {number} id
 * @param {Buffer} props
 * @returns {{id: number, init: (function(): function(Buffer, boolean): Buffer)|undefined}} init makes the filter's
 *   decoder (the delta and BCJ filters)
 * @throws {Error} pyName _lzma.LZMAError "Invalid or unsupported options" for an unknown ID or invalid properties
 */
function filterProps(id, props) {
  if (id === LZMA2) {
    if (props.length !== 1 || props[0] & 0xc0 || props[0] > 40) throw optionsError();
    return { id };
  }
  if (id === DELTA) {
    if (props.length !== 1) throw optionsError();
    return { id, init: () => deltaDecoder(props[0] + 1) };
  }
  const bcj = BCJ.get(id);
  if (!bcj || (props.length !== 0 && props.length !== 4)) throw optionsError();
  const start = props.length ? props.readUInt32LE(0) : 0;
  return {
    id,
    init: () => {
      if (start % bcj[1]) throw optionsError();
      return bcjDecoder(bcj[0](), start);
    },
  };
}

/** A block's delta and BCJ decoders, fed what LZMA2 decodes (the last filter of the block header comes first). */
class FilterChain {
  /**
   * @param {Array<function(Buffer, boolean): Buffer>} filters the decoders, in the block header's order
   * @param {number[]} out the decoded bytes are appended to it
   */
  constructor(filters, out) {
    this.filters = filters;
    this.out = out;
    this.raw = [];
    this.taken = 0;
  }

  /**
   * Runs the bytes LZMA2 decoded since the last call through the decoders.
   * @param {boolean} end whether LZMA2 has ended, which lets every byte held back through
   * @returns {void}
   */
  pass(end) {
    let data = Buffer.from(this.raw.slice(this.taken));
    this.taken = this.raw.length;
    for (let i = this.filters.length - 1; i >= 0; i--) data = this.filters[i](data, end);
    for (const b of data) this.out.push(b);
  }
}

/**
 * The output of decompress(), as the DecompressTrace measures it: while a block with delta or BCJ filters is decoded,
 * its length counts what they have let through of LZMA2's output, as liblzma hands it to Python when LZMA2 stops
 * for more input.
 */
class Output {
  constructor() {
    this.data = [];
    this.chain = null;
  }

  /** @returns {number} */
  get length() {
    if (this.chain) this.chain.pass(false);
    return this.data.length;
  }
}

/**
 * Decodes LZMA2 chunks from start up to and including the end marker, with lzma2_decoder's checks on them.
 * @param {Buffer} buf
 * @param {number} start
 * @param {number[]} out decoded bytes are appended to it
 * @param {DecompressTrace} trace
 * @returns {number} the offset after the end marker
 * @throws {Error} pyName _lzma.LZMAError for corrupt data, EOFError at the end of the input
 */
function decompressLzma2(buf, start, out, trace) {
  let pos = start;
  let st = null;
  let dictStart = out.length;
  let needDictReset = true;
  let needProps = true;
  for (;;) {
    trace.need(pos + 1);
    const ctrl = buf[pos++];
    if (ctrl === 0) return pos;
    if (ctrl >= 0xe0 || ctrl === 1) {
      needProps = true;
      dictStart = out.length;
    } else if (needDictReset) {
      throw dataError();
    }
    needDictReset = false;
    if (ctrl < 0x80) {
      if (ctrl > 2) throw dataError();
      trace.need(pos + 2);
      const size = ((buf[pos] << 8) | buf[pos + 1]) + 1;
      pos += 2;
      for (let i = 0; i < size; i++) {
        trace.need(pos + 1);
        out.push(buf[pos++]);
      }
      continue;
    }
    trace.need(pos + 4);
    const usize = ((ctrl & 0x1f) << 16) + (buf[pos] << 8) + buf[pos + 1] + 1;
    const csize = (buf[pos + 2] << 8) + buf[pos + 3] + 1;
    pos += 4;
    if (ctrl >= 0xc0) {
      trace.need(pos + 1);
      const props = lclppb(buf[pos++]);
      if (!props) throw dataError();
      needProps = false;
      st = new LzmaState(out);
      st.setProps(props.lc, props.lp, props.pb);
    } else if (needProps) {
      throw dataError();
    } else if (ctrl >= 0xa0) {
      st.setProps(st.lc, st.lp, st.pb);
    }
    st.dictStart = dictStart;
    const rc = new RangeDecoder(buf, pos, pos + csize, trace);
    st.run(rc, usize, false);
    if (rc.pos - pos !== csize) throw dataError();
    pos += csize;
  }
}

/**
 * Reads a 12-byte stream header or footer's Stream Flags (2 bytes at pos).
 * @returns {number} the check ID
 * @throws {Error} pyName _lzma.LZMAError "Invalid or unsupported options" for reserved bits that are set
 */
function streamFlags(buf, pos) {
  if (buf[pos] !== 0 || buf[pos + 1] & 0xf0) throw optionsError();
  return buf[pos + 1];
}

// The CRC32 stored little-endian at `at` must be that of buf[from, to).
function crc32Matches(buf, from, to, at) {
  return zlib.crc32(buf.subarray(from, to)) === buf.readUInt32LE(at);
}

/**
 * Decodes a block header at pos (whose size byte is not 0) as lzma_block_header_decode does, then checks its filter
 * chain and makes its decoders as lzma_block_decoder_init does.
 * @returns {{size: number, compressed: number|null, uncompressed: number|null, filters: Array<function(Buffer,
 *   boolean): Buffer>}} the header's size, the sizes it declares and the decoders of the filters before LZMA2
 * @throws {Error} pyName _lzma.LZMAError for a corrupt or unsupported header, EOFError at the end of the input
 */
function blockHeader(buf, pos, trace) {
  const size = (buf[pos] + 1) * 4;
  trace.need(pos + size);
  const limit = pos + size - 4;
  if (!crc32Matches(buf, pos, limit, limit)) throw dataError();
  const flags = buf[pos + 1];
  if (flags & 0x3c) throw optionsError();
  const p = { p: pos + 2 };
  let compressed = null;
  let uncompressed = null;
  if (flags & 0x40) {
    compressed = readVarint(buf, p, trace, limit);
    if (compressed === 0) throw dataError();
  }
  if (flags & 0x80) uncompressed = readVarint(buf, p, trace, limit);
  const filters = [];
  for (let f = 0; f <= (flags & 3); f++) {
    const id = readVarint(buf, p, trace, limit);
    if (id >= 2 ** 62) throw dataError();
    const psize = readVarint(buf, p, trace, limit);
    if (psize > limit - p.p) throw dataError();
    filters.push(filterProps(id, buf.subarray(p.p, p.p + psize)));
    p.p += psize;
  }
  for (; p.p < limit; p.p++) if (buf[p.p] !== 0) throw optionsError();
  // validate_chain: LZMA2 ends the chain and only LZMA2 can
  if (filters.some((f, i) => (f.id === LZMA2) !== (i === filters.length - 1))) throw optionsError();
  return { size, compressed, uncompressed, filters: filters.slice(0, -1).map((f) => f.init()) };
}

/**
 * Decodes the index at pos (its indicator byte already read) and checks it against the blocks decoded, as
 * lzma_index_hash_decode does.
 * @param {{unpadded: number, uncompressed: number}[]} blocks
 * @returns {number} the offset after the index
 * @throws {Error} pyName _lzma.LZMAError when it is corrupt or does not match, EOFError at the end of the input
 */
function checkIndex(buf, pos, trace, blocks) {
  const p = { p: pos + 1 };
  if (readVarint(buf, p, trace) !== blocks.length) throw dataError();
  const sums = (list) => list.reduce((a, r) => ({
    blocks: a.blocks + Math.ceil(r.unpadded / 4) * 4,
    uncompressed: a.uncompressed + r.uncompressed,
    list: a.list + varintSize(r.unpadded) + varintSize(r.uncompressed),
  }), { blocks: 0, uncompressed: 0, list: 0 });
  const expected = sums(blocks);
  const records = [];
  for (let i = 0; i < blocks.length; i++) {
    const unpadded = readVarint(buf, p, trace);
    if (unpadded < 5 || unpadded > 2 ** 63 - 4) throw dataError();
    records.push({ unpadded, uncompressed: readVarint(buf, p, trace) });
    const got = sums(records);
    if (got.blocks > expected.blocks || got.uncompressed > expected.uncompressed || got.list > expected.list) {
      throw dataError();
    }
  }
  for (; (p.p - pos) % 4; p.p++) {
    trace.need(p.p + 1);
    if (buf[p.p] !== 0) throw dataError();
  }
  if (records.some((r, i) => r.unpadded !== blocks[i].unpadded || r.uncompressed !== blocks[i].uncompressed)) {
    throw dataError();
  }
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(zlib.crc32(buf.subarray(pos, p.p)), 0);
  for (let i = 0; i < 4; i++) {
    trace.need(p.p + 1);
    if (buf[p.p++] !== crc[i]) throw dataError();
  }
  return p.p;
}

/**
 * One .xz stream at pos, as liblzma's stream decoder reads it (without LZMA_CONCATENATED: the stream padding after
 * it is left for the next decompressor, which rejects it as trailing data).
 * @param {Buffer} buf
 * @param {number} pos
 * @param {Output} out
 * @param {DecompressTrace} trace
 * @returns {number} the offset after the stream footer
 * @throws {Error} pyName _lzma.LZMAError for a corrupt or unsupported stream, EOFError at the end of the input
 */
function decompressXzStream(buf, pos, out, trace) {
  trace.need(pos + 12);
  if (buf.toString('latin1', pos, pos + 6) !== '\xfd7zXZ\0') throw formatError();
  if (!crc32Matches(buf, pos + 6, pos + 8, pos + 8)) throw dataError();
  const checkType = streamFlags(buf, pos + 6);
  const checkSize = CHECK_SIZES[checkType];
  let p = pos + 12;
  const blocks = [];
  for (;;) {
    trace.need(p + 1);
    if (buf[p] === 0) break;
    const header = blockHeader(buf, p, trace);
    const dataStart = p + header.size;
    const outStart = out.data.length;
    const chain = header.filters.length ? new FilterChain(header.filters, out.data) : null;
    out.chain = chain;
    let end = decompressLzma2(buf, dataStart, chain ? chain.raw : out.data, trace);
    if (chain) chain.pass(true);
    out.chain = null;
    const compressed = end - dataStart;
    const uncompressed = out.data.length - outStart;
    if ((header.compressed !== null && header.compressed !== compressed)
      || (header.uncompressed !== null && header.uncompressed !== uncompressed)) throw dataError();
    for (; (end - dataStart) % 4; end++) {
      trace.need(end + 1);
      if (buf[end] !== 0) throw dataError();
    }
    trace.need(end + checkSize);
    const expected = blockCheck(checkType, Buffer.from(out.data.slice(outStart)));
    if (expected && !expected.equals(buf.subarray(end, end + checkSize))) throw dataError();
    blocks.push({ unpadded: header.size + compressed + checkSize, uncompressed });
    p = end + checkSize;
  }
  const indexEnd = checkIndex(buf, p, trace, blocks);
  trace.need(indexEnd + 12);
  // a footer that does not match the header or the index is corrupt data, whatever lzma_stream_footer_decode says
  if (buf.toString('latin1', indexEnd + 10, indexEnd + 12) !== 'YZ') throw dataError();
  if (!crc32Matches(buf, indexEnd + 4, indexEnd + 10, indexEnd)) throw dataError();
  const footerCheck = streamFlags(buf, indexEnd + 8);
  if ((buf.readUInt32LE(indexEnd + 4) + 1) * 4 !== indexEnd - p) throw dataError();
  if (footerCheck !== checkType) throw dataError();
  return indexEnd + 12;
}

/**
 * One legacy .lzma ("LZMA_Alone") stream at pos, with liblzma's checks on its header as each field arrives.
 * @returns {number} the offset after the stream
 * @throws {Error} pyName _lzma.LZMAError for a header the decoder rejects or corrupt data, EOFError at the end of
 *   the input
 */
function decompressAloneStream(buf, pos, out, trace) {
  trace.need(pos + 1);
  const props = lclppb(buf[pos]);
  if (!props) throw formatError();
  trace.need(pos + 5);
  const dict = buf.readUInt32LE(pos + 1);
  if (dict !== 0xffffffff) {
    let d = dict - 1;
    d |= d >>> 2;
    d |= d >>> 3;
    d |= d >>> 4;
    d |= d >>> 8;
    d |= d >>> 16;
    if (((d + 1) >>> 0) !== dict) throw formatError();
  }
  trace.need(pos + 13);
  const lo = buf.readUInt32LE(pos + 5);
  const hi = buf.readUInt32LE(pos + 9);
  const unknown = lo === 0xffffffff && hi === 0xffffffff;
  if (!unknown && hi >= 0x40) throw formatError();
  const st = new LzmaState(out);
  st.setProps(props.lc, props.lp, props.pb);
  const rc = new RangeDecoder(buf, pos + 13, Infinity, trace);
  st.run(rc, unknown ? Infinity : hi * 2 ** 32 + lo, true);
  return rc.pos;
}

/**
 * Decompresses an .xz or .lzma file the way lzma.open(path) delivers it.
 * @param {Buffer} buf the compressed bytes
 * @returns {{data: Buffer, error: Error|null}} the decompressed bytes, then the error raised after them (if any):
 *   EOFError for a stream cut short, _lzma.LZMAError for a corrupt or unsupported one (a later stream rejected
 *   by its first decompress() call ends the data instead, as trailing garbage)
 */
function decompress(buf) {
  const out = new Output();
  const traceAt = (pos) => traceStream(out, buf.length, pos, (trace) => {
    trace.need(pos + 1);
    if (buf[pos] === 0xfd) return decompressXzStream(buf, pos, out, trace);
    return decompressAloneStream(buf, pos, out.data, trace);
  });
  const opts = { trailingError: '_lzma.LZMAError', fullNeedsInput: false };
  const { length, error } = replayReads(buf.length, traceAt, opts);
  out.data.length = length;
  return { data: Buffer.from(out.data), error };
}

module.exports = { decompress };
