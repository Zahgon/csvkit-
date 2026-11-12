'use strict';
// Python exceptions as JavaScript errors. The port raises an Error whose `pyName` is the qualified name of the
// exception the original raises; lib/cli.js prints it the way Python reports an uncaught exception.

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

module.exports = { pyError, truncatedStreamError, structError };
