'use strict';
// Port of the reading side of CPython 3.11 zipfile, as openpyxl and xlrd use it on an archive in memory:
// _EndRecData (with the ZIP64 end records), _RealGetContents, the checks ZipFile.open makes on a member's local
// header, and ZipExtFile.read() to the end of a stored, deflated, bzip2 or LZMA member with its CRC-32 check.

const zlib = require('node:zlib');
const { pyError } = require('./pyerrors');
const { decode } = require('./codecs');
const { pyRepr, pyBytesRepr } = require('./pystr');
const bz2 = require('./bz2');
const xz = require('./xz');

const END_SIG = 0x06054b50;
const END64_LOCATOR_SIG = 0x07064b50;
const END64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const END_SIZE = 22;
const END64_LOCATOR_SIZE = 20;
const END64_SIZE = 56;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

const MAX_EXTRACT_VERSION = 63;
const MASK_ENCRYPTED = 1 << 0;
const MASK_COMPRESSED_PATCH = 1 << 5;
const MASK_STRONG_ENCRYPTION = 1 << 6;
const MASK_UTF_FILENAME = 1 << 11;

const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
const ZIP_BZIP2 = 12;
const ZIP_LZMA = 14;

function badZip(message) {
  return pyError('zipfile.BadZipFile', message);
}

/**
 * zipfile._EndRecData64: applies the ZIP64 end of central directory record, when its locator precedes the end
 * record, to the fields read from the end record.
 * @param {Buffer} buf whole archive
 * @param {number} offset position of the end record
 * @param {object} endrec {size, offset, location} of the central directory, updated in place
 * @returns {object} endrec
 * @throws {Error} pyName zipfile.BadZipFile for a ZIP64 record that is damaged or spans several disks
 */
function endRecData64(buf, offset, endrec) {
  offset -= END64_LOCATOR_SIZE;
  if (offset < 0) return endrec;
  if (buf.readUInt32LE(offset) !== END64_LOCATOR_SIG) return endrec;
  const diskno = buf.readUInt32LE(offset + 4);
  const reloff = buf.readBigUInt64LE(offset + 8);
  const disks = buf.readUInt32LE(offset + 16);
  if (diskno !== 0 || disks > 1) throw badZip('zipfiles that span multiple disks are not supported');

  offset -= END64_SIZE;
  if (reloff > BigInt(offset)) throw badZip('Corrupt zip64 end of central directory locator');
  // First, check the assumption that there is no prepended data.
  let start = Number(reloff);
  let extrasz = offset - start;
  if (buf.readUInt32LE(start) !== END64_SIG && start !== offset) {
    // The locator was seen, so the archive may have prepended data: assume no "zip64 extensible data".
    start = offset;
    extrasz = 0;
  }
  if (buf.readUInt32LE(start) !== END64_SIG) throw badZip('Zip64 end of central directory record not found');

  const sz = buf.readBigUInt64LE(start + 4);
  const dirsize = buf.readBigUInt64LE(start + 40);
  const diroffset = buf.readBigUInt64LE(start + 48);
  if (diroffset + dirsize !== reloff || sz + 12n !== BigInt(END64_SIZE + extrasz)) {
    throw badZip('Corrupt zip64 end of central directory record');
  }
  endrec.size = Number(dirsize);
  endrec.offset = Number(diroffset);
  endrec.location = offset - extrasz;
  return endrec;
}

/**
 * zipfile._EndRecData: the end of central directory record, at the very end of the archive or before a comment of
 * up to 64 KiB.
 * @param {Buffer} buf whole archive
 * @returns {object|null} {size, offset, location} of the central directory, or null without a usable record
 * @throws {Error} pyName zipfile.BadZipFile for a damaged ZIP64 record
 */
function endRecData(buf) {
  if (buf.length < END_SIZE) return null;
  const last = buf.length - END_SIZE;
  const record = (pos) => ({ size: buf.readUInt32LE(pos + 12), offset: buf.readUInt32LE(pos + 16), location: pos });
  if (buf.readUInt32LE(last) === END_SIG && buf.readUInt16LE(last + 20) === 0) {
    return endRecData64(buf, last, record(last));
  }
  // An archive comment follows the record: take the last signature in the final 64 KiB, which must leave room
  // for a whole record.
  const maxCommentStart = Math.max(buf.length - (1 << 16) - END_SIZE, 0);
  const start = buf.lastIndexOf('PK\x05\x06', buf.length, 'latin1');
  if (start < maxCommentStart) return null;
  if (start + END_SIZE > buf.length) return null;
  return endRecData64(buf, start, record(start));
}

/**
 * ZipInfo._decodeExtra: the ZIP64 sizes and offset of a central directory entry's extra field.
 * @param {object} info the entry, updated in place
 * @param {Buffer} extra the extra field
 * @throws {Error} pyName zipfile.BadZipFile for a field that overruns the extra data or a short ZIP64 field
 */
function decodeExtra(info, extra) {
  while (extra.length >= 4) {
    const tp = extra.readUInt16LE(0);
    const ln = extra.readUInt16LE(2);
    if (ln + 4 > extra.length) throw badZip(`Corrupt extra field ${tp.toString(16).padStart(4, '0')} (size=${ln})`);
    if (tp === 0x0001) {
      let data = extra.subarray(4, ln + 4);
      // Each field the 32-bit entry marks as 0xFFFFFFFF takes the next 8 bytes.
      const next = (field) => {
        if (data.length < 8) throw badZip(`Corrupt zip64 extra field. ${field} not found.`);
        const value = Number(data.readBigUInt64LE(0));
        data = data.subarray(8);
        return value;
      };
      if (info.fileSize === 0xffffffff) info.fileSize = next('File size');
      if (info.compressSize === 0xffffffff) info.compressSize = next('Compress size');
      if (info.headerOffset === 0xffffffff) info.headerOffset = next('Header offset');
    }
    extra = extra.subarray(ln + 4);
  }
}

/**
 * The data of a member's compressed bytes as one ZipExtFile decompressor delivers them, up to its end of stream.
 * @param {number} method ZIP_DEFLATED, ZIP_BZIP2 or ZIP_LZMA
 * @param {Buffer} raw the member's compressed bytes
 * @returns {Buffer} the decompressed bytes; a stream that is cut short gives what it decoded without an error, as
 *   ZipExtFile ends the member when its compressed data runs out (the CRC-32 check then rejects it)
 * @throws {Error} pyName zlib.error, OSError (bzip2) or _lzma.LZMAError for data the decompressor rejects
 */
function decompress(method, raw) {
  if (method === ZIP_DEFLATED) {
    // zlib.decompressobj(-15): a sync flush keeps the output of a truncated stream, and data after the end of
    // the stream is ignored.
    try {
      return zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch (e) {
      if (typeof e.errno !== 'number') throw e;
      throw pyError('zlib.error', `Error ${e.errno} while decompressing data: ${e.message}`);
    }
  }
  // The member is decompressed in one call, so an error from corrupt data leaves no output.
  const whole = ({ data, error }) => {
    if (error && error.pyName !== 'EOFError') throw error;
    return data;
  };
  if (method === ZIP_BZIP2) return whole(bz2.decompress(raw));
  // zipfile.LZMADecompressor: a 4-byte version and properties size, the LZMA1 properties, then a raw LZMA1
  // stream, decoded here as a legacy .lzma stream of unknown size with the same lc, lp and pb. The raw decoder
  // accepts any dictionary size, so the .lzma header carries 0xFFFFFFFF, the size the legacy decoder does not check.
  if (raw.length <= 4) return Buffer.alloc(0);
  const psize = raw.readUInt16LE(2);
  if (raw.length <= 4 + psize) return Buffer.alloc(0);
  const props = raw.subarray(4, 4 + psize);
  const lclppb = props[0];
  if (psize !== 5 || lclppb > 224 || (lclppb % 45) % 9 + Math.floor((lclppb % 45) / 9) > 4) {
    throw pyError('_lzma.LZMAError', 'Invalid or unsupported options');
  }
  const alone = Buffer.concat([props.subarray(0, 1), Buffer.alloc(12, 0xff), raw.subarray(4 + psize)]);
  return whole(xz.decompress(alone));
}

/** zipfile.ZipFile in read mode over an archive held in memory. */
class ZipFile {
  /**
   * Open an archive: reads the end record and the central directory (ZipFile._RealGetContents).
   * @param {Buffer} buf archive bytes
   * @param {object} [options]
   * @param {boolean} [options.inMemory] true when Python reads the archive from a BytesIO (standard input) rather
   *   than a file: seeking to a negative member offset then raises ValueError instead of OSError
   * @throws {Error} pyName zipfile.BadZipFile without an end record or with a damaged central directory,
   *   NotImplementedError for an entry needing a zip version above 6.3, UnicodeDecodeError for an entry name
   *   flagged UTF-8 that is not
   */
  constructor(buf, options = {}) {
    this.buf = buf;
    this.inMemory = Boolean(options.inMemory);
    this.filelist = [];
    this.nameToInfo = new Map();
    const endrec = endRecData(buf);
    if (!endrec) throw badZip('File is not a zip file');
    const sizeCd = endrec.size;
    // "concat" is non-zero when data was prepended to the archive.
    const concat = endrec.location - sizeCd - endrec.offset;
    this.startDir = endrec.offset + concat;
    if (this.startDir < 0) throw badZip('Bad offset for central directory');
    const data = buf.subarray(this.startDir, this.startDir + sizeCd);
    let p = 0;
    // Reads n bytes of the directory, fewer at its end, as io.BytesIO.read does.
    const take = (n) => {
      const chunk = data.subarray(p, p + n);
      p += chunk.length;
      return chunk;
    };
    let total = 0;
    while (total < sizeCd) {
      const centdir = take(CENTRAL_SIZE);
      if (centdir.length !== CENTRAL_SIZE) throw badZip('Truncated central directory');
      if (centdir.readUInt32LE(0) !== CENTRAL_SIG) throw badZip('Bad magic number for central directory');
      const nameLen = centdir.readUInt16LE(28);
      const extraLen = centdir.readUInt16LE(30);
      const commentLen = centdir.readUInt16LE(32);
      const flagBits = centdir.readUInt16LE(8);
      const origFilename = decode(take(nameLen), flagBits & MASK_UTF_FILENAME ? 'utf-8' : 'cp437');
      const extra = take(extraLen);
      take(commentLen);
      const nul = origFilename.indexOf('\0');
      const info = {
        origFilename,
        // ZipInfo ends the name at its first NUL.
        filename: nul >= 0 ? origFilename.slice(0, nul) : origFilename,
        flagBits,
        compressType: centdir.readUInt16LE(10),
        crc: centdir.readUInt32LE(16),
        compressSize: centdir.readUInt32LE(20),
        fileSize: centdir.readUInt32LE(24),
        headerOffset: centdir.readUInt32LE(42),
        endOffset: null,
      };
      const extractVersion = centdir[6];
      if (extractVersion > MAX_EXTRACT_VERSION) {
        throw pyError('NotImplementedError', `zip file version ${(extractVersion / 10).toFixed(1)}`);
      }
      decodeExtra(info, extra);
      info.headerOffset += concat;
      this.filelist.push(info);
      this.nameToInfo.set(info.filename, info);
      total += CENTRAL_SIZE + nameLen + extraLen + commentLen;
    }
    // Each member ends at most where the next local header (or the central directory) starts.
    let endOffset = this.startDir;
    for (const info of [...this.filelist].sort((a, b) => b.headerOffset - a.headerOffset)) {
      info.endOffset = endOffset;
      endOffset = info.headerOffset;
    }
  }

  /** @returns {string[]} member names in directory order, repeated names included (ZipFile.namelist) */
  namelist() { return this.filelist.map((info) => info.filename); }

  /**
   * Read one member's bytes (ZipFile.read: ZipFile.open, then ZipExtFile.read() to the end).
   * @param {string} name member name
   * @returns {Buffer}
   * @throws {Error} pyName KeyError for a name not in the archive; zipfile.BadZipFile for a damaged local header,
   *   a name that differs from the directory's, a member overlapping the next one or a CRC-32 mismatch;
   *   NotImplementedError for patched data, strong encryption or a compression method other than stored, deflate,
   *   bzip2 and LZMA; RuntimeError for an encrypted member; UnicodeDecodeError for a local name flagged UTF-8 that
   *   is not; OSError or ValueError for a negative member offset; and the decompressor's error for corrupt data
   */
  read(name) {
    const info = this.nameToInfo.get(name);
    if (!info) {
      throw pyError('KeyError', pyRepr(`There is no item named ${pyRepr(name)} in the archive`));
    }
    const buf = this.buf;
    let pos = info.headerOffset;
    if (pos < 0) {
      throw this.inMemory ? pyError('ValueError', `negative seek value ${pos}`) : pyError('OSError', '[Errno 22] Invalid argument');
    }
    // Reads n bytes at pos, fewer at the end of the archive, and moves pos past them like a file's read().
    const readAt = (n) => {
      const chunk = buf.subarray(pos, pos + n);
      pos += chunk.length;
      return chunk;
    };
    const fheader = readAt(LOCAL_SIZE);
    if (fheader.length !== LOCAL_SIZE) throw badZip('Truncated file header');
    if (fheader.readUInt32LE(0) !== LOCAL_SIG) throw badZip('Bad magic number for file header');
    const fname = readAt(fheader.readUInt16LE(26));
    readAt(fheader.readUInt16LE(28));

    if (info.flagBits & MASK_COMPRESSED_PATCH) {
      throw pyError('NotImplementedError', 'compressed patched data (flag bit 5)');
    }
    if (info.flagBits & MASK_STRONG_ENCRYPTION) throw pyError('NotImplementedError', 'strong encryption (flag bit 6)');
    const fnameStr = decode(fname, fheader.readUInt16LE(6) & MASK_UTF_FILENAME ? 'utf-8' : 'cp437');
    if (fnameStr !== info.origFilename) {
      throw badZip(`File name in directory ${pyRepr(info.origFilename)} and header ${pyBytesRepr(fname)} differ.`);
    }
    if (pos + info.compressSize > info.endOffset) {
      throw badZip(`Overlapped entries: ${pyRepr(info.origFilename)} (possible zip bomb)`);
    }
    if (info.flagBits & MASK_ENCRYPTED) {
      throw pyError('RuntimeError', `File ${pyRepr(name)} is encrypted, password required for extraction`);
    }
    const method = info.compressType;
    if (![ZIP_STORED, ZIP_DEFLATED, ZIP_BZIP2, ZIP_LZMA].includes(method)) {
      throw pyError('NotImplementedError', 'That compression method is not supported');
    }

    // The overlap check keeps the compressed data inside the archive, so it is read whole and the EOFError
    // ZipExtFile raises on a short read cannot occur.
    const raw = readAt(info.compressSize);
    const data = (method === ZIP_STORED ? raw : decompress(method, raw)).subarray(0, info.fileSize);
    if (zlib.crc32(data) !== info.crc) throw badZip(`Bad CRC-32 for file ${pyRepr(info.filename)}`);
    return Buffer.from(data);
  }
}

module.exports = { ZipFile };
