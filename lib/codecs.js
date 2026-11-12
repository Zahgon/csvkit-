'use strict';
// Port of CPython 3.11's codec lookup (Python/codecs.c, Lib/encodings/__init__.py), of the incremental decoders of
// its text codecs with their UnicodeDecodeError messages, and of the reading side of io.TextIOWrapper (8192-byte
// chunks, universal newlines) that csvkit's input files go through.

const { ALIASES, CODECS, CHARMAPS } = require('./codec-tables');
const { UnicodeError, UnicodeDecodeError } = require('./codec-errors');
const U = require('./codecs-unicode');
const { CJK_CODECS, ISO2022, cjkDecoder, hzDecode, iso2022Decoder } = require('./codecs-cjk');

const CHUNK_SIZE = 8192;

/**
 * Python's LookupError, raised for an unknown encoding name.
 */
class LookupError extends Error {
  /** @param {string} m the message, e.g. "unknown encoding: x" */
  constructor(m) {
    super(m);
    this.pyName = 'LookupError';
  }
}

// _Py_normalize_encoding: ASCII letters, digits and dots kept (lowercased), other runs become one "_".
function normalize(name) {
  let out = '';
  let punct = false;
  for (const byte of Buffer.from(String(name), 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9.]/.test(c)) {
      if (punct && out) out += '_';
      punct = false;
      out += c.toLowerCase();
    } else {
      punct = true;
    }
  }
  return out;
}

/**
 * codecs.lookup(name) restricted to what csvkit needs: the codec module name of a text encoding.
 * @param {string} name an encoding name as the user gave it
 * @returns {string} the codec module name (e.g. "utf_8")
 * @throws {LookupError} for an unknown encoding or one that is not a text encoding
 */
function lookup(name) {
  const norm = normalize(name);
  const aliased = ALIASES[norm] || ALIASES[norm.replace(/\./g, '_')];
  const modnames = aliased ? [aliased, norm] : [norm];
  const mod = modnames.find((m) => m && !m.includes('.') && Object.prototype.hasOwnProperty.call(CODECS, m));
  if (mod === undefined) throw new LookupError(`unknown encoding: ${name}`);
  if (CODECS[mod] !== 'text') {
    throw new LookupError(`'${name}' is not a text encoding; use codecs.open() to handle arbitrary codecs`);
  }
  return mod;
}

// ---------------------------------------------------------------- decoders

/**
 * An incremental decoder. The bytes it leaves unconsumed are handed back at the start of the next input, as
 * codecs.BufferedIncrementalDecoder does, and its errors carry positions relative to `input`.
 * @callback Decoder
 * @param {Buffer} input the pending bytes followed by the new chunk
 * @param {boolean} final whether no more input follows (an incomplete sequence is then an error)
 * @param {object} state the decoder's state across calls; `whole` is set when decoding a complete byte string
 * @returns {Array} [decoded text, number of bytes consumed]
 * @throws {UnicodeDecodeError} for bytes the codec rejects (some codecs raise UnicodeError)
 */

/**
 * A single-byte charmap codec's decoder.
 * @param {string} table the 256 characters, "\ufffe" for an undefined byte
 * @returns {Decoder}
 */
function charmapDecoder(table) {
  return (input) => {
    let out = '';
    for (let i = 0; i < input.length; i++) {
      const ch = table[input[i]];
      if (ch === '\ufffe') throw new UnicodeDecodeError('charmap', input, i, i + 1, 'character maps to <undefined>');
      out += ch;
    }
    return [out, input.length];
  };
}

/**
 * The incremental decoder of a text codec module (every one lookup() can return).
 * @param {string} codec the codec module name
 * @returns {Decoder}
 * @throws {LookupError} for a codec without a decoder here
 */
function decoderFor(codec) {
  if (CHARMAPS[codec]) return charmapDecoder(CHARMAPS[codec]);
  if (CJK_CODECS.has(codec)) return cjkDecoder(codec);
  if (ISO2022[codec]) return iso2022Decoder(codec);
  switch (codec) {
    case 'utf_8': return (input, final) => U.utf8Decode(input, final);
    case 'utf_8_sig': return U.utf8SigDecode;
    case 'ascii': return U.asciiDecode;
    case 'latin_1': case 'charmap': return (input) => [input.toString('latin1'), input.length];
    case 'utf_16': return U.bomDecoder(2, U.utf16Units, 'UTF-16');
    case 'utf_16_le': return (input, final) => U.utf16Units(input, final, true);
    case 'utf_16_be': return (input, final) => U.utf16Units(input, final, false);
    case 'utf_32': return U.bomDecoder(4, U.utf32Units, 'UTF-32');
    case 'utf_32_le': return (input, final) => U.utf32Units(input, final, true);
    case 'utf_32_be': return (input, final) => U.utf32Units(input, final, false);
    case 'utf_7': return U.utf7Decode;
    case 'hz': return hzDecode;
    case 'unicode_escape': return U.unicodeEscapeDecode;
    case 'punycode': return U.punycodeDecode;
    case 'idna': return U.idnaDecode;
    case 'raw_unicode_escape': return U.rawUnicodeEscapeDecode;
    case 'undefined': return () => { throw new UnicodeError('undefined encoding'); };
    default: throw new LookupError(`unknown encoding: ${codec}`);
  }
}

/**
 * Decodes a whole byte string, as bytes.decode(encoding) does.
 * @param {Buffer} buf the bytes
 * @param {string} name the encoding name
 * @returns {string} the text
 * @throws {LookupError} for an unknown encoding
 * @throws {Error} pyName UnicodeDecodeError (or UnicodeError) for bytes the codec rejects
 */
function decode(buf, name) {
  return decoderFor(lookup(name))(buf, true, { first: true, whole: true })[0];
}

/**
 * Decodes a whole byte string, as bytes.decode(encoding, 'ignore') does: undecodable bytes are dropped.
 * @param {Buffer} buf the bytes
 * @param {string} name the encoding name
 * @returns {string} the text
 * @throws {LookupError} for an unknown encoding
 */
function decodeIgnoringErrors(buf, name) {
  const decoder = decoderFor(lookup(name));
  let state = { first: true, whole: true };
  let input = buf;
  let out = '';
  for (;;) {
    try {
      return out + decoder(input, true, { ...state })[0];
    } catch (e) {
      if (!(e instanceof UnicodeDecodeError)) throw e;
      const before = { ...state };
      out += decoder(input.subarray(0, e.start), false, before)[0];
      state = before;
      input = input.subarray(e.end);
    }
  }
}

/**
 * The reading side of io.TextIOWrapper(newline=None) over an in-memory byte string; endError, when given, is what
 * the underlying binary stream raises once its bytes are exhausted.
 */
class TextReader {
  /**
   * @param {Buffer} buf the whole byte stream
   * @param {string} encoding the codec name
   * @param {Error|null} [endError] the error the binary stream raises at its end (a truncated compressed file)
   * @throws {LookupError} for an unknown encoding
   */
  constructor(buf, encoding, endError = null) {
    this.buf = buf;
    this.endError = endError;
    this.decoder = decoderFor(lookup(encoding));
    this.state = { first: true };
    this.bytePos = 0;
    this.pending = Buffer.alloc(0);
    this.pendingCR = false;
    this.decoded = '';
    this.offset = 0;
    this.eof = false;
  }

  /**
   * IncrementalNewlineDecoder.decode with translate=True: decodes a chunk and appends it, newlines translated, to
   * the decoded text.
   * @param {Buffer} chunk
   * @param {boolean} final whether this is the end of the stream
   * @returns {void}
   * @throws {Error} pyName UnicodeDecodeError (or UnicodeError) for bytes the codec rejects
   */
  feed(chunk, final) {
    const input = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const [text, consumed] = this.decoder(input, final, this.state);
    this.pending = input.subarray(consumed);
    let output = text;
    if (this.pendingCR && (output || final)) {
      output = `\r${output}`;
      this.pendingCR = false;
    }
    if (output.endsWith('\r') && !final) {
      output = output.slice(0, -1);
      this.pendingCR = true;
    }
    this.decoded = this.decoded.slice(this.offset) + output.replace(/\r\n?/g, '\n');
    this.offset = 0;
    if (final) this.eof = true;
  }

  /**
   * TextIOWrapper._read_chunk: reads and decodes the next chunk of bytes.
   * @param {number} [size] how many bytes
   * @returns {boolean} false once the stream was already at its end
   * @throws {Error} endError at the end of a truncated stream, or the codec's UnicodeDecodeError
   */
  readChunk(size = CHUNK_SIZE) {
    if (this.eof) return false;
    const chunk = this.buf.subarray(this.bytePos, this.bytePos + size);
    if (!chunk.length && this.endError) throw this.endError;
    this.bytePos += chunk.length;
    this.feed(chunk, chunk.length === 0);
    return true;
  }

  /**
   * @returns {string} the next line with its "\n", or "" at the end
   * @throws {Error} as readChunk()
   */
  readline() {
    for (;;) {
      const nl = this.decoded.indexOf('\n', this.offset);
      if (nl >= 0) {
        const line = this.decoded.slice(this.offset, nl + 1);
        this.offset = nl + 1;
        return line;
      }
      if (!this.readChunk()) {
        const line = this.decoded.slice(this.offset);
        this.offset = this.decoded.length;
        return line;
      }
    }
  }

  /**
   * @param {number} [size] how many characters; all the rest when omitted or negative
   * @returns {string} the text read
   * @throws {Error} as readChunk(); reading all the rest of a truncated stream raises endError
   */
  read(size) {
    if (size === undefined || size === null || size < 0) {
      if (this.endError) throw this.endError;
      const rest = this.buf.subarray(this.bytePos);
      this.bytePos = this.buf.length;
      if (!this.eof) this.feed(rest, true);
      const text = this.decoded.slice(this.offset);
      this.offset = this.decoded.length;
      return text;
    }
    const available = () => Array.from(this.decoded.slice(this.offset)).length;
    while (available() < size && this.readChunk(Math.max(CHUNK_SIZE, size))) { /* keep reading */ }
    const text = Array.from(this.decoded.slice(this.offset)).slice(0, size).join('');
    this.offset += text.length;
    return text;
  }

  /** @returns {object} an opaque position for seek(), like TextIOWrapper.tell() */
  tell() {
    return { ...this, state: { ...this.state } };
  }

  /** @param {object} pos a position tell() returned */
  seek(pos) {
    Object.assign(this, pos, { state: { ...pos.state } });
  }
}

module.exports = { decode, decodeIgnoringErrors, lookup, TextReader, LookupError, UnicodeDecodeError };
