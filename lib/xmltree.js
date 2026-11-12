'use strict';
// A small namespace-aware XML reader with the element model of Python's xml.etree.ElementTree as expat fills
// it: tags in Clark notation ("{uri}local"), attribute dictionaries, element text, newline normalisation, and
// expat's ParseError messages with their line and column.

const { pyError } = require('./pyerrors');

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const NAME_START_CHARS = 'A-Za-z_:\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff\\u0370-\\u037d\\u037f-\\u1fff\\u200c\\u200d'
  + '\\u2070-\\u218f\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd\\u{10000}-\\u{effff}';
const NAME_START = new RegExp(`[${NAME_START_CHARS}]`, 'u');
const NAME_CHAR = new RegExp(`[-.0-9\\u00b7\\u0300-\\u036f\\u203f\\u2040${NAME_START_CHARS}]`, 'u');
const WS = ' \t\n\r';

/**
 * xml.etree.ElementTree.Element: tag, attributes, text, tail and children.
 */
class Element {
  /**
   * @param {string} tag the tag in Clark notation
   * @param {Object<string, string>} attrib the attributes
   */
  constructor(tag, attrib) {
    this.tag = tag;
    this.attrib = attrib;
    this.children = [];
    this.text = null;
  }

  /**
   * Attribute value or a default (Element.get).
   * @param {string} key attribute name in Clark notation
   * @param {*} [dflt] value when absent
   * @returns {*}
   */
  get(key, dflt = null) {
    return Object.prototype.hasOwnProperty.call(this.attrib, key) ? this.attrib[key] : dflt;
  }

  /**
   * First direct child with this tag (Element.find).
   * @param {string} tag
   * @returns {Element|null}
   */
  find(tag) {
    return this.children.find((c) => c.tag === tag) || null;
  }

  /**
   * Text of the first direct child with this tag ('' when it has none), or the default (Element.findtext).
   * @param {string} tag
   * @param {*} [dflt]
   * @returns {*}
   */
  findtext(tag, dflt = null) {
    const c = this.find(tag);
    if (!c) return dflt;
    return c.text === null ? '' : c.text;
  }

  /**
   * Direct children with this tag (Element.findall).
   * @param {string} tag
   * @returns {Element[]}
   */
  findall(tag) {
    return this.children.filter((c) => c.tag === tag);
  }

  /**
   * Elements of the subtree in end-event order, as ElementTree.iterparse reports them.
   * @returns {Generator<Element>}
   */
  *iterEnd() {
    for (const c of this.children) yield* c.iterEnd();
    yield this;
  }
}

const isXmlChar = (cp) => cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff)
  || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

/** The XML parser behind parse(): a recursive descent over the document text with namespace resolution. */
class Parser {
  /** @param {string} s the document text, line endings normalised */
  constructor(s) {
    this.s = s;
    this.i = 0;
  }

  /**
   * ParseError with expat's message and its 1-based line, 0-based column (in characters).
   * @param {string} message
   * @param {number} [at] the offset of the error
   * @returns {Error} the error, for the caller to throw
   */
  error(message, at = this.i) {
    const before = this.s.slice(0, at);
    const nl = before.lastIndexOf('\n');
    const line = (before.match(/\n/g) || []).length + 1;
    const column = [...before.slice(nl + 1)].length;
    return pyError('xml.etree.ElementTree.ParseError', `${message}: line ${line}, column ${column}`);
  }

  /**
   * @param {string} t
   * @returns {boolean} whether the text at the current offset starts with t
   */
  startsWith(t) {
    return this.s.startsWith(t, this.i);
  }

  /**
   * Skips XML whitespace.
   * @returns {void}
   */
  skipWs() {
    while (this.i < this.s.length && WS.includes(this.s[this.i])) this.i++;
  }

  /**
   * Reads an XML name at the current offset.
   * @returns {string}
   * @throws {Error} pyName xml.etree.ElementTree.ParseError "not well-formed (invalid token)" when none starts here
   */
  name() {
    const start = this.i;
    const first = this.s.codePointAt(this.i);
    if (first === undefined || !NAME_START.test(String.fromCodePoint(first))) {
      throw this.error('not well-formed (invalid token)');
    }
    this.i += first > 0xffff ? 2 : 1;
    for (;;) {
      const cp = this.s.codePointAt(this.i);
      if (cp === undefined || !NAME_CHAR.test(String.fromCodePoint(cp))) break;
      this.i += cp > 0xffff ? 2 : 1;
    }
    return this.s.slice(start, this.i);
  }

  /**
   * Skips a comment, processing instruction or declaration (without CDATA).
   * @returns {boolean} false when none starts here
   * @throws {Error} pyName xml.etree.ElementTree.ParseError "unclosed token"
   */
  misc() {
    const start = this.i;
    const close = (end) => {
      const j = this.s.indexOf(end, this.i);
      if (j < 0) {
        this.i = this.s.length;
        throw this.error('unclosed token', start);
      }
      this.i = j + end.length;
    };
    if (this.startsWith('<!--')) close('-->');
    else if (this.startsWith('<?')) close('?>');
    else if (this.startsWith('<!DOCTYPE')) {
      let depth = 0;
      for (; this.i < this.s.length; this.i++) {
        const c = this.s[this.i];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (this.i >= this.s.length) throw this.error('unclosed token', start);
      this.i++;
    } else return false;
    return true;
  }

  /**
   * A character or entity reference at the current offset.
   * @param {number} errAt the offset errors are reported at
   * @returns {string} the character it stands for
   * @throws {Error} pyName xml.etree.ElementTree.ParseError for a malformed, invalid or undefined reference
   */
  reference(errAt) {
    const m = /^&(#x[0-9a-fA-F]+|#[0-9]+|[^\s&;<>"']+);/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) throw this.error('not well-formed (invalid token)', errAt);
    const ref = m[1];
    this.i += m[0].length;
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!isXmlChar(cp)) throw this.error('reference to invalid character number', errAt);
      return String.fromCodePoint(cp);
    }
    if (!(ref in ENTITIES)) throw this.error('undefined entity', errAt);
    return ENTITIES[ref];
  }

  /**
   * A qualified name in Clark notation, by the namespace declarations in scope (an unprefixed attribute has no
   * namespace).
   * @param {string} qname
   * @param {Array<Object<string, string>>} scopes the prefix to URI maps, innermost last
   * @param {boolean} isAttr
   * @param {number} at the offset to report an error at
   * @returns {string}
   * @throws {Error} pyName xml.etree.ElementTree.ParseError "unbound prefix"
   */
  resolve(qname, scopes, isAttr, at) {
    const k = qname.indexOf(':');
    const prefix = k < 0 ? '' : qname.slice(0, k);
    const local = k < 0 ? qname : qname.slice(k + 1);
    if (prefix === '' && isAttr) return local;
    if (prefix === 'xml') return `{${XML_NS}}${local}`;
    for (let j = scopes.length - 1; j >= 0; j--) {
      if (Object.prototype.hasOwnProperty.call(scopes[j], prefix)) {
        const uri = scopes[j][prefix];
        return uri ? `{${uri}}${local}` : local;
      }
    }
    if (prefix === '') return local;
    throw this.error('unbound prefix', at);
  }

  /**
   * A start tag at the current offset.
   * @param {Array<Object<string, string>>} scopes the namespace scopes of the enclosing elements
   * @returns {Array} [element, whether it is self-closing, its own namespace scope]
   * @throws {Error} pyName xml.etree.ElementTree.ParseError for a malformed tag, a duplicate attribute or an
   *   unbound prefix
   */
  startTag(scopes) {
    const tagStart = this.i;
    this.i++;
    const qname = this.name();
    const raw = [];
    const scope = {};
    const seen = new Set();
    for (;;) {
      const hadWs = this.i < this.s.length && WS.includes(this.s[this.i]);
      this.skipWs();
      if (this.i >= this.s.length) throw this.error('unclosed token', tagStart);
      if (this.startsWith('/>') || this.s[this.i] === '>') break;
      if (!hadWs) throw this.error('not well-formed (invalid token)');
      const attrAt = this.i;
      const an = this.name();
      this.skipWs();
      if (this.s[this.i] !== '=') throw this.error('not well-formed (invalid token)');
      this.i++;
      this.skipWs();
      const q = this.s[this.i];
      if (q !== '"' && q !== "'") throw this.error('not well-formed (invalid token)');
      this.i++;
      let value = '';
      for (;;) {
        if (this.i >= this.s.length) throw this.error('unclosed token', tagStart);
        const c = this.s[this.i];
        if (c === q) break;
        if (c === '<') throw this.error('not well-formed (invalid token)');
        if (c === '&') value += this.reference(tagStart);
        else {
          const cp = this.s.codePointAt(this.i);
          if (!isXmlChar(cp)) throw this.error('not well-formed (invalid token)');
          value += c === '\t' || c === '\n' ? ' ' : c;
          this.i++;
        }
      }
      this.i++;
      if (seen.has(an)) throw this.error('duplicate attribute', attrAt);
      seen.add(an);
      if (an === 'xmlns') scope[''] = value;
      else if (an.startsWith('xmlns:')) {
        if (!value) throw this.error('must not undeclare prefix', tagStart);
        scope[an.slice(6)] = value;
      } else raw.push([an, value]);
    }
    const selfClosing = this.s[this.i] === '/';
    this.i += selfClosing ? 2 : 1;
    const all = [...scopes, scope];
    const attrib = {};
    for (const [k, v] of raw) attrib[this.resolve(k, all, true, tagStart)] = v;
    return [new Element(this.resolve(qname, all, false, tagStart), attrib), selfClosing, scope, qname];
  }

  /**
   * The document's root element.
   * @returns {Element}
   * @throws {Error} pyName xml.etree.ElementTree.ParseError for a document that is not well-formed
   */
  parse() {
    const s = this.s;
    for (;;) {
      this.skipWs();
      if (this.i >= s.length) throw this.error('no element found');
      if (this.misc()) continue;
      if (s[this.i] !== '<') throw this.error('not well-formed (invalid token)', this.i + 1);
      break;
    }
    const scopes = [];
    const stack = [];
    let root = null;
    let text = '';
    const flush = () => {
      if (!text || !stack.length) return;
      const cur = stack[stack.length - 1].el;
      if (cur.children.length) {
        const last = cur.children[cur.children.length - 1];
        last.tail = (last.tail || '') + text;
      } else {
        cur.text = (cur.text || '') + text;
      }
      text = '';
    };
    for (;;) {
      if (this.i >= s.length) throw this.error('no element found');
      const c = s[this.i];
      if (c === '<') {
        if (s[this.i + 1] === '/') {
          flush();
          this.i += 2;
          const at = this.i;
          const qname = this.name();
          this.skipWs();
          if (s[this.i] !== '>') throw this.error(this.i >= s.length ? 'unclosed token' : 'not well-formed (invalid token)');
          const top = stack.pop();
          if (qname !== top.qname) throw this.error('mismatched tag', at);
          scopes.pop();
          this.i++;
          if (!stack.length) break;
        } else if (this.startsWith('<![CDATA[')) {
          const end = s.indexOf(']]>', this.i);
          if (end < 0) throw this.error('unclosed CDATA section');
          text += s.slice(this.i + 9, end);
          this.i = end + 3;
        } else if (this.misc()) {
          flush();
        } else {
          flush();
          const [el, selfClosing, scope, qname] = this.startTag(scopes);
          if (stack.length) stack[stack.length - 1].el.children.push(el);
          else root = el;
          if (!selfClosing) {
            stack.push({ el, qname });
            scopes.push(scope);
          } else if (!stack.length) break;
        }
      } else if (c === '&') {
        text += this.reference(this.i);
      } else if (c === ']' && this.startsWith(']]>')) {
        throw this.error('not well-formed (invalid token)', this.i + 2);
      } else {
        const cp = s.codePointAt(this.i);
        if (!isXmlChar(cp)) throw this.error('not well-formed (invalid token)');
        const n = cp > 0xffff ? 2 : 1;
        text += s.slice(this.i, this.i + n);
        this.i += n;
      }
    }
    for (;;) {
      this.skipWs();
      if (this.i >= s.length) break;
      if (this.misc()) continue;
      throw this.error('junk after document element');
    }
    return root;
  }
}

/**
 * Parse an XML document (bytes or text) into its root Element.
 * @param {Buffer|string} src document
 * @returns {Element}
 */
function parse(src) {
  let s = typeof src === 'string' ? src : src.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return new Parser(s.replace(/\r\n?/g, '\n')).parse();
}

module.exports = { parse };
