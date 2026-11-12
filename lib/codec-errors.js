'use strict';
// Python's UnicodeError and UnicodeDecodeError (Objects/exceptions.c) as the codec ports raise them.

/**
 * Python's UnicodeError.
 */
class UnicodeError extends Error {
  /** @param {string} m the message */
  constructor(m) {
    super(m);
    this.pyName = 'UnicodeError';
  }
}

/** UnicodeDecodeError with CPython's message for the bad bytes object[start:end]. */
class UnicodeDecodeError extends Error {
  /**
   * @param {string} encoding the codec name the message shows
   * @param {Buffer} object the bytes being decoded
   * @param {number} start the first bad byte
   * @param {number} end one past the last bad byte
   * @param {string} reason e.g. "invalid start byte"
   */
  constructor(encoding, object, start, end, reason) {
    const where = end - start === 1
      ? `byte 0x${object[start].toString(16).padStart(2, '0')} in position ${start}`
      : `bytes in position ${start}-${end - 1}`;
    super(`'${encoding}' codec can't decode ${where}: ${reason}`);
    this.pyName = 'UnicodeDecodeError';
    this.start = start;
    this.end = end;
  }
}

module.exports = { UnicodeError, UnicodeDecodeError };
