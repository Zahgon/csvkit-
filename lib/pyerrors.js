'use strict';
// Python exceptions as JavaScript errors. The port raises an Error whose `pyName` is the qualified name of the
// exception the original raises; lib/cli.js prints it the way Python reports an uncaught exception.

const { pyRepr } = require('./pystr');

/**
 * An Error standing for a Python exception.
 * @param {string} name the exception's qualified class name, e.g. 'ValueError' or 'agate.exceptions.CastError'
 * @param {string} message str() of the exception
 * @returns {Error} the error, for the caller to throw
 */
function pyError(name, message) {
  const e = new Error(message);
  e.pyName = name;
  return e;
}

/**
 * The EOFError _compression.DecompressReader raises for a gzip, bz2 or lzma stream that ends early.
 * @returns {Error}
 */
function truncatedStreamError() {
  return pyError('EOFError', 'Compressed file ended before the end-of-stream marker was reached');
}

/**
 * The struct.error struct.unpack raises for a buffer shorter than the format.
 * @param {number} size the format's size in bytes
 * @returns {Error}
 */
function structError(size) {
  return pyError('struct.error', `unpack requires a buffer of ${size} bytes`);
}

// The errno, OSError subclass and glibc strerror() text Python reports for the Node system error codes that opening
// or reading a path can give.
const OS_ERRORS = {
  EPERM: [1, 'PermissionError', 'Operation not permitted'],
  ENOENT: [2, 'FileNotFoundError', 'No such file or directory'],
  EIO: [5, 'OSError', 'Input/output error'],
  ENXIO: [6, 'OSError', 'No such device or address'],
  EACCES: [13, 'PermissionError', 'Permission denied'],
  EEXIST: [17, 'FileExistsError', 'File exists'],
  ENOTDIR: [20, 'NotADirectoryError', 'Not a directory'],
  EISDIR: [21, 'IsADirectoryError', 'Is a directory'],
  EINVAL: [22, 'OSError', 'Invalid argument'],
  EMFILE: [24, 'OSError', 'Too many open files'],
  ETXTBSY: [26, 'OSError', 'Text file busy'],
  ENOSPC: [28, 'OSError', 'No space left on device'],
  EROFS: [30, 'OSError', 'Read-only file system'],
  ENAMETOOLONG: [36, 'OSError', 'File name too long'],
  ELOOP: [40, 'OSError', 'Too many levels of symbolic links'],
};

/**
 * The OSError Python raises where Node failed on a path with a system error, e.g. FileNotFoundError
 * "[Errno 2] No such file or directory: 'x.csv'".
 * @param {Error} e the Node error (its `code` is e.g. 'ENOENT')
 * @param {string} [filename] the path Python names in the message; omitted for a file descriptor
 * @returns {Error} the Python error, or `e` itself for an error that is not a known system error
 */
function osError(e, filename) {
  const known = OS_ERRORS[e.code];
  if (!known) return e;
  const [errno, name, text] = known;
  return pyError(name, `[Errno ${errno}] ${text}${filename === undefined ? '' : `: ${pyRepr(filename)}`}`);
}

// _compression.BUFFER_SIZE: the compressed bytes read per fp.read(), and the size of each read1() TextIOWrapper makes
const BUFFER_SIZE = 8192;

/**
 * What a decompressor did while decoding one compressed stream from a whole buffer, in order: the input it had
 * consumed whenever it started on a new 8192-byte read of the file, the output it had ready by then, and the error
 * it raised or the offset where the stream ended. replayReads() replays it the way Python feeds a decompressor.
 */
class DecompressTrace {
  /**
   * @param {number[]} out the decoder's output array (shared by every stream of the file)
   * @param {number} size the compressed file's length
   * @param {number} pos the stream's offset in the file
   */
  constructor(out, size, pos) {
    this.out = out;
    this.size = size;
    this.pos = pos;
    this.steps = [];
    this.startOut = out.length;
    this.lastReady = out.length;
  }

  /**
   * Records that the decoder had out.length bytes of output ready.
   * @returns {void}
   */
  ready() {
    if (this.out.length > this.lastReady) {
      this.lastReady = this.out.length;
      this.steps.push({ ready: this.lastReady });
    }
  }

  /**
   * The decoder consumes the input up to `end`. Only consumption that starts on a new 8192-byte read is recorded, as
   * Python only ever has whole reads (or the whole file) at hand.
   * @param {number} end the offset after the last byte consumed
   * @returns {void}
   * @throws {Error} pyName EOFError when the file ends first
   */
  need(end) {
    if (end <= this.pos) return;
    if (end > this.size) throw truncatedStreamError();
    if (Math.ceil(end / BUFFER_SIZE) > Math.ceil(this.pos / BUFFER_SIZE)) {
      this.ready();
      this.steps.push({ need: end });
    }
    this.pos = end;
  }

  /**
   * Records exactly how far the decoder has consumed its input, for a point where Python's needs_input depends on
   * it (libbz2 stops consuming once a block is decoded, until its output is delivered).
   * @param {number} end the offset after the last byte consumed
   * @returns {void}
   */
  consumed(end) {
    this.ready();
    this.steps.push({ need: end });
    this.pos = Math.max(this.pos, end);
  }

  /**
   * Records the error the decoder raises at this point (after the output it had ready).
   * @param {Error} error
   * @returns {void}
   */
  fail(error) {
    this.ready();
    this.steps.push({ error });
  }

  /**
   * Records the end of the stream.
   * @param {number} pos the offset after the stream (where Python's unused_data starts)
   * @returns {void}
   */
  end(pos) {
    this.ready();
    this.steps.push({ end: pos });
  }
}

/**
 * Decodes one stream into a DecompressTrace, ending it with the stream's end, its EOFError (the decoder wants input
 * past the end of the file) or the error the decoder raises.
 * @param {number[]} out the output array
 * @param {number} size the compressed file's length
 * @param {number} pos the stream's offset
 * @param {function(DecompressTrace): number} decode decodes the stream, consuming its input through the trace, and
 *   returns the offset after it
 * @returns {DecompressTrace}
 */
function traceStream(out, size, pos, decode) {
  const trace = new DecompressTrace(out, size, pos);
  try {
    trace.end(decode(trace));
  } catch (e) {
    if (!e.pyName) throw e;
    if (e.pyName === 'EOFError') trace.consumed(size + 1);
    else trace.fail(e);
  }
  return trace;
}

/**
 * Replays the read1(8192) calls io.TextIOWrapper makes on a bz2/lzma file: each is one
 * _compression.DecompressReader.read(8192), which feeds the decompressor 8192 compressed bytes whenever it
 * needs_input, starts a new decompressor on the unused data after a stream ends (ignoring trailing data the first
 * call on it rejects) and raises EOFError when the file ends before a stream does.
 * @param {number} size the compressed file's length
 * @param {function(number): DecompressTrace} traceAt decodes the stream at an offset
 * @param {object} opts
 * @param {string} opts.trailingError the decompressor's error class that marks trailing garbage
 * @param {boolean} opts.fullNeedsInput whether needs_input is set when the input is used up even though the output
 *   buffer is full (BZ2Decompressor in Python 3.11 does, LZMADecompressor does not)
 * @returns {{length: number, error: Error|null}} how many output bytes the reads deliver, and the error raised
 *   after them (null when the reads reach the end)
 */
function replayReads(size, traceAt, opts) {
  let avail = 0;
  // a decompressor's state: its next trace step, output position, input consumed, eof and needs_input
  const start = (trace, used) => ({
    steps: trace.steps, k: 0, o: trace.startOut, used, eof: false, endPos: 0, needsInput: true,
  });
  let dec = null;
  const call = () => {
    const begin = dec.o;
    const limit = begin + BUFFER_SIZE;
    for (;;) {
      const s = dec.steps[dec.k];
      if ('ready' in s) {
        if (s.ready > dec.o) {
          if (dec.o === limit) break;
          // libbz2 and liblzma go on (checks, headers, the next block's input) when the output ends at the limit
          dec.o = Math.min(s.ready, limit);
          if (dec.o < s.ready) break;
        }
        dec.k++;
      } else if ('need' in s) {
        if (s.need > avail) {
          dec.used = avail;
          break;
        }
        dec.used = Math.max(dec.used, s.need);
        dec.k++;
      } else if ('error' in s) {
        throw s.error;
      } else {
        dec.eof = true;
        dec.endPos = s.end;
        dec.k++;
        break;
      }
    }
    dec.needsInput = !dec.eof && dec.used === avail && (opts.fullNeedsInput || dec.o < limit);
    return dec.o - begin;
  };
  const read = () => {
    for (;;) {
      let n;
      if (dec.eof) {
        if (avail === dec.endPos) {
          if (avail >= size) return 0;
          avail = Math.min(size, avail + BUFFER_SIZE);
        }
        const pos = dec.endPos;
        dec = start(traceAt(pos), pos);
        try {
          n = call();
        } catch (e) {
          if (e.pyName !== opts.trailingError) throw e;
          return 0;
        }
      } else {
        if (dec.needsInput) {
          if (avail >= size) throw truncatedStreamError();
          avail = Math.min(size, avail + BUFFER_SIZE);
        }
        n = call();
      }
      if (n) return n;
    }
  };
  let length = 0;
  try {
    dec = start(traceAt(0), 0);
    for (let n = read(); n; n = read()) length += n;
  } catch (e) {
    if (!e.pyName) throw e;
    return { length, error: e };
  }
  return { length, error: null };
}

module.exports = { pyError, osError, truncatedStreamError, structError, traceStream, replayReads };
