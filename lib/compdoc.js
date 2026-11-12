'use strict';
// Port of xlrd 2.0.2 compdoc (BSD): the OLE2 compound document reader that locates the Workbook stream of an
// XLS file, with its sector allocation checks and the messages it writes to the log.

const { pyError, structError } = require('./pyerrors');
const { pyBytesRepr } = require('./pystr');

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const EOCSID = -2;
const FREESID = -1;
const MSATSID = -4;
const EVILSID = -5;

function compDocError(message) {
  return pyError('xlrd.compdoc.CompDocError', message);
}

function assertion() {
  return pyError('AssertionError', '');
}

function ints(buf, offset, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(buf.readInt32LE(offset + 4 * i));
  return out;
}

/** CompDoc.seen: which structure claimed each sector (a Python array, so indexing past it raises). */
class SeenArray {
  /** @param {number} n the number of sectors */
  constructor(n) { this.a = new Uint8Array(n); }

  /**
   * Claim sector s for an owner id.
   * @param {number} s the sector
   * @param {number} id the owner id
   * @param {string} what the message prefix
   * @returns {void}
   * @throws {Error} pyName IndexError past the last sector, xlrd.compdoc.CompDocError when another structure already
   *   claimed it
   */
  mark(s, id, what) {
    if (s >= this.a.length) throw pyError('IndexError', 'array index out of range');
    if (this.a[s]) throw compDocError(`${what}: seen[${s}] == ${this.a[s]}`);
    this.a[s] = id;
  }
}

/** xlrd.compdoc.DirNode: one 128-byte directory entry of a compound document. */
class DirNode {
  /**
   * @param {number} did the directory entry id
   * @param {Buffer} dent the entry's bytes
   * @throws {Error} pyName struct.error for an entry cut short
   */
  constructor(did, dent) {
    this.DID = did;
    if (dent.length < 80) throw structError(16);
    if (dent.length < 124) throw structError(8);
    const cbufsize = dent.readUInt16LE(64);
    this.etype = dent[66];
    this.leftDID = dent.readInt32LE(68);
    this.rightDID = dent.readInt32LE(72);
    this.rootDID = dent.readInt32LE(76);
    this.firstSID = dent.readInt32LE(116);
    this.totSize = dent.readInt32LE(120);
    this.name = cbufsize === 0 ? '' : dent.subarray(0, cbufsize - 2).toString('utf16le');
    this.children = [];
    this.parent = -1;
  }
}

function buildFamilyTree(dirlist, parentDID, childDID) {
  if (childDID < 0) return;
  if (childDID >= dirlist.length) throw pyError('IndexError', 'list index out of range');
  buildFamilyTree(dirlist, parentDID, dirlist[childDID].leftDID);
  dirlist[parentDID].children.push(childDID);
  dirlist[childDID].parent = parentDID;
  buildFamilyTree(dirlist, parentDID, dirlist[childDID].rightDID);
  if (dirlist[childDID].etype === 1) buildFamilyTree(dirlist, childDID, dirlist[childDID].rootDID);
}

/** xlrd.compdoc.CompDoc: an OLE2 compound document, read for its Workbook stream. */
class CompDoc {
  /**
   * Parse the compound document header, sector tables and directory.
   * @param {Buffer} mem file contents
   * @param {function(string): void} log xlrd's logfile (standard output)
   * @throws {Error} pyName xlrd.compdoc.CompDocError for a bad signature, byte-order marker or sector table;
   *   struct.error for a header cut short; AssertionError where xlrd asserts
   */
  constructor(mem, log) {
    this.log = log;
    if (!mem.subarray(0, 8).equals(SIGNATURE)) throw compDocError('Not an OLE2 compound document');
    if (mem[28] !== 0xfe || mem[29] !== 0xff) {
      throw compDocError(`Expected "little-endian" marker, found ${pyBytesRepr(mem.subarray(28, 30))}`);
    }
    this.mem = mem;
    if (mem.length < 34) throw structError(4);
    let ssz = mem.readUInt16LE(30);
    let sssz = mem.readUInt16LE(32);
    if (ssz > 20) {
      log(`WARNING: sector size (2**${ssz}) is preposterous; assuming 512 and continuing ...\n`);
      ssz = 9;
    }
    if (sssz > ssz) {
      log(`WARNING: short stream sector size (2**${sssz}) is preposterous; assuming 64 and continuing ...\n`);
      sssz = 6;
    }
    const secSize = 2 ** ssz;
    this.secSize = secSize;
    this.shortSecSize = 2 ** sssz;
    if (this.secSize !== 512 || this.shortSecSize !== 64) {
      log(`@@@@ sec_size=${this.secSize} short_sec_size=${this.shortSecSize}\n`);
    }
    if (mem.length < 76) throw structError(32);
    const [, dirFirstSecSid, , minSizeStdStream, ssatFirstSecSid, ssatTotSecs, msatxFirstSecSid, msatxTotSecs] = ints(
      mem, 44, 8);
    this.dirFirstSecSid = dirFirstSecSid;
    this.minSizeStdStream = minSizeStdStream;
    const memDataLen = mem.length - 512;
    let memDataSecs = Math.floor(memDataLen / secSize);
    if (memDataLen % secSize) {
      memDataSecs += 1;
      log(`WARNING *** file size (${mem.length}) not 512 + multiple of sector size (${secSize})\n`);
    }
    this.memDataSecs = memDataSecs;
    this.memDataLen = memDataLen;
    const seen = new SeenArray(Math.max(0, memDataSecs));
    this.seen = seen;
    const nent = secSize / 4;
    const sector = (sid) => {
      const off = 512 + secSize * sid;
      if (off + secSize > mem.length) throw structError(secSize);
      return ints(mem, off, nent);
    };
    if (mem.length < 512) throw structError(436);
    const msat = ints(mem, 76, 109);
    if (!(msatxTotSecs === 0 && [EOCSID, FREESID, 0].includes(msatxFirstSecSid))) {
      let sid = msatxFirstSecSid;
      while (![EOCSID, FREESID, MSATSID].includes(sid)) {
        if (sid >= memDataSecs) throw compDocError(`MSAT extension: accessing sector ${sid} but only ${memDataSecs} in file`);
        if (sid < 0) throw compDocError(`MSAT extension: invalid sector id: ${sid}`);
        seen.mark(sid, 1, 'MSAT corruption');
        msat.push(...sector(sid));
        sid = msat.pop();
      }
    }
    this.SAT = [];
    let truncWarned = false;
    let dumpAgain = false;
    for (let i = 0; i < msat.length; i++) {
      const msid = msat[i];
      if (msid === FREESID || msid === EOCSID) continue;
      if (msid >= memDataSecs) {
        if (!truncWarned) {
          log('WARNING *** File is truncated, or OLE2 MSAT is corrupt!!\n');
          log(`INFO: Trying to access sector ${msid} but only ${memDataSecs} available\n`);
          truncWarned = true;
        }
        msat[i] = EVILSID;
        dumpAgain = true;
        continue;
      } else if (msid < -2) {
        throw compDocError(`MSAT: invalid sector id: ${msid}`);
      }
      seen.mark(msid, 2, 'MSAT extension corruption');
      this.SAT.push(...sector(msid));
    }
    if (dumpAgain) for (let x = memDataSecs; x < this.SAT.length; x++) this.SAT[x] = EVILSID;
    const dbytes = this.getStream(mem, 512, this.SAT, secSize, dirFirstSecSid, null, 'directory', 3);
    this.dirlist = [];
    for (let pos = 0, did = 0; pos < dbytes.length; pos += 128, did++) {
      this.dirlist.push(new DirNode(did, dbytes.subarray(pos, pos + 128)));
    }
    buildFamilyTree(this.dirlist, 0, this.dirlist[0].rootDID);
    const sscsDir = this.dirlist[0];
    if (sscsDir.etype !== 5) throw assertion();
    if (sscsDir.firstSID < 0 || sscsDir.totSize === 0) this.SSCS = Buffer.alloc(0);
    else this.SSCS = this.getStream(mem, 512, this.SAT, secSize, sscsDir.firstSID, sscsDir.totSize, 'SSCS', 4);
    this.SSAT = [];
    if (ssatTotSecs > 0 && sscsDir.totSize === 0) {
      log('WARNING *** OLE2 inconsistency: SSCS size is 0 but SSAT size is non-zero\n');
    }
    if (sscsDir.totSize > 0) {
      let sid = ssatFirstSecSid;
      let nsecs = ssatTotSecs;
      while (sid >= 0 && nsecs > 0) {
        seen.mark(sid, 5, 'SSAT corruption');
        nsecs -= 1;
        this.SSAT.push(...sector(sid));
        sid = this.SAT[sid];
      }
      if (!(nsecs === 0 && sid === EOCSID)) throw assertion();
    }
  }

  /**
   * CompDoc._get_stream: a stream's bytes following its sector chain, marking each sector seen.
   * @param {Buffer} mem the bytes the sectors index into
   * @param {number} base the offset of sector 0
   * @param {number[]} sat the sector allocation table to follow
   * @param {number} secSize the sector size
   * @param {number} startSid the first sector
   * @param {number|null} size the stream size, or null to take whole sectors
   * @param {string} name the stream name for messages
   * @param {number|null} seenId the owner id to mark sectors with, or null not to mark
   * @returns {Buffer}
   * @throws {Error} pyName xlrd.compdoc.CompDocError for a sector seen twice or outside the table, AssertionError
   *   for a chain that does not end in EOCSID
   */
  getStream(mem, base, sat, secSize, startSid, size, name, seenId) {
    const sectors = [];
    let s = startSid;
    let todo = size;
    while (s >= 0) {
      if (seenId !== null) {
        this.seen.mark(s, seenId, `${name} corruption`);
      }
      const start = base + s * secSize;
      let grab = secSize;
      if (size !== null) {
        if (grab > todo) grab = todo;
        todo -= grab;
      }
      sectors.push(mem.subarray(start, start + grab));
      if (s >= sat.length) throw compDocError(`OLE2 stream '${name}': sector allocation table invalid entry (${s})`);
      s = sat[s];
    }
    if (s !== EOCSID) throw assertion();
    if (size !== null && todo !== 0) {
      this.log(`WARNING *** OLE2 stream '${name}': expected size ${size}, actual size ${size - todo}\n`);
    }
    return Buffer.concat(sectors);
  }

  /**
   * CompDoc._dir_search: the directory entry of a "/"-separated path, case-insensitive.
   * @param {string[]} pathParts
   * @param {number} [storageDID] the storage to search
   * @returns {object|null} the user-stream entry, or null when absent
   * @throws {Error} pyName xlrd.compdoc.CompDocError when the path names a storage or a non-user stream
   */
  dirSearch(pathParts, storageDID = 0) {
    const [head, ...tail] = pathParts;
    const dl = this.dirlist;
    for (const child of dl[storageDID].children) {
      if (dl[child].name.toLowerCase() === head.toLowerCase()) {
        const et = dl[child].etype;
        if (et === 2) return dl[child];
        if (et === 1) {
          if (!tail.length) throw compDocError("Requested component is a 'storage'");
          return this.dirSearch(tail, child);
        }
        throw compDocError("Requested stream is not a 'user stream'");
      }
    }
    return null;
  }

  /**
   * CompDoc.locate_named_stream: where a stream's bytes are.
   * @param {string} qname stream name such as "Workbook"
   * @returns {Array} [mem, base, length], or [null, 0, 0] when the stream is absent
   * @throws {Error} pyName xlrd.compdoc.CompDocError for a stream longer than the file or with a bad chain,
   *   AssertionError as getStream()
   */
  locateNamedStream(qname) {
    const d = this.dirSearch(qname.split('/'));
    if (d === null) return [null, 0, 0];
    if (d.totSize > this.memDataLen) {
      throw compDocError(`'${qname}' stream length (${d.totSize} bytes) > file data size (${this.memDataLen} bytes)`);
    }
    if (d.totSize >= this.minSizeStdStream) return this.locateStream(d.firstSID, d.totSize, qname, d.DID + 6);
    const data = this.getStream(this.SSCS, 0, this.SSAT, this.shortSecSize, d.firstSID, d.totSize,
      `${qname} (from SSCS)`, null);
    return [data, 0, d.totSize];
  }

  /**
   * CompDoc._locate_stream: a big stream's bytes, as a view of the file when its sectors are contiguous.
   * @param {number} startSid the first sector
   * @param {number} expectedSize the stream size
   * @param {string} qname the stream name for messages
   * @param {number} seenId the owner id to mark sectors with
   * @returns {Array} [mem, base, length]
   * @throws {Error} pyName xlrd.compdoc.CompDocError for a negative start, a sector seen twice or too many sectors;
   *   AssertionError for a chain that ends early
   */
  locateStream(startSid, expectedSize, qname, seenId) {
    const secSize = this.secSize;
    let s = startSid;
    if (s < 0) throw compDocError(`_locate_stream: start_sid (${startSid}) is -ve`);
    let p = -99;
    let startPos = -9999;
    let endPos = -8888;
    const slices = [];
    let totFound = 0;
    const foundLimit = Math.floor((expectedSize + secSize - 1) / secSize);
    while (s >= 0) {
      this.seen.mark(s, seenId, `${qname} corruption`);
      totFound += 1;
      if (totFound > foundLimit) {
        throw compDocError(`${qname}: size exceeds expected ${foundLimit * secSize} bytes; corrupt?`);
      }
      if (s === p + 1) endPos += secSize;
      else {
        if (p >= 0) slices.push([startPos, endPos]);
        startPos = 512 + s * secSize;
        endPos = startPos + secSize;
      }
      p = s;
      s = this.SAT[s];
    }
    if (s !== EOCSID || totFound !== foundLimit) throw assertion();
    if (!slices.length) return [this.mem, startPos, expectedSize];
    slices.push([startPos, endPos]);
    return [Buffer.concat(slices.map(([a, b]) => this.mem.subarray(a, b))), 0, expectedSize];
  }
}

module.exports = { CompDoc, SIGNATURE };
