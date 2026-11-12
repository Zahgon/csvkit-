'use strict';
// Ports of CPython 3.11's CJK codecs' decoding (Modules/cjkcodecs): the stateless multibyte codecs over tables read
// off CPython's own codecs (lib/cjk-tables.js), hz, and the iso2022 family. Decoders follow the contract described
// in lib/codecs.js.

const { CHARMAPS } = require('./codec-tables');
const { UnicodeDecodeError } = require('./codec-errors');

// The stateless CJK codecs, table-driven (lib/cjk-tables.js holds what CPython's own codecs decode each sequence to);
// errors as Modules/cjkcodecs/multibytecodec.c reports them.
const CJK_CODECS = new Set(['shift_jis', 'cp932', 'shift_jis_2004', 'shift_jisx0213', 'euc_jp', 'euc_jis_2004',
  'euc_jisx0213', 'gb2312', 'gbk', 'gb18030', 'big5', 'big5hkscs', 'cp950', 'euc_kr', 'cp949', 'johab']);
const ERR1 = 0xd800;
const ERR2 = 0xd801;
const PREFIX = 0xd802;
const EXTRA = 0xd803;

const cjkCache = new Map();
function cjkTable(codec) {
  if (!cjkCache.has(codec)) {
    const t = require('./cjk-tables').TABLES[codec];
    const raw = require('node:zlib').inflateSync(Buffer.from(t.rows, 'base64'));
    const units = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    const rows = new Map();
    t.leads.forEach((lead, i) => rows.set(lead, units.subarray(256 * i, 256 * i + 256)));
    t.triples.forEach((key, i) => {
      const at = 256 * (t.leads.length + i);
      rows.set(key + 0x10000, units.subarray(at, at + 256));
    });
    cjkCache.set(codec, { single: t.single, rows, extras: t.extras });
  }
  return cjkCache.get(codec);
}

// gb18030's four-byte sequences (Modules/cjkcodecs/_codecs_cn.c); the character, or null when illegal.
function gb18030Four(input, i) {
  const [c1, c2, c3, c4] = input.subarray(i, i + 4);
  if (c1 < 0x81 || c1 > 0xfe || c3 < 0x81 || c3 > 0xfe || c4 < 0x30 || c4 > 0x39) return null;
  const a = c1 - 0x81;
  const b = ((a * 10 + (c2 - 0x30)) * 1260) + (c3 - 0x81) * 10 + (c4 - 0x30);
  if (a < 4) {
    if (b >= 39420) return null;
    const ranges = require('./cjk-tables').GB18030_RANGES;
    let k = ranges.length - 1;
    while (ranges[k][0] > b) k--;
    return String.fromCodePoint(ranges[k][1] + b - ranges[k][0]);
  }
  if (a >= 15) {
    const cp = 0x10000 + ((a - 15) * 10 + (c2 - 0x30)) * 1260 + (c3 - 0x81) * 10 + (c4 - 0x30);
    if (cp <= 0x10ffff) return String.fromCodePoint(cp);
  }
  return null;
}

// euc_kr's KS X 1001:1998 Annex 3 make-up sequences: "\xa4\xd4" then three jamo bytes each after "\xa4".
function eucKrMakeup(input, i) {
  if (input[i + 2] !== 0xa4 || input[i + 4] !== 0xa4 || input[i + 6] !== 0xa4) return null;
  const { choseong, jongseong } = require('./cjk-tables').EUC_KR_MAKEUP;
  const jamo = (c, table) => (c >= 0xa1 && c <= 0xbe ? table[c - 0xa1] : -1);
  const cho = jamo(input[i + 3], choseong);
  const jung = input[i + 5] >= 0xbf && input[i + 5] <= 0xd3 ? input[i + 5] - 0xbf : -1;
  const jong = input[i + 7] === 0xd4 ? 0 : jamo(input[i + 7], jongseong);
  if (cho < 0 || jung < 0 || jong < 0) return null;
  return String.fromCharCode(0xac00 + cho * 588 + jung * 28 + jong);
}

// Sequences longer than three bytes, which the tables mark as a prefix after two.
const LONG_SEQUENCES = { gb18030: [4, gb18030Four], euc_kr: [8, eucKrMakeup] };

/**
 * The decoder of one of CJK_CODECS.
 * @param {string} codec the codec module name
 * @returns {import('./codecs').Decoder} a Decoder raising UnicodeDecodeError for an illegal or (when final)
 *   incomplete multibyte sequence
 */
function cjkDecoder(codec) {
  return (input, final) => {
    const { single, rows, extras } = cjkTable(codec);
    const n = input.length;
    const illegal = (i, len) => new UnicodeDecodeError(codec, input, i, i + len, 'illegal multibyte sequence');
    const incomplete = (i) => new UnicodeDecodeError(codec, input, i, n, 'incomplete multibyte sequence');
    let out = '';
    let i = 0;
    while (i < n) {
      const b = input[i];
      if (single[b] >= 0) {
        out += String.fromCharCode(single[b]);
        i++;
        continue;
      }
      if (single[b] === -2) throw illegal(i, 1);
      let need = 2;
      if (i + need > n) {
        if (!final) break;
        throw incomplete(i);
      }
      let unit = rows.get(b)[input[i + 1]];
      if (unit === PREFIX) {
        const long = LONG_SEQUENCES[codec];
        need = long ? long[0] : 3;
        if (i + need > n) {
          if (!final) break;
          throw incomplete(i);
        }
        if (long) {
          const ch = long[1](input, i);
          if (ch === null) throw illegal(i, 1);
          out += ch;
          i += need;
          continue;
        }
        unit = rows.get(256 * b + input[i + 1] + 0x10000)[input[i + 2]];
      }
      if (unit === ERR1) throw illegal(i, 1);
      if (unit === ERR2) throw illegal(i, 2);
      out += unit === EXTRA ? extras[Array.from(input.subarray(i, i + need)).join(',')] : String.fromCharCode(unit);
      i += need;
    }
    return [out, i];
  };
}

/**
 * hz: ASCII with "~{" ... "~}" GB2312 sections of 7-bit byte pairs (Modules/cjkcodecs/_codecs_cn.c).
 * A Decoder (see lib/codecs.js).
 * @param {Buffer} input
 * @param {boolean} final
 * @param {object} state
 * @returns {Array} [text, bytes consumed]
 * @throws {UnicodeDecodeError} for bytes the codec rejects
 */
function hzDecode(input, final, state) {
  const n = input.length;
  const illegal = (i) => new UnicodeDecodeError('hz', input, i, i + 1, 'illegal multibyte sequence');
  const incomplete = (i) => new UnicodeDecodeError('hz', input, i, n, 'incomplete multibyte sequence');
  const gb = cjkTable('gb2312').rows;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = input[i];
    if (c === 0x7e) {
      if (i + 1 >= n) {
        if (!final) break;
        throw incomplete(i);
      }
      const c2 = input[i + 1];
      if (c2 === 0x7e && !state.gb) out += '~';
      else if (c2 === 0x7b && !state.gb) state.gb = true;
      else if (c2 === 0x7d && state.gb) state.gb = false;
      else if (c2 !== 0x0a || state.gb) throw illegal(i); // "~\n" is a line continuation
      i += 2;
      continue;
    }
    if (c & 0x80) throw illegal(i);
    if (!state.gb) {
      out += String.fromCharCode(c);
      i++;
      continue;
    }
    if (i + 1 >= n) {
      if (!final) break;
      throw incomplete(i);
    }
    const c2 = input[i + 1];
    const row = gb.get(c | 0x80);
    const unit = row && c2 < 0x80 ? row[c2 | 0x80] : ERR1;
    if (unit >= 0xd800 && unit <= 0xdfff) throw illegal(i);
    out += String.fromCharCode(unit);
    i += 2;
  }
  return [out, i];
}

// The iso2022 codecs (Modules/cjkcodecs/_codecs_iso2022.c): escape sequences designate character sets to G0, G1
// and G2; the double-byte sets are read off the EUC tables of the same character sets.
const ISO2022 = {
  iso2022_jp: { charsets: ['$B', 'J', '$@'] },
  iso2022_jp_1: { charsets: ['$B', '$D', 'J', '$@'] },
  iso2022_jp_2: { charsets: ['$B', '$D', '$C', '$A', 'J', '$@', 'A', 'F'], g2: true },
  iso2022_jp_2004: { charsets: ['$Q', '$B', '$P'] },
  iso2022_jp_3: { charsets: ['$O', '$B', '$P'] },
  iso2022_jp_ext: { charsets: ['$B', '$D', 'J', 'I', '$@'] },
  iso2022_kr: { charsets: ['$C'], shift: true },
};
const ESC = 0x1b;
const isEscEnd = (c) => (c >= 0x41 && c <= 0x5a) || c === 0x40;

// A table unit as text, or null for the markers of an illegal or longer sequence.
function unitText(unit, extras, key) {
  if (unit === EXTRA) return extras[key];
  return unit >= 0xd800 && unit <= 0xdfff ? null : String.fromCharCode(unit);
}

// One character of a designated set from 7-bit bytes: the text, or null when unmappable.
function iso2022Char(charset, c1, c2) {
  if (charset === 'J') return String.fromCharCode(c1 === 0x5c ? 0xa5 : c1 === 0x7e ? 0x203e : c1);
  if (charset === 'I') return c1 >= 0x21 && c1 <= 0x5f ? String.fromCharCode(0xff40 + c1) : null;
  if (charset.length === 1 || c2 >= 0x80) return null;
  const [h1, h2] = [c1 | 0x80, c2 | 0x80];
  const pair = (codec) => {
    const { rows, extras } = cjkTable(codec);
    const row = rows.get(h1);
    return row ? unitText(row[h2], extras, `${h1},${h2}`) : null;
  };
  const plane2 = (codec) => {
    const { rows, extras } = cjkTable(codec);
    const row = rows.get(256 * 0x8f + h1 + 0x10000);
    return row ? unitText(row[h2], extras, `143,${h1},${h2}`) : null;
  };
  switch (charset) {
    case '$B': case '$@': return pair('euc_jp');
    case '$D': return plane2('euc_jp');
    case '$C': return c1 === 0x24 && c2 === 0x54 ? String.fromCharCode(0x3164) : pair('euc_kr');
    case '$A': return pair('gb2312');
    case '$O': return pair('euc_jisx0213');
    case '$Q': return pair('euc_jis_2004');
    default: return plane2('euc_jis_2004');
  }
}

// iso2022processesc: the [charset, slot, length] an escape sequence at i designates; null when input runs out.
function iso2022Escape(config, input, i, illegal) {
  const n = input.length;
  let esclen = 0;
  let k = 1;
  for (; k < 16; k++) {
    if (i + k >= n) return null;
    if (isEscEnd(input[i + k])) {
      esclen = k + 1;
      break;
    }
    if (!config.shift && i + k + 1 < n && input[i + k] === 0x26 && input[i + k + 1] === 0x40) k += 2;
  }
  if (!esclen) throw illegal(i, 1);
  const c2 = input[i + 1];
  const byte = (j) => String.fromCharCode(input[i + j]);
  const slots = { '(': 0, ')': 1 };
  let charset;
  let slot;
  if (esclen === 3 && c2 === 0x24) {
    [charset, slot] = [`$${byte(2)}`, 0];
  } else if (esclen === 3) {
    charset = byte(2);
    slot = config.g2 && c2 === 0x2e ? 2 : slots[byte(1)];
  } else if (esclen === 4 && c2 === 0x24) {
    [charset, slot] = [`$${byte(3)}`, slots[byte(2)]];
  } else if (esclen === 6 && !config.shift && input[i + 3] === ESC && input[i + 4] === 0x24 && input[i + 5] === 0x42) {
    [charset, slot] = ['$B', 0];
  }
  if (slot === undefined || (charset !== 'B' && !config.charsets.includes(charset))) throw illegal(i, esclen);
  return [charset, slot, esclen];
}

// ESC N: one character of the G2 set (ISO 8859-1 or 8859-7 high half), or null when unmappable.
function iso2022Single(g2, c) {
  if (c >= 0x80) return null;
  if (g2 === 'A') return String.fromCharCode(c + 0x80);
  if (g2 === 'F') {
    const ch = CHARMAPS.iso8859_7[c + 0x80];
    return ch === '\ufffe' ? null : ch;
  }
  return String.fromCharCode(c);
}

/**
 * The decoder of one of the ISO2022 codecs.
 * @param {string} codec the codec module name
 * @returns {import('./codecs').Decoder} a Decoder raising UnicodeDecodeError for an illegal or (when final)
 *   incomplete multibyte sequence
 */
function iso2022Decoder(codec) {
  const config = ISO2022[codec];
  return (input, final, state) => {
    if (!state.g) Object.assign(state, { g: ['B', 'B', 'B'], shifted: false, escThrough: false });
    const n = input.length;
    const illegal = (i, len) => new UnicodeDecodeError(codec, input, i, i + len, 'illegal multibyte sequence');
    // MBERR_TOOFEW: stop before i, or fail at the end of the input
    const tooFew = (i) => {
      if (final) throw new UnicodeDecodeError(codec, input, i, n, 'incomplete multibyte sequence');
    };
    let out = '';
    let i = 0;
    while (i < n) {
      const c = input[i];
      if (state.escThrough) {
        out += String.fromCharCode(c);
        i++;
        if (isEscEnd(c)) state.escThrough = false;
      } else if (c === ESC) {
        if (i + 2 > n) {
          tooFew(i);
          break;
        }
        const c2 = input[i + 1];
        if (c2 === 0x28 || c2 === 0x29 || c2 === 0x24 || c2 === 0x2e || c2 === 0x26) {
          const esc = iso2022Escape(config, input, i, illegal);
          if (esc === null) {
            tooFew(i);
            break;
          }
          state.g[esc[1]] = esc[0];
          i += esc[2];
        } else if (config.g2 && c2 === 0x4e) {
          if (i + 3 > n) {
            tooFew(i);
            break;
          }
          const ch = iso2022Single(state.g[2], input[i + 2]);
          if (ch === null) throw illegal(i, 3);
          out += ch;
          i += 3;
        } else {
          out += String.fromCharCode(ESC);
          state.escThrough = true;
          i++;
        }
      } else if (config.shift && (c === 0x0e || c === 0x0f)) {
        state.shifted = c === 0x0e;
        i++;
      } else if (c < 0x20) {
        if (c === 0x0a) state.shifted = false;
        out += String.fromCharCode(c);
        i++;
      } else if (c >= 0x80) {
        throw illegal(i, 1);
      } else {
        const charset = state.shifted ? state.g[1] : state.g[0];
        const width = charset === 'B' || charset.length === 1 ? 1 : 2;
        if (i + width > n) {
          tooFew(i);
          break;
        }
        const ch = charset === 'B' ? String.fromCharCode(c) : iso2022Char(charset, c, input[i + 1]);
        if (ch === null) throw illegal(i, width);
        out += ch;
        i += width;
      }
    }
    return [out, i];
  };
}

module.exports = { CJK_CODECS, ISO2022, cjkDecoder, hzDecode, iso2022Decoder };
