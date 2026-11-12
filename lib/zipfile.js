'use strict';
// Port of the reading side of CPython 3.11 zipfile (end record, central directory, stored and deflated
// members), as openpyxl uses it to open an XLSX package.

const zlib = require('node:zlib');
const { pyError } = require('./pyerrors');
const { decode } = require('./codecs');
const { pyRepr } = require('./pystr');

const END_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const END_SIZE = 22;

function badZip(message) {
  return pyError('zipfile.BadZipFile', message);
}

/**
 * Locate the end of central directory record like zipfile._EndRecData.
 * @param {Buffer} buf whole archive
 * @returns {number} offset of the record, or -1
 */
function findEndRecord(buf) {
  if (buf.length < END_SIZE) return -1;
  const last = buf.length - END_SIZE;
  if (buf.readUInt32LE(last) === END_SIG && buf.readUInt16LE(last + 20) === 0) return last;
  const start = Math.max(0, buf.length - (1 << 16) - END_SIZE);
  for (let i = last; i >= start; i--) {
    if (buf.readUInt32LE(i) === END_SIG) return i;
  }
  return -1;
}

/** zipfile.ZipFile for reading the stored and deflated members of an archive in memory. */
class ZipFile {
  /**
   * Open an archive held in memory: reads the central directory.
   * @param {Buffer} buf archive bytes
   * @throws {Error} pyName zipfile.BadZipFile without an end record or with a damaged central directory
   */
  constructor(buf) {
    this.buf = buf;
    this.members = new Map();
    const end = findEndRecord(buf);
    if (end < 0) throw badZip('File is not a zip file');
    const count = buf.readUInt16LE(end + 10);
    const size = buf.readUInt32LE(end + 12);
    const offset = buf.readUInt32LE(end + 16);
    const concat = end - size - offset;
    let p = offset + concat;
    for (let i = 0; i < count && p < end; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
        throw badZip('Bad magic number for central directory');
      }
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const headerOffset = buf.readUInt32LE(p + 42) + concat;
      const rawName = buf.subarray(p + 46, p + 46 + nameLen);
      const name = flags & 0x800 ? rawName.toString('utf8') : decode(rawName, 'cp437');
      this.members.set(name, { name, method, csize, headerOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** @returns {string[]} member names in archive order */
  namelist() { return [...this.members.keys()]; }

  /**
   * Read one member's bytes (zipfile.ZipFile.read).
   * @param {string} name member name
   * @returns {Buffer}
   * @throws {Error} pyName KeyError for a name not in the archive, zipfile.BadZipFile for a damaged local header,
   *   NotImplementedError for a compression method other than stored or deflated; zlib's error for a corrupt
   *   deflate stream
   */
  read(name) {
    const m = this.members.get(name);
    if (!m) {
      throw pyError('KeyError', pyRepr(`There is no item named ${pyRepr(name)} in the archive`));
    }
    const p = m.headerOffset;
    if (p + 30 > this.buf.length || this.buf.readUInt32LE(p) !== LOCAL_SIG) throw badZip('Bad magic number for file header');
    const start = p + 30 + this.buf.readUInt16LE(p + 26) + this.buf.readUInt16LE(p + 28);
    const data = this.buf.subarray(start, start + m.csize);
    if (m.method === 0) return Buffer.from(data);
    if (m.method === 8) return zlib.inflateRawSync(data);
    throw pyError('NotImplementedError', 'compression type ' + m.method);
  }
}

module.exports = { ZipFile };
