'use strict';
// The decompressor behind Python's lzma.open (liblzma's FORMAT_AUTO): .xz streams (LZMA2, every check type) and
// legacy .lzma streams; trailing data after the first stream is ignored when it is not another valid stream, and a
// truncated stream delivers what it decoded before raising EOFError.

const { pyError, truncatedStreamError } = require('./pyerrors');

// Throws EOFError unless buf holds n bytes from pos.
function need(buf, pos, n) {
  if (pos + n > buf.length) throw truncatedStreamError();
}

function badData() {
  return pyError('_lzma.LZMAError', 'Input format not supported by decoder');
}

/** The LZMA range decoder over a byte buffer. */
class RangeDecoder {
  /**
   * @param {Buffer} buf
   * @param {number} pos the offset of the range coder's first byte
   * @throws {Error} pyName EOFError when fewer than 5 bytes are left
   */
  constructor(buf, pos) {
    this.buf = buf;
    need(buf, pos, 5);
    this.pos = pos + 1;
    this.range = 0xffffffff;
    this.code = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | buf[this.pos++]) >>> 0;
  }
  /**
   * Shifts in the next byte when the range has narrowed below 2**24.
   * @returns {void}
   * @throws {Error} pyName EOFError at the end of the input
   */
  norm() {
    if (this.range < 0x1000000) {
      need(this.buf, this.pos, 1);
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
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
   * Decodes LZMA data until outSize more bytes were produced (or the end marker, for an unknown size).
   * @param {RangeDecoder} rc
   * @param {number} outSize the bytes to produce, Infinity when the size is unknown
   * @returns {void}
   * @throws {Error} pyName _lzma.LZMAError for corrupt data, EOFError at the end of the input
   */
  run(rc, outSize) {
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
        if (out.length === this.dictStart) throw badData();
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
        if (this.reps[0] === 0xffffffff) break;
      }
      len += 2;
      const d = this.reps[0];
      if (d >= out.length - this.dictStart) throw badData();
      for (let i = 0; i < len && out.length < end; i++) out.push(out[out.length - d - 1]);
    }
  }
}

function readVarint(buf, pos) {
  let v = 0;
  let shift = 0;
  for (;;) {
    need(buf, pos.p, 1);
    const b = buf[pos.p++];
    v += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) return v;
  }
}

const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

function decompressLzma2(buf, start, out) {
  let pos = start;
  let st = null;
  let dictStart = out.length;
  for (;;) {
    need(buf, pos, 1);
    const ctrl = buf[pos++];
    if (ctrl === 0) return pos;
    if (ctrl === 1 || ctrl === 2) {
      if (ctrl === 1) dictStart = out.length;
      need(buf, pos, 2);
      const size = ((buf[pos] << 8) | buf[pos + 1]) + 1;
      pos += 2;
      need(buf, pos, size);
      for (let i = 0; i < size; i++) out.push(buf[pos + i]);
      pos += size;
      continue;
    }
    if (ctrl < 0x80) throw badData();
    need(buf, pos, 5);
    const usize = ((ctrl & 0x1f) << 16) + (buf[pos] << 8) + buf[pos + 1] + 1;
    const csize = (buf[pos + 2] << 8) + buf[pos + 3] + 1;
    pos += 4;
    const reset = (ctrl >> 5) & 3;
    if (reset === 3) dictStart = out.length;
    if (reset >= 2) {
      const props = buf[pos++];
      const lc = props % 9;
      const rest = Math.floor(props / 9);
      const lp = rest % 5;
      const pb = Math.floor(rest / 5);
      const ns = new LzmaState(out);
      ns.dictStart = dictStart;
      ns.setProps(lc, lp, pb);
      st = ns;
    } else if (reset === 1) {
      st.setProps(st.lc, st.lp, st.pb);
    }
    if (!st) throw badData();
    st.dictStart = dictStart;
    const rc = new RangeDecoder(buf, pos);
    st.run(rc, usize);
    pos += csize;
  }
}

// One .xz stream at pos: returns the position after it (and its padding).
function decompressXzStream(buf, pos, out) {
  need(buf, pos, 12);
  if (!(buf[pos] === 0xfd && buf.toString('latin1', pos + 1, pos + 6) === '7zXZ\0')) throw badData();
  const checkType = buf[pos + 7] & 0x0f;
  pos += 12;
  for (;;) {
    need(buf, pos, 1);
    if (buf[pos] === 0) break;
    const hsize = (buf[pos] + 1) * 4;
    need(buf, pos, hsize);
    const flags = buf[pos + 1];
    const p = { p: pos + 2 };
    if (flags & 0x40) readVarint(buf, p);
    if (flags & 0x80) readVarint(buf, p);
    const nFilters = (flags & 3) + 1;
    for (let f = 0; f < nFilters; f++) {
      const id = readVarint(buf, p);
      const psize = readVarint(buf, p);
      if (id !== 0x21) throw badData();
      p.p += psize;
    }
    const dataStart = pos + hsize;
    let end = decompressLzma2(buf, dataStart, out);
    while ((end - dataStart) % 4) end++;
    pos = end + CHECK_SIZES[checkType];
    need(buf, end, CHECK_SIZES[checkType]);
  }
  const p = { p: pos + 1 };
  const records = readVarint(buf, p);
  for (let r = 0; r < records; r++) {
    readVarint(buf, p);
    readVarint(buf, p);
  }
  while ((p.p - pos) % 4) p.p++;
  pos = p.p + 4 + 12;
  need(buf, p.p, 16);
  while (pos < buf.length && buf[pos] === 0) pos++;
  return pos;
}

// One legacy .lzma ("LZMA_Alone") stream at pos, with liblzma's checks on its header.
function decompressAloneStream(buf, pos, out) {
  need(buf, pos, 13);
  const props = buf[pos];
  if (props > 224) throw badData();
  const dict = buf.readUInt32LE(pos + 1);
  if (dict !== 0xffffffff) {
    let d = dict - 1;
    d |= d >>> 2;
    d |= d >>> 3;
    d |= d >>> 4;
    d |= d >>> 8;
    d |= d >>> 16;
    if (((d + 1) >>> 0) !== dict) throw badData();
  }
  const lo = buf.readUInt32LE(pos + 5);
  const hi = buf.readUInt32LE(pos + 9);
  const unknown = lo === 0xffffffff && hi === 0xffffffff;
  if (!unknown && hi >= 0x40) throw badData();
  const st = new LzmaState(out);
  st.setProps(props % 9, Math.floor(props / 9) % 5, Math.floor(props / 45));
  const rc = new RangeDecoder(buf, pos + 13);
  st.run(rc, unknown ? Infinity : hi * 2 ** 32 + lo);
  return rc.pos;
}

/**
 * Decompresses an .xz or .lzma file the way lzma.open(path) delivers it.
 * @param {Buffer} buf the compressed bytes
 * @returns {{data: Buffer, error: Error|null}} the decompressed bytes, then the error raised after them (if any):
 *   EOFError for a stream cut short
 * @throws {Error} pyName _lzma.LZMAError for a first stream the decoder does not support (a bad later stream ends
 *   the data, as lzma's decompressor ignores trailing garbage)
 */
function decompress(buf) {
  const out = [];
  const stream = (pos) => (buf[pos] === 0xfd ? decompressXzStream : decompressAloneStream)(buf, pos, out);
  try {
    let pos = stream(0);
    while (pos < buf.length) {
      const mark = out.length;
      try {
        pos = stream(pos);
      } catch (e) {
        if (e.pyName !== '_lzma.LZMAError') throw e;
        out.length = mark;
        break;
      }
    }
  } catch (e) {
    if (e.pyName !== 'EOFError') throw e;
    return { data: Buffer.from(out), error: e };
  }
  return { data: Buffer.from(out), error: null };
}

module.exports = { decompress };
