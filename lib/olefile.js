'use strict';
// Port of the reading path of olefile 0.47 (BSD) that agate-excel falls back on when xlrd rejects a compound
// document: OleFileIO(f) with the default raise_defects=DEFECT_FATAL (lesser defects are tolerated), then
// exists() and openstream() for the Workbook stream.

const { pyError } = require('./pyerrors');

const MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;
const UNKNOWN_SIZE = 0x7fffffff;
const STGTY_STREAM = 2;

function oleError(message, name = 'olefile.olefile.OleFileError') {
  return pyError(name, message);
}

/** sect2array: little-endian unsigned 32-bit integers. */
function uint32s(buf) {
  if (buf.length % 4) throw oleError('bytes length not a multiple of item size', 'ValueError');
  const out = [];
  for (let i = 0; i < buf.length; i += 4) out.push(buf.readUInt32LE(i));
  return out;
}

/** OleStream: the bytes of a sector chain, cut to the stream size (lenient on chain defects). */
function readChain(data, sect, size, offset, sectorsize, fat) {
  let unknownSize = false;
  if (size === UNKNOWN_SIZE) {
    size = fat.length * sectorsize;
    unknownSize = true;
  }
  const nbSectors = Math.floor((size + sectorsize - 1) / sectorsize);
  const parts = [];
  for (let i = 0; i < nbSectors; i++) {
    if (sect === ENDOFCHAIN && unknownSize) break;
    if (sect < 0 || sect >= fat.length) break;
    const start = offset + sectorsize * sect;
    parts.push(data.subarray(Math.min(start, data.length), Math.min(start + sectorsize, data.length)));
    sect = fat[sect];
  }
  const joined = Buffer.concat(parts);
  return joined.length >= size ? joined.subarray(0, size) : joined;
}

/** olefile.OleDirectoryEntry: one 128-byte directory entry (name, type, tree links, start sector and size). */
class DirEntry {
  /**
   * @param {Buffer} entry the 128 bytes of the entry
   * @param {number} sid its stream id
   * @throws {Error} pyName struct.error for an entry cut short
   */
  constructor(entry, sid) {
    if (entry.length !== 128) throw oleError(`unpack requires a buffer of 128 bytes`, 'struct.error');
    this.sid = sid;
    this.kids = [];
    this.used = false;
    let namelength = entry.readUInt16LE(64);
    this.entryType = entry[66];
    this.sidLeft = entry.readUInt32LE(68);
    this.sidRight = entry.readUInt32LE(72);
    this.sidChild = entry.readUInt32LE(76);
    this.isectStart = entry.readUInt32LE(116);
    this.size = entry.readUInt32LE(120);
    if (namelength > 64) namelength = 64;
    const end = namelength - 2 < 0 ? 64 + (namelength - 2) : namelength - 2;
    this.name = new TextDecoder('utf-16le').decode(entry.subarray(0, end));
  }
}

/** olefile.OleFileIO: the streams of an OLE2 compound document. */
class OleFileIO {
  /**
   * Parse the header, FAT and directory of a compound document.
   * @param {Buffer} data whole file
   * @throws {Error} pyName olefile.olefile.NotOleFileError without the OLE2 signature; OleFileError or OSError for
   *   a damaged DIFAT, sector or directory
   */
  constructor(data) {
    this.data = data;
    const header = data.subarray(0, 512);
    if (header.length !== 512 || !header.subarray(0, 8).equals(MAGIC)) {
      throw oleError('not an OLE2 structured storage file', 'olefile.olefile.NotOleFileError');
    }
    this.sectorsize = 2 ** header.readUInt16LE(30);
    this.minisectorsize = 2 ** header.readUInt16LE(32);
    const numFatSectors = header.readUInt32LE(44);
    const firstDirSector = header.readUInt32LE(48);
    this.minisectorcutoff = 0x1000;
    this.minifatsect = header.readUInt32LE(60);
    this.numMiniFatSectors = header.readUInt32LE(64);
    const firstDifatSector = header.readUInt32LE(68);
    const numDifatSectors = header.readUInt32LE(72);
    this.nbSect = Math.floor((data.length + this.sectorsize - 1) / this.sectorsize) - 1;
    this.fat = [];
    this.loadfatSect(uint32s(header.subarray(76, 512)));
    if (numDifatSectors !== 0) {
      if (firstDifatSector >= this.nbSect) throw oleError('incorrect DIFAT, first index out of range');
      const perSector = this.sectorsize / 4 - 1;
      const nbDifat = Math.floor((numFatSectors - 109 + perSector - 1) / perSector);
      if (numDifatSectors !== nbDifat) throw oleError('incorrect DIFAT', 'OSError');
      let isect = firstDifatSector;
      for (let i = 0; i < nbDifat; i++) {
        const difat = uint32s(this.getsect(isect));
        this.loadfatSect(difat.slice(0, perSector));
        isect = difat[perSector];
      }
      if (isect !== ENDOFCHAIN && isect !== FREESECT) throw oleError('incorrect end of DIFAT', 'OSError');
    }
    if (this.fat.length > this.nbSect) this.fat = this.fat.slice(0, Math.max(0, this.nbSect));
    this.directory = readChain(data, firstDirSector, UNKNOWN_SIZE, this.sectorsize, this.sectorsize, this.fat);
    this.direntries = new Array(Math.floor(this.directory.length / 128)).fill(null);
    this.root = this.loadDirentry(0);
    this.buildStorageTree(this.root);
    this.ministream = null;
  }

  /**
   * OleFileIO.getsect: one sector's bytes.
   * @param {number} sect the sector index
   * @returns {Buffer}
   * @throws {Error} pyName olefile.olefile.OleFileError for a sector past the end of the file
   */
  getsect(sect) {
    const start = this.sectorsize * (sect + 1);
    const sector = this.data.subarray(Math.min(start, this.data.length), start + this.sectorsize);
    if (sector.length !== this.sectorsize) throw oleError('incomplete OLE sector');
    return sector;
  }

  /**
   * OleFileIO.loadfat_sect: appends the FAT sectors listed in a DIFAT block, up to the first free or end marker.
   * @param {number[]} entries sector indices
   * @returns {void}
   * @throws {Error} as getsect()
   */
  loadfatSect(entries) {
    for (const isect of entries) {
      if (isect === ENDOFCHAIN || isect === FREESECT) break;
      this.fat.push(...uint32s(this.getsect(isect)));
    }
  }

  /**
   * OleFileIO._load_direntry: the directory entry with a stream id, parsed once.
   * @param {number} sid
   * @returns {DirEntry}
   * @throws {Error} pyName olefile.olefile.OleFileError for an id outside the directory
   */
  loadDirentry(sid) {
    if (sid < 0 || sid >= this.direntries.length) throw oleError('OLE directory index out of range');
    if (this.direntries[sid] !== null) return this.direntries[sid];
    this.direntries[sid] = new DirEntry(this.directory.subarray(sid * 128, sid * 128 + 128), sid);
    return this.direntries[sid];
  }

  /**
   * OleDirectoryEntry.build_storage_tree: collects a storage's children, sorted by name.
   * @param {DirEntry} node
   * @returns {void}
   * @throws {Error} as loadDirentry()
   */
  buildStorageTree(node) {
    if (node.sidChild !== NOSTREAM) {
      this.appendKids(node, node.sidChild);
      node.kids.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    }
  }

  /**
   * OleDirectoryEntry.append_kids: walks the red-black tree of a storage's children in order, skipping entries
   * already used.
   * @param {DirEntry} node the parent storage
   * @param {number} childSid the subtree's root id
   * @returns {void}
   * @throws {Error} as loadDirentry()
   */
  appendKids(node, childSid) {
    if (childSid === NOSTREAM || childSid < 0 || childSid >= this.direntries.length) return;
    const child = this.loadDirentry(childSid);
    if (child.used) return;
    child.used = true;
    this.appendKids(node, child.sidLeft);
    node.kids.push(child);
    this.appendKids(node, child.sidRight);
    this.buildStorageTree(child);
  }

  /**
   * OleFileIO._find for a top-level name (case-insensitive).
   * @param {string} name
   * @returns {DirEntry}
   * @throws {Error} pyName OSError "file not found"
   */
  find(name) {
    const kid = this.root.kids.find((k) => k.name.toLowerCase() === name.toLowerCase());
    if (!kid) throw oleError('file not found', 'OSError');
    return kid;
  }

  /**
   * OleFileIO.exists for a top-level name (case-insensitive).
   * @param {string} name
   * @returns {boolean}
   */
  exists(name) {
    return this.root.kids.some((k) => k.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * OleFileIO.openstream: the stream's bytes, from the FAT or the MiniFAT according to its size.
   * @param {string} name a top-level stream name
   * @returns {Buffer}
   * @throws {Error} pyName OSError when there is no such entry or it is not a stream
   */
  openstream(name) {
    const entry = this.find(name);
    if (entry.entryType !== STGTY_STREAM) throw oleError('this file is not a stream', 'OSError');
    if (entry.size >= this.minisectorcutoff) {
      return readChain(this.data, entry.isectStart, entry.size, this.sectorsize, this.sectorsize, this.fat);
    }
    if (this.ministream === null) {
      const nbMinisectors = Math.floor((this.root.size + this.minisectorsize - 1) / this.minisectorsize);
      const raw = readChain(this.data, this.minifatsect, this.numMiniFatSectors * this.sectorsize, this.sectorsize,
        this.sectorsize, this.fat);
      this.minifat = uint32s(raw).slice(0, nbMinisectors);
      this.ministream = readChain(this.data, this.root.isectStart, this.root.size, this.sectorsize, this.sectorsize,
        this.fat);
    }
    return readChain(this.ministream, entry.isectStart, entry.size, 0, this.minisectorsize, this.minifat);
  }
}

module.exports = { OleFileIO };
