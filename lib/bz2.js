'use strict';
// A bzip2 decompressor (multi-stream), as Python's bz2.open (libbz2 behind _compression.DecompressReader) reads
// .bz2 input, including what it delivers before a truncated stream raises EOFError.

const { pyError, truncatedStreamError } = require('./pyerrors');

/** Reads a bzip2 stream bit by bit, most significant bit first. */
class BitReader {
  /** @param {Buffer} buf the compressed bytes */
  constructor(buf) { this.buf = buf; this.pos = 0; this.bit = 0; }
  /**
   * @param {number} n how many bits
   * @returns {number} them as an unsigned integer
   * @throws {Error} pyName EOFError when the stream ends first
   */
  bits(n) {
    let v = 0;
    for (let k = 0; k < n; k++) {
      if (this.pos >= this.buf.length) throw truncatedStreamError();
      v = (v << 1) | ((this.buf[this.pos] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v >>> 0;
  }
  /**
   * Skips to the next byte boundary.
   * @returns {void}
   */
  alignByte() { if (this.bit) { this.bit = 0; this.pos++; } }
}

function badData() {
  return pyError('OSError', 'Invalid data stream');
}

function decodeBlock(br, blockSize100k, out) {
  br.bits(32); // block CRC
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

/**
 * Decompresses a .bz2 file.
 * @param {Buffer} buf the compressed bytes
 * @returns {{data: Buffer, error: Error|null}} the bytes bz2.open delivers, then the error it raises (if any):
 *   EOFError for a stream cut short
 * @throws {Error} pyName OSError "Invalid data stream" for data that is not bzip2 from the start
 */
function decompress(buf) {
  const out = [];
  const br = new BitReader(buf);
  let any = false;
  // A block decoded with every input byte already read is delivered one 8192-byte read() at a time, so a stream
  // truncated right after it raises EOFError after its first 8192 bytes.
  let lastBlock = null;
  try {
    while (br.pos < buf.length) {
      const rest = buf.subarray(br.pos, br.pos + 4);
      if (any && rest.length < 4 && Buffer.from('BZh').subarray(0, rest.length).equals(rest)) throw truncatedStreamError();
      if (rest.length < 4 || rest[0] !== 0x42 || rest[1] !== 0x5a || rest[2] !== 0x68) {
        if (any) break;
        throw badData();
      }
      const level = buf[br.pos + 3] - 0x30;
      if (level < 1 || level > 9) throw badData();
      br.pos += 4;
      for (;;) {
        const hi = br.bits(24);
        const lo = br.bits(24);
        if (hi === 0x314159 && lo === 0x265359) {
          const start = out.length;
          decodeBlock(br, level, out);
          lastBlock = buf.length - br.pos - (br.bit ? 1 : 0) <= 0 ? start : null;
        } else if (hi === 0x177245 && lo === 0x385090) {
          br.bits(32);
          br.alignByte();
          lastBlock = null;
          break;
        } else {
          throw badData();
        }
      }
      any = true;
    }
  } catch (e) {
    if (e.pyName !== 'EOFError') throw e;
    if (lastBlock !== null) out.length = Math.min(out.length, lastBlock + 8192);
    return { data: Buffer.from(out), error: e };
  }
  return { data: Buffer.from(out), error: null };
}

module.exports = { decompress };
