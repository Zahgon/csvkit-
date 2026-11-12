'use strict';
// Port of babel.core (Babel 2.18, BSD-3-Clause): Locale.parse() with its likely-subtag resolution and errors,
// default_locale(), and the number symbols agate reads (Locale.number_symbols['latn'] group and decimal).
// The CLDR data comes from lib/babel-data.js, generated from Babel's own locale data.

const DATA = require('./babel-data');
const { pyError } = require('./pyerrors');
const { pyRepr } = require('./pystr');
const { isDigit } = require('./pyunicode');

// Locale identifiers with data files (localedata.locale_identifiers() plus 'root'), mapped to [group, decimal].
const SYMBOLS = new Map();
for (const [group, decimal, ids] of DATA.symbols) {
  for (const id of ids.split(' ')) SYMBOLS.set(id, [group, decimal]);
}
const BY_LOWER = new Map([...SYMBOLS.keys()].filter((id) => id !== 'root').map((id) => [id.toLowerCase(), id]));

const LOCALE_ALIASES = {
  ar: 'ar_SY', bg: 'bg_BG', bs: 'bs_BA', ca: 'ca_ES', cs: 'cs_CZ', da: 'da_DK', de: 'de_DE', el: 'el_GR', en: 'en_US',
  es: 'es_ES', et: 'et_EE', fa: 'fa_IR', fi: 'fi_FI', fr: 'fr_FR', gl: 'gl_ES', he: 'he_IL', hu: 'hu_HU', id: 'id_ID',
  is: 'is_IS', it: 'it_IT', ja: 'ja_JP', km: 'km_KH', ko: 'ko_KR', lt: 'lt_LT', lv: 'lv_LV', mk: 'mk_MK', nl: 'nl_NL',
  nn: 'nn_NO', no: 'nb_NO', pl: 'pl_PL', pt: 'pt_PT', ro: 'ro_RO', ru: 'ru_RU', sk: 'sk_SK', sl: 'sl_SI', sv: 'sv_SE',
  th: 'th_TH', tr: 'tr_TR', uk: 'uk_UA',
};

/**
 * babel.core.UnknownLocaleError: no CLDR data for the identifier.
 */
class UnknownLocaleError extends Error {
  /** @param {string} identifier the locale identifier the message names */
  constructor(identifier) {
    super(`unknown locale ${pyRepr(identifier)}`);
    this.pyName = 'babel.core.UnknownLocaleError';
    this.identifier = identifier;
  }
}

const get = (table, key, dflt) => (Object.hasOwn(table, key) ? table[key] : dflt);
const isAlpha = (s) => /^\p{L}+$/u.test(s);
const title = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * babel.core.parse_locale(): split an identifier into [language, territory, script, variant(, modifier)].
 * @param {string} identifier
 * @param {string} [sep]
 * @returns {Array<string|null>}
 * @throws {Error} pyName ValueError for an empty or malformed identifier
 */
function parseLocale(identifier, sep = '_') {
  if (!identifier) throw pyError('ValueError', 'empty locale identifier');
  const at = identifier.indexOf('@');
  const modifier = at < 0 ? '' : identifier.slice(at + 1);
  let id = at < 0 ? identifier : identifier.slice(0, at);
  if (id.includes('.')) id = id.split('.')[0];
  const parts = id.split(sep);
  const lang = parts.shift().toLowerCase();
  if (!isAlpha(lang)) throw pyError('ValueError', `expected only letters, got ${pyRepr(lang)}`);
  let script = null;
  let territory = null;
  let variant = null;
  if (parts.length && [...parts[0]].length === 4 && isAlpha(parts[0])) script = title(parts.shift());
  if (parts.length) {
    const n = [...parts[0]].length;
    if (n === 2 && isAlpha(parts[0])) territory = parts.shift().toUpperCase();
    else if (n === 3 && isDigit(parts[0])) territory = parts.shift();
  }
  if (parts.length) {
    const p = [...parts[0]];
    if ((p.length === 4 && isDigit(p[0])) || (p.length >= 5 && isAlpha(p[0]))) variant = parts.pop().toUpperCase();
  }
  if (parts.length) throw pyError('ValueError', `${pyRepr(id)} is not a valid locale identifier`);
  return modifier ? [lang, territory, script, variant, modifier] : [lang, territory, script, variant];
}

/**
 * babel.core.get_locale_identifier()
 * @param {Array<string|null>} parts
 * @param {string} [sep]
 * @returns {string}
 */
function getLocaleIdentifier(parts, sep = '_') {
  const [lang, territory, script, variant, modifier] = parts;
  const ret = [lang, script, territory, variant].filter(Boolean).join(sep);
  return modifier ? `${ret}@${modifier}` : ret;
}

// localedata.exists(): a data file with this exact name, or one matching case-insensitively.
function dataIdentifier(name) {
  if (!name) return null;
  if (SYMBOLS.has(name)) return name;
  return BY_LOWER.get(name.toLowerCase()) || null;
}

/** A loaded babel.core.Locale. */
class Locale {
  /**
   * Locale(language, territory, script, variant, modifier).
   * @param {Array<string|null>} parts
   * @throws {UnknownLocaleError} when there is no locale data for the identifier
   */
  constructor(parts) {
    [this.language, this.territory = null, this.script = null, this.variant = null, this.modifier = null] = parts;
    const identifier = getLocaleIdentifier(parts);
    this.dataId = dataIdentifier(identifier) || dataIdentifier(identifier.split('@')[0]);
    if (!this.dataId) throw new UnknownLocaleError(identifier);
    this.identifier = identifier;
  }

  /**
   * Locale.parse(identifier) with Babel's likely-subtag fallback.
   * @param {string} identifier
   * @returns {Locale}
   * @throws {Error} pyName ValueError for an empty or malformed identifier
   * @throws {UnknownLocaleError} when neither the identifier nor its likely subtags have locale data
   */
  static parse(identifier) {
    if (!identifier) {
      throw pyError('ValueError', `Empty locale identifier value: ${pyRepr(identifier)}\n\nIf you didn't explicitly `
        + 'pass an empty value to a Babel function, this could be caused by there being no suitable locale '
        + 'environment variables for the API you tried to use.');
    }
    let parts = parseLocale(identifier);
    const inputId = getLocaleIdentifier(parts);
    const tryLoad = (p) => {
      try {
        return new Locale(p);
      } catch (e) {
        if (e instanceof UnknownLocaleError) return null;
        throw e;
      }
    };
    const tryLoadReducing = (p) => tryLoad(p) || tryLoad(p.slice(0, 2));
    const found = tryLoad(parts);
    if (found) return found;
    let [language, territory, script, variant, modifier = null] = parts;
    language = get(DATA.language_aliases, language, language);
    territory = get(DATA.territory_aliases, territory || '', territory);
    script = get(DATA.script_aliases, script || '', script);
    variant = get(DATA.variant_aliases, variant || '', variant);
    if (territory === 'ZZ') territory = null;
    if (script === 'Zzzz') script = null;
    parts = [language, territory, script, variant, modifier];
    let likely = get(DATA.likely_subtags, getLocaleIdentifier(parts));
    if (likely !== undefined) {
      const loc = tryLoadReducing(parseLocale(likely));
      if (loc) return loc;
    }
    likely = get(DATA.likely_subtags, language);
    if (likely !== undefined) {
      const [language2, , script2, variant2, modifier2 = null] = parseLocale(likely);
      const loc = tryLoadReducing([language2, territory, script2, variant2, modifier2]);
      if (loc) return loc;
    }
    throw new UnknownLocaleError(inputId);
  }

  /**
   * The latn number symbols.
   * @returns {string[]} [group, decimal]
   */
  numberSymbols() { return SYMBOLS.get(this.dataId); }
}

/**
 * The environment as CPython sees it after start-up. With LC_ALL unset, PEP 538 coerces a C or unavailable LC_CTYPE
 * locale by setting LC_CTYPE=C.UTF-8; the original's image provides only the C, C.UTF-8 and POSIX locales.
 * @returns {Object<string, string>}
 */
function pythonEnvironment() {
  const env = process.env;
  if (env.LC_ALL) return env;
  const ctype = env.LC_CTYPE || env.LANG || 'C';
  return ['C.UTF-8', 'C.utf8'].includes(ctype) ? env : { ...env, LC_CTYPE: 'C.UTF-8' };
}

/**
 * babel.core.default_locale(category): the locale named by the environment, or null.
 * @param {string} [category] e.g. 'LC_NUMERIC'
 * @returns {string|null}
 */
function defaultLocale(category) {
  const names = ['LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LANG'];
  if (category) names.unshift(category);
  const env = pythonEnvironment();
  for (const name of names) {
    let locale = env[name];
    if (!locale) continue;
    if (name === 'LANGUAGE' && locale.includes(':')) locale = locale.split(':')[0];
    if (['C', 'POSIX'].includes(locale.split('.')[0])) locale = 'en_US_POSIX';
    else locale = get(LOCALE_ALIASES, locale, locale);
    try {
      return getLocaleIdentifier(parseLocale(locale));
    } catch (e) {
      if (e.pyName !== 'ValueError') throw e;
    }
  }
  return null;
}

module.exports = { Locale, UnknownLocaleError, defaultLocale };
