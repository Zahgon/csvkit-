'use strict';
// Ports of CPython 3.11's Unicode codecs' incremental decoding (Objects/unicodeobject.c, Lib/encodings/utf_8_sig.py,
// utf_16.py, utf_32.py, punycode.py, idna.py): UTF-8, UTF-16, UTF-32, UTF-7, ASCII, unicode_escape,
// raw_unicode_escape, punycode and idna. Decoders follow the contract described in lib/codecs.js.

const { UnicodeError, UnicodeDecodeError } = require('./codec-errors');
const { lookupName } = require('./pyunicode');
const { pyBytesRepr } = require('./pystr');

/**
 * UTF-8 (CPython's utf8 decoder, maximal-subpart errors); encoding names the codec in errors.
 * A Decoder (see lib/codecs.js) with the codec name its errors show.
 * @param {Buffer} input
 * @param {boolean} final
 * @param {string} [encoding] the codec name in error messages
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for an invalid or (when final) incomplete sequence
 */
function utf8Decode(input, final, encoding = 'utf-8') {
  const n = input.length;
  let i = 0;
  while (i < n) {
    const c = input[i];
    if (c < 0x80) {
      i++;
      continue;
    }
    let need;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      if (c === 0xe0) lo = 0xa0;
      if (c === 0xed) hi = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      if (c === 0xf0) lo = 0x90;
      if (c === 0xf4) hi = 0x8f;
    } else {
      throw new UnicodeDecodeError(encoding, input, i, i + 1, 'invalid start byte');
    }
    let k = 1;
    for (; k <= need && i + k < n; k++) {
      const cc = input[i + k];
      if (cc < (k === 1 ? lo : 0x80) || cc > (k === 1 ? hi : 0xbf)) {
        throw new UnicodeDecodeError(encoding, input, i, i + k, 'invalid continuation byte');
      }
    }
    if (k <= need) {
      if (!final) break;
      throw new UnicodeDecodeError(encoding, input, i, n, 'unexpected end of data');
    }
    i += need + 1;
  }
  return [input.toString('utf8', 0, i), i];
}

/**
 * utf_8_sig: UTF-8 after an optional BOM (encodings.utf_8_sig.IncrementalDecoder).
 * A Decoder (see lib/codecs.js).
 * @param {Buffer} input
 * @param {boolean} final
 * @param {object} state
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for bytes the codec rejects
 */
function utf8SigDecode(input, final, state) {
  const BOM = [0xef, 0xbb, 0xbf];
  if (state.first) {
    if (input.length < 3) {
      if (input.every((b, i) => b === BOM[i])) {
        if (!final) return ['', 0];
      }
      state.first = false;
    } else {
      state.first = false;
      if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
        const [text, consumed] = utf8Decode(input.subarray(3), final);
        return [text, consumed + 3];
      }
    }
  }
  return utf8Decode(input, final);
}

/**
 * ascii.
 * A Decoder (see lib/codecs.js).
 * @param {Buffer} input
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for bytes the codec rejects
 */
function asciiDecode(input) {
  const bad = input.findIndex((b) => b > 0x7f);
  if (bad >= 0) throw new UnicodeDecodeError('ascii', input, bad, bad + 1, 'ordinal not in range(128)');
  return [input.toString('latin1'), input.length];
}

/**
 * _PyUnicode_DecodeUTF16Stateful for one byte order (le: true for little-endian) from offset start.
 * @param {Buffer} input
 * @param {boolean} final
 * @param {boolean} le true for little-endian
 * @param {number} [start] the offset to start at (past a BOM)
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for a lone surrogate or (when final) a truncated unit
 */
function utf16Units(input, final, le, start = 0) {
  const encoding = le ? 'utf-16-le' : 'utf-16-be';
  const n = input.length;
  const unit = (p) => (le ? input[p] | (input[p + 1] << 8) : (input[p] << 8) | input[p + 1]);
  let out = '';
  let q = start;
  while (q < n) {
    if (n - q < 2) {
      if (!final) break;
      throw new UnicodeDecodeError(encoding, input, q, n, 'truncated data');
    }
    const ch = unit(q);
    if (ch < 0xd800 || ch > 0xdfff) {
      out += String.fromCharCode(ch);
      q += 2;
    } else if (ch >= 0xdc00) {
      throw new UnicodeDecodeError(encoding, input, q, q + 2, 'illegal encoding');
    } else if (n - q < 4) {
      if (!final) break;
      throw new UnicodeDecodeError(encoding, input, q, n, 'unexpected end of data');
    } else {
      const ch2 = unit(q + 2);
      if (ch2 < 0xdc00 || ch2 > 0xdfff) throw new UnicodeDecodeError(encoding, input, q, q + 2, 'illegal UTF-16 surrogate');
      out += String.fromCharCode(ch, ch2);
      q += 4;
    }
  }
  return [out, q];
}

/**
 * UTF-32 code units in one byte order (le: true for little-endian) from offset start.
 * @param {Buffer} input
 * @param {boolean} final
 * @param {boolean} le true for little-endian
 * @param {number} [start] the offset to start at (past a BOM)
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for a code point out of range or (when final) a truncated unit
 */
function utf32Units(input, final, le, start = 0) {
  const encoding = le ? 'utf-32-le' : 'utf-32-be';
  const n = input.length;
  let out = '';
  let q = start;
  while (q < n) {
    if (n - q < 4) {
      if (!final) break;
      throw new UnicodeDecodeError(encoding, input, q, n, 'truncated data');
    }
    const cp = le ? input.readUInt32LE(q) : input.readUInt32BE(q);
    if (cp > 0x10ffff) throw new UnicodeDecodeError(encoding, input, q, q + 4, 'code point not in range(0x110000)');
    if (cp >= 0xd800 && cp < 0xe000) {
      throw new UnicodeDecodeError(encoding, input, q, q + 4, 'code point in surrogate code point range(0xd800, 0xe000)');
    }
    out += String.fromCodePoint(cp);
    q += 4;
  }
  return [out, q];
}

/**
 * encodings.utf_16 / utf_32: the byte order comes from a BOM, which an incrementally decoded stream must start with
 * (bytes.decode falls back to little-endian).
 * @param {number} width the code unit size, 2 or 4
 * @param {function(Buffer, boolean, boolean, number=): Array} units utf16Units or utf32Units
 * @param {string} bomName "UTF-16" or "UTF-32", for the error message
 * @returns {import('./codecs').Decoder} a Decoder that raises UnicodeError "... stream does not start with BOM" for
 *   an incremental stream without one, and the units' UnicodeDecodeError
 */
function bomDecoder(width, units, bomName) {
  return (input, final, state) => {
    if (state.le !== undefined) return units(input, final, state.le);
    let le = true;
    let start = 0;
    if (width === 2 && input.length >= 2) {
      if (input[0] === 0xff && input[1] === 0xfe) [le, start] = [true, 2];
      else if (input[0] === 0xfe && input[1] === 0xff) [le, start] = [false, 2];
    } else if (width === 4 && input.length >= 4) {
      if (input.readUInt32LE(0) === 0xfeff) [le, start] = [true, 4];
      else if (input.readUInt32BE(0) === 0xfeff) [le, start] = [false, 4];
    }
    const [text, consumed] = units(input, final, le, start);
    if (start) state.le = le;
    else if (consumed >= width && !state.whole) throw new UnicodeError(`${bomName} stream does not start with BOM`);
    return [text, consumed];
  };
}

/**
 * utf_7 (RFC 2152) as CPython's PyUnicode_DecodeUTF7Stateful decodes it.
 * A Decoder (see lib/codecs.js).
 * @param {Buffer} input
 * @param {boolean} final
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for bytes the codec rejects
 */
function utf7Decode(input, final) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const err = (s, e, why) => new UnicodeDecodeError('utf7', input, s, e, why);
  let out = '';
  let i = 0;
  let shiftStart = -1;
  let bits = 0;
  let nbits = 0;
  let surrogate = 0;
  let pendingOut = '';
  while (i < input.length) {
    const c = input[i];
    if (shiftStart >= 0) {
      const v = B64.indexOf(String.fromCharCode(c));
      if (c < 0x80 && v >= 0) {
        bits = (bits << 6) | v;
        nbits += 6;
        if (nbits >= 16) {
          const unit = (bits >> (nbits - 16)) & 0xffff;
          nbits -= 16;
          bits &= (1 << nbits) - 1;
          if (surrogate) {
            if (unit >= 0xdc00 && unit <= 0xdfff) {
              pendingOut += String.fromCharCode(surrogate, unit);
              surrogate = 0;
              i++;
              continue;
            }
            pendingOut += String.fromCharCode(surrogate);
            surrogate = 0;
          }
          if (unit >= 0xd800 && unit <= 0xdbff) surrogate = unit;
          else pendingOut += String.fromCharCode(unit);
        }
        i++;
        continue;
      }
      // end of the shift sequence
      if (nbits >= 6) throw err(shiftStart, i + 1, 'partial character in shift sequence');
      if (nbits > 0 && bits) throw err(shiftStart, i + 1, 'non-zero padding bits in shift sequence');
      if (surrogate) {
        pendingOut += String.fromCharCode(surrogate);
        surrogate = 0;
      }
      out += pendingOut;
      pendingOut = '';
      shiftStart = -1;
      if (c === 0x2d) {
        i++;
        continue;
      }
    }
    if (c === 0x2b) {
      if (input[i + 1] === 0x2d) {
        out += '+';
        i += 2;
      } else if (i + 1 < input.length && B64.indexOf(String.fromCharCode(input[i + 1])) < 0) {
        throw err(i, i + 2, 'ill-formed sequence');
      } else {
        shiftStart = i;
        bits = 0;
        nbits = 0;
        i++;
      }
    } else if (c < 0x80) {
      out += String.fromCharCode(c);
      i++;
    } else {
      throw err(i, i + 1, 'unexpected special character');
    }
  }
  if (shiftStart >= 0) {
    if (!final) return [out, shiftStart];
    if (nbits >= 6 || bits || surrogate) throw err(shiftStart, input.length, 'unterminated shift sequence');
    out += pendingOut;
  }
  return [out, input.length];
}

// unicode_escape (_PyUnicode_DecodeUnicodeEscapeInternal): Python string-literal escapes over latin-1 text.
const SIMPLE_ESCAPES = { 0x5c: '\\', 0x27: "'", 0x22: '"', 0x62: '\b', 0x66: '\f', 0x74: '\t', 0x6e: '\n', 0x72: '\r',
  0x76: '\v', 0x61: '\x07' };
const HEX_ESCAPES = { 0x78: [2, 'truncated \\xXX escape'], 0x75: [4, 'truncated \\uXXXX escape'],
  0x55: [8, 'truncated \\UXXXXXXXX escape'] };
const hexValue = (c) => {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
};

/**
 * unicode_escape: Python string-literal escapes over latin-1 text.
 * A Decoder (see lib/codecs.js).
 * @param {Buffer} input
 * @param {boolean} final
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for bytes the codec rejects
 */
function unicodeEscapeDecode(input, final) {
  const n = input.length;
  let out = '';
  let s = 0;
  while (s < n) {
    if (input[s] !== 0x5c) {
      out += String.fromCharCode(input[s++]);
      continue;
    }
    const start = s;
    s++;
    // the escape at start: its text, or [message, incomplete] when it cannot be decoded
    let result;
    if (s >= n) {
      result = ['\\ at end of string', true];
    } else {
      const c = input[s++];
      if (c === 0x0a) {
        result = '';
      } else if (SIMPLE_ESCAPES[c] !== undefined) {
        result = SIMPLE_ESCAPES[c];
      } else if (c >= 0x30 && c <= 0x37) {
        let v = c - 0x30;
        for (let k = 0; k < 2 && s < n && input[s] >= 0x30 && input[s] <= 0x37; k++) v = v * 8 + input[s++] - 0x30;
        result = String.fromCharCode(v);
      } else if (HEX_ESCAPES[c]) {
        const [count, message] = HEX_ESCAPES[c];
        let v = 0;
        let k = 0;
        for (; k < count && s < n && hexValue(input[s]) >= 0; k++) v = v * 16 + hexValue(input[s++]);
        if (k < count) result = [message, s >= n];
        else result = v > 0x10ffff ? ['illegal Unicode character', false] : String.fromCodePoint(v);
      } else if (c === 0x4e) {
        result = ['malformed \\N character escape', s >= n];
        if (s < n && input[s] === 0x7b) {
          const close = input.indexOf(0x7d, s + 1);
          if (close < 0) {
            s = n;
            result = ['malformed \\N character escape', true];
          } else if (close > s + 1) {
            const cp = lookupName(input.toString('latin1', s + 1, close));
            s = close + 1;
            result = cp >= 0 ? String.fromCodePoint(cp) : ['unknown Unicode character name', false];
          } else {
            s = close;
          }
        }
      } else {
        result = `\\${String.fromCharCode(c)}`;
      }
    }
    if (typeof result === 'string') {
      out += result;
      continue;
    }
    if (result[1] && !final) return [out, start];
    throw new UnicodeDecodeError('unicodeescape', input, start, s, result[0]);
  }
  return [out, s];
}

/**
 * raw_unicode_escape: latin-1 text where only \uXXXX and \UXXXXXXXX after an odd run of backslashes are escapes.
 * A Decoder (see lib/codecs.js).
 * @param {Buffer} input
 * @param {boolean} final
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for bytes the codec rejects
 */
function rawUnicodeEscapeDecode(input, final) {
  const n = input.length;
  let out = '';
  let s = 0;
  while (s < n) {
    if (input[s] !== 0x5c) {
      out += String.fromCharCode(input[s++]);
      continue;
    }
    const run = s;
    while (s < n && input[s] === 0x5c) s++;
    const odd = (s - run) % 2 === 1;
    if (odd && s >= n && !final) return [out + '\\'.repeat(s - run - 1), s - 1];
    if (!odd || s >= n || (input[s] !== 0x75 && input[s] !== 0x55)) {
      out += '\\'.repeat(s - run);
      continue;
    }
    out += '\\'.repeat(s - run - 1);
    const start = s - 1;
    const count = input[s] === 0x75 ? 4 : 8;
    const message = count === 4 ? 'truncated \\uXXXX escape' : 'truncated \\UXXXXXXXX escape';
    s++;
    let v = 0;
    let k = 0;
    for (; k < count && s < n && hexValue(input[s]) >= 0; k++) v = v * 16 + hexValue(input[s++]);
    if (k < count) {
      if (s >= n && !final) return [out, start];
      throw new UnicodeDecodeError('rawunicodeescape', input, start, s, message);
    }
    if (v > 0x10ffff) throw new UnicodeDecodeError('rawunicodeescape', input, start, s, '\\Uxxxxxxxx out of range');
    out += String.fromCodePoint(v);
  }
  return [out, s];
}

// Lib/encodings/punycode.py decoding (BigInt where Python's integers grow without bound).
function punycodeAdapt(delta, first, numchars) {
  let d = first ? delta / 700n : delta / 2n;
  d += d / BigInt(numchars);
  let divisions = 0n;
  while (d > 455n) {
    d /= 35n;
    divisions += 36n;
  }
  return divisions + (36n * d) / (d + 38n);
}

function punycodeDecodeText(text) {
  const asciiText = (buf) => {
    const bad = buf.findIndex((b) => b > 0x7f);
    if (bad >= 0) throw new UnicodeDecodeError('ascii', buf, bad, bad + 1, 'ordinal not in range(128)');
    return buf.toString('latin1');
  };
  const pos = text.lastIndexOf(0x2d);
  let base = pos < 0 ? [] : Array.from(asciiText(text.subarray(0, pos)));
  const extended = asciiText(pos < 0 ? text : text.subarray(pos + 1)).toUpperCase();
  let char = 0x80n;
  let at = -1n;
  let bias = 72n;
  let extpos = 0;
  while (extpos < extended.length) {
    // decode_generalized_number
    let result = 0n;
    let w = 1n;
    let j = 0n;
    let newpos = extpos;
    for (;;) {
      if (newpos >= extended.length) throw new UnicodeError('incomplete punicode string');
      const c = extended.charCodeAt(newpos++);
      let digit;
      if (c >= 0x41 && c <= 0x5a) digit = BigInt(c - 0x41);
      else if (c >= 0x30 && c <= 0x39) digit = BigInt(c - 22);
      else throw new UnicodeError(`Invalid extended code point '${extended[newpos - 1]}'`);
      let t = 36n * (j + 1n) - bias;
      if (t < 1n) t = 1n;
      if (t > 26n) t = 26n;
      result += digit * w;
      if (digit < t) break;
      w *= 36n - t;
      j += 1n;
    }
    const size = BigInt(base.length + 1);
    at += result + 1n;
    char += at / size;
    if (char > 0x10ffffn) throw new UnicodeError(`Invalid character U+${char.toString(16)}`);
    at %= size;
    base = [...base.slice(0, Number(at)), String.fromCodePoint(Number(char)), ...base.slice(Number(at))];
    bias = punycodeAdapt(result, extpos === 0, base.length);
    extpos = newpos;
  }
  return base.join('');
}

/**
 * punycode's incremental decoder is not buffered: every chunk is decoded on its own.
 * A Decoder (see lib/codecs.js).
 * @param {Buffer} input
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for non-ASCII bytes
 * @throws {UnicodeError} for invalid punycode
 */
function punycodeDecode(input) {
  return [punycodeDecodeText(input), input.length];
}

// Lib/encodings/idna.py IncrementalDecoder: ASCII text split into dot-separated labels; "xn--" labels are punycode
// (their round-trip check is made for labels that decode to ASCII; nameprep is not reproduced).
function idnaLabel(label) {
  if (!label.startsWith('xn--')) return label;
  let result;
  try {
    result = punycodeDecodeText(Buffer.from(label.slice(4), 'latin1'));
  } catch (e) {
    // bytes.decode('punycode') re-raises the codec's error wrapped with the codec name
    throw new UnicodeError(`decoding with 'punycode' codec failed (UnicodeError: ${e.message})`);
  }
  if (/^[\x00-\x7f]*$/.test(result)) {
    if (!(result.length > 0 && result.length < 64)) throw new UnicodeError('label empty or too long');
    if (label.toLowerCase() !== result) {
      throw new UnicodeError(`('IDNA does not round-trip', ${pyBytesRepr(Buffer.from(label, 'latin1'))}, ${pyBytesRepr(Buffer.from(result, 'latin1'))})`);
    }
  }
  return result;
}

/**
 * idna (encodings.idna.IncrementalDecoder): dot-separated labels, the last one held back until final.
 * A Decoder (see lib/codecs.js).
 * @param {Buffer} input
 * @param {boolean} final
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for non-ASCII bytes
 * @throws {UnicodeError} for an empty, too long or invalid label
 */
function idnaDecode(input, final) {
  if (!input.length) return ['', 0];
  const bad = input.findIndex((b) => b > 0x7f);
  if (bad >= 0) throw new UnicodeDecodeError('ascii', input, bad, bad + 1, 'ordinal not in range(128)');
  const labels = input.toString('latin1').split('.');
  let trailingDot = '';
  if (!labels[labels.length - 1]) {
    trailingDot = '.';
    labels.pop();
  } else if (!final) {
    labels.pop();
    if (labels.length) trailingDot = '.';
  }
  let size = 0;
  const result = labels.map((label) => {
    const text = idnaLabel(label);
    if (size) size += 1;
    size += label.length;
    return text;
  });
  return [result.join('.') + trailingDot, size + trailingDot.length];
}

module.exports = {
  utf8Decode, utf8SigDecode, asciiDecode, utf16Units, utf32Units, bomDecoder, utf7Decode, unicodeEscapeDecode,
  rawUnicodeEscapeDecode, punycodeDecode, idnaDecode,
};
