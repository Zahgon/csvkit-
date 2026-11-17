'use strict';
// Python's open() for whole text files: reading one into a string, writing a string to one, and an in-memory sink.

const fs = require('node:fs');
const codecs = require('./codecs');
const { osError } = require('./pyerrors');

/**
 * open(path).read(): the file as UTF-8 text (the locale's encoding in the image), newlines translated.
 * @param {string} p
 * @returns {string}
 * @throws {Error} pyName the OSError open() raises (IsADirectoryError, PermissionError ...), or UnicodeDecodeError
 */
function readTextFile(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    throw osError(e, p);
  }
  return new codecs.TextReader(buf, 'utf-8').read();
}

/**
 * open(filename, 'w') and write: creates or truncates the file and writes the text as UTF-8.
 * @param {string} filename
 * @param {string} data
 * @returns {void}
 * @throws {Error} pyName the OSError subclass Python's open() raises (FileNotFoundError, PermissionError ...)
 */
function writeTextFile(filename, data) {
  try {
    fs.writeFileSync(filename, data);
  } catch (e) {
    throw osError(e, filename);
  }
}

/** A text sink collecting what a CSV writer writes, so it can be written to a file in one call. */
class StringOut {
  /** Starts empty. */
  constructor() { this.data = ''; }

  /**
   * Appends text.
   * @param {string} s
   * @returns {void}
   */
  write(s) { this.data += s; }
}

module.exports = { readTextFile, writeTextFile, StringOut };
