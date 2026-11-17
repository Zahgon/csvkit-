'use strict';
// A bzip2 decompressor (multi-stream), as Python's bz2.open (libbz2 behind _compression.DecompressReader) reads
// .bz2 input: what it delivers before a truncated stream raises EOFError, or before a corrupt one (a bad block or
// stream CRC included) raises OSError, and trailing data after a stream ignored when it is not a valid stream.

const { pyError, traceStream, replayReads } = require('./pyerrors');

/** Reads a bzip2 stream bit by bit, most significant bit first, consuming its bytes through a DecompressTrace. */
class BitReader {
  /**
   * @param {Buffer} buf the compressed bytes
   * @param {number} pos the offset of the first byte
   * @param {DecompressTrace} trace
   */
  constructor(buf, pos, trace) { this.buf = buf; this.pos = pos; this.bit = 0; this.trace = trace; }
  /**
   * @param {number} n how many bits
   * @returns {number} them as an unsigned integer
   * @throws {Error} pyName EOFError when the stream ends first
   */
  bits(n) {
    let v = 0;
    for (let k = 0; k < n; k++) {
      if (this.bit === 0) this.trace.need(this.pos + 1);
      v = (v << 1) | ((this.buf[this.pos] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v >>> 0;
  }
  /** @returns {number} the offset after the last byte read from (libbz2 reads whole bytes) */
  end() { return this.pos + (this.bit ? 1 : 0); }
}

// BZ_DATA_ERROR and BZ_DATA_ERROR_MAGIC, as _bz2 reports them
function badData() {
  return pyError('OSError', 'Invalid data stream');
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  CRC_TABLE[i] = c >>> 0;
}

// bzip2's block CRC: CRC-32 most significant bit first, over the block's decoded bytes
function blockCrc(out, start) {
  let crc = 0xffffffff;
  for (let i = start; i < out.length; i++) crc = (crc << 8) ^ CRC_TABLE[(crc >>> 24) ^ out[i]];
  return ~crc >>> 0;
}

// Reads the rest of a 48-bit block or end-of-stream magic byte by byte, as libbz2 checks it.
function expectBytes(br, bytes) {
  for (const b of bytes) if (br.bits(8) !== b) throw badData();
}

function decodeBlock(br, blockSize100k, out) {
  if (br.bits(1)) throw badData(); // randomised blocks are not produced by modern bzip2
  const origPtr = br.bits(24);
  const used = [];
  const inUse16 = br.bits(16);
  for (let i = 0; i < 16; i++) {
    if (inUse16 & (0x8000 >> i)) {
      const b = br.bits(16);
      for (let j = 0; j < 16; j++) if (b & (0x8000 >> j)) used.push(i * 16 + j);
    }
  }
  if (!used.length) throw badData();
  const alphaSize = used.length + 2;
  const nGroups = br.bits(3);
  const nSelectors = br.bits(15);
  if (nGroups < 2 || nGroups > 6 || nSelectors < 1) throw badData();
  const mtfGroups = [...Array(nGroups).keys()];
  const selectors = [];
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (br.bits(1)) { j++; if (j >= nGroups) throw badData(); }
    const v = mtfGroups[j];
    mtfGroups.splice(j, 1);
    mtfGroups.unshift(v);
    selectors.push(v);
  }
  const tables = [];
  for (let t = 0; t < nGroups; t++) {
    const lens = [];
    let len = br.bits(5);
    for (let i = 0; i < alphaSize; i++) {
      for (;;) {
        if (len < 1 || len > 20) throw badData();
        if (!br.bits(1)) break;
        len += br.bits(1) ? -1 : 1;
      }
      lens.push(len);
    }
    // canonical Huffman decode table
    const minLen = Math.min(...lens);
    const maxLen = Math.max(...lens);
    const limit = [];
    const base = [];
    const perm = [];
    for (let l = minLen; l <= maxLen; l++) for (let s = 0; s < alphaSize; s++) if (lens[s] === l) perm.push(s);
    let code = 0;
    let idx = 0;
    for (let l = minLen; l <= maxLen; l++) {
      const count = lens.filter((x) => x === l).length;
      base[l] = idx - code;
      code += count;
      idx += count;
      limit[l] = code - 1;
      code <<= 1;
    }
    tables.push({ minLen, maxLen, limit, base, perm });
  }
  const mtf = used.slice();
  const tt = new Uint32Array(blockSize100k * 100000);
  const counts = new Uint32Array(256);
  let n = 0;
  let groupPos = 0;
  let sel = 0;
  let run = 0;
  let runWeight = 1;
  const flushRun = () => {
    if (run) {
      const b = mtf[0];
      counts[b] += run;
      while (run--) { if (n >= tt.length) throw badData(); tt[n++] = b; }
      run = 0;
      runWeight = 1;
    }
  };
  for (;;) {
    if (groupPos === 0) {
      if (sel >= nSelectors) throw badData();
      groupPos = 50;
      sel++;
    }
    groupPos--;
    const t = tables[selectors[sel - 1]];
    let l = t.minLen;
    let c = br.bits(l);
    while (l <= t.maxLen && c > t.limit[l]) { c = (c << 1) | br.bits(1); l++; }
    if (l > t.maxLen) throw badData();
    const sym = t.perm[t.base[l] + c];
    if (sym === 0 || sym === 1) {
      run += runWeight << sym;
      runWeight <<= 1;
      continue;
    }
    flushRun();
    if (sym === alphaSize - 1) break;
    const k = sym - 1;
    const b = mtf[k];
    mtf.splice(k, 1);
    mtf.unshift(b);
    counts[b]++;
    if (n >= tt.length) throw badData();
    tt[n++] = b;
  }
  // the block's input is all consumed; libbz2 reads no more until its output has been delivered
  br.trace.consumed(br.end());
  if (origPtr >= n) throw badData();
  // inverse BWT
  const cum = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < 256; i++) { cum[i] = sum; sum += counts[i]; }
  const next = new Uint32Array(n);
  for (let i = 0; i < n; i++) next[cum[tt[i] & 0xff]++] = i;
  let p = next[origPtr];
  // undo the initial run-length encoding
  let last = -1;
  let same = 0;
  for (let i = 0; i < n; i++) {
    const b = tt[p] & 0xff;
    p = next[p];
    if (same === 4) {
      for (let r = 0; r < b; r++) out.push(last);
      same = 0;
      last = -1;
      continue;
    }
    if (b === last) same++;
    else { last = b; same = 1; }
    out.push(b);
  }
}

// One bzip2 stream at br.pos, its CRCs checked as libbz2 checks them: a block's after its output, the stream's
// (combined) CRC at the end-of-stream marker. Returns the offset after the stream.
function decodeStream(br, out) {
  expectBytes(br, [0x42, 0x5a, 0x68]);
  const level = br.bits(8) - 0x30;
  if (level < 1 || level > 9) throw badData();
  let combined = 0;
  for (;;) {
    const magic = br.bits(8);
    if (magic === 0x31) {
      expectBytes(br, [0x41, 0x59, 0x26, 0x53, 0x59]);
      const stored = br.bits(32);
      const start = out.length;
      decodeBlock(br, level, out);
      const crc = blockCrc(out, start);
      if (crc !== stored) throw badData();
      combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
    } else if (magic === 0x17) {
      expectBytes(br, [0x72, 0x45, 0x38, 0x50, 0x90]);
      const stored = br.bits(32);
      if (stored !== combined) throw badData();
      return br.end();
    } else {
      throw badData();
    }
  }
}

/**
 * Decompresses a .bz2 file.
 * @param {Buffer} buf the compressed bytes
 * @returns {{data: Buffer, error: Error|null}} the bytes bz2.open delivers, then the error it raises (if any):
 *   EOFError for a stream cut short, OSError "Invalid data stream" for corrupt data or a CRC mismatch
 */
function decompress(buf) {
  const out = [];
  const traceAt = (pos) => traceStream(out, buf.length, pos,
    (trace) => decodeStream(new BitReader(buf, pos, trace), out));
  const { length, error } = replayReads(buf.length, traceAt, { trailingError: 'OSError', fullNeedsInput: true });
  out.length = length;
  return { data: Buffer.from(out), error };
}

module.exports = { decompress };
