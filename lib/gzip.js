'use strict';
// Port of the reading side of CPython 3.11's Lib/gzip.py (_GzipReader): members, header fields, CRC and length
// checks, zero padding, and the errors it raises part-way through a file.

const zlib = require('node:zlib');
const { pyError, truncatedStreamError } = require('./pyerrors');
const { pyBytesRepr } = require('./pystr');

let crcTable = null;
function crc32(buf) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Skips the header after the magic bytes; returns the position of the deflate data.
function skipHeader(buf, pos) {
  if (pos + 8 > buf.length) throw truncatedStreamError();
  if (buf[pos] !== 8) throw pyError('gzip.BadGzipFile', 'Unknown compression method');
  const flag = buf[pos + 1];
  pos += 8;
  if (flag & 4) {
    if (pos + 2 > buf.length) throw truncatedStreamError();
    pos += 2 + buf.readUInt16LE(pos);
    if (pos > buf.length) throw truncatedStreamError();
  }
  for (const bit of [8, 16]) {
    if (flag & bit) {
      while (pos < buf.length && buf[pos] !== 0) pos++;
      pos++;
    }
  }
  if (flag & 2) {
    pos += 2;
    if (pos > buf.length) throw truncatedStreamError();
  }
  return pos;
}

function inflateMember(buf, pos) {
  try {
    const { buffer, engine } = zlib.inflateRawSync(buf.subarray(pos), { info: true });
    return { data: buffer, end: pos + engine.bytesWritten, error: null };
  } catch (e) {
    if (e.code !== 'Z_BUF_ERROR') {
      return { data: Buffer.alloc(0), end: pos, error: pyError('zlib.error', `Error -3 while decompressing data: ${e.message}`) };
    }
    const data = zlib.inflateRawSync(buf.subarray(pos), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return { data, end: buf.length, error: truncatedStreamError() };
  }
}

/**
 * Decompresses a gzip file as GzipFile.read() would deliver it.
 * @param {Buffer} buf the file's bytes
 * @returns {{data: Buffer, error: Error|null}} the bytes decompressed before the error the reader then raises
 */
function gunzip(buf) {
  const parts = [];
  let pos = 0;
  let error = null;
  while (pos < buf.length) {
    const magic = buf.subarray(pos, pos + 2);
    if (magic.length !== 2 || magic[0] !== 0x1f || magic[1] !== 0x8b) {
      error = pyError('gzip.BadGzipFile', `Not a gzipped file (${pyBytesRepr(magic)})`);
      break;
    }
    try {
      pos = skipHeader(buf, pos + 2);
    } catch (e) {
      error = e;
      break;
    }
    const member = inflateMember(buf, pos);
    parts.push(member.data);
    if (member.error) {
      error = member.error;
      break;
    }
    pos = member.end;
    if (pos + 8 > buf.length) {
      error = truncatedStreamError();
      break;
    }
    const crc = buf.readUInt32LE(pos);
    const isize = buf.readUInt32LE(pos + 4);
    const actual = crc32(member.data);
    if (crc !== actual) {
      error = pyError('gzip.BadGzipFile', `CRC check failed 0x${crc.toString(16)} != 0x${actual.toString(16)}`);
      break;
    }
    if (isize !== member.data.length % 2 ** 32) {
      error = pyError('gzip.BadGzipFile', 'Incorrect length of data produced');
      break;
    }
    pos += 8;
    while (pos < buf.length && buf[pos] === 0) pos++;
  }
  return { data: Buffer.concat(parts), error };
}

module.exports = { gunzip };
