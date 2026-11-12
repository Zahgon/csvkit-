'use strict';
// A port of the parts of CPython 3.11's argparse that csvkit uses: parsing, usage, help and errors.

const { pyInt } = require('./pyunicode');
const { pyRepr } = require('./pystr');

/**
 * argparse.ArgumentError: a bad command line, reported as "prog: error: message" with exit status 2.
 */
class ArgumentError extends Error {}

const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

/**
 * Stands for SystemExit: unwinds to the launcher, which exits with `exitCode`.
 */
class ExitError extends Error {
  /** @param {number} code the exit status, as SystemExit's code */
  constructor(code) {
    super(`exit ${code}`);
    this.exitCode = code;
  }
}

// textwrap
const wordsepRe = /(\s+|(?<=[\w!"'&.,?])-{2,}(?=\w)|\S+?(?:-(?:(?<=[^\d\W]{2}-)|(?<=[^\d\W]-[^\d\W]-))(?=[^\d\W]-?[^\d\W])|(?=\s|$)|(?<=[\w!"'&.,?])(?=-{2,}\w)))/gu;

/**
 * textwrap.wrap(text, width) with argparse's HelpFormatter settings: tabs expanded, whitespace runs folded,
 * words broken after hyphens, long words split.
 * @param {string} text
 * @param {number} width
 * @param {string} [initialIndent]
 * @param {string} [subsequentIndent]
 * @returns {string[]} the lines
 */
function textwrap(text, width, initialIndent = '', subsequentIndent = '') {
  text = text.replace(/\t/g, '        ');
  text = text.replace(/[\t\n\x0b\x0c\r ]/g, ' ');
  const chunks = text.split(wordsepRe).filter((c) => c);
  chunks.reverse();
  const lines = [];
  while (chunks.length) {
    const curLine = [];
    let curLen = 0;
    const indent = lines.length ? subsequentIndent : initialIndent;
    const w = width - indent.length;
    if (chunks[chunks.length - 1].trim() === '' && lines.length) chunks.pop();
    while (chunks.length) {
      const l = chunks[chunks.length - 1].length;
      if (curLen + l <= w) {
        curLine.push(chunks.pop());
        curLen += l;
      } else break;
    }
    if (chunks.length && chunks[chunks.length - 1].length > w) {
      const spaceLeft = w < 1 ? 1 : w - curLen;
      const chunk = chunks[chunks.length - 1];
      let end = spaceLeft;
      if (chunk.length > spaceLeft) {
        const hyphen = chunk.lastIndexOf('-', spaceLeft - 1);
        if (hyphen > 0 && /[^-]/.test(chunk.slice(0, hyphen))) end = hyphen + 1;
      }
      curLine.push(chunk.slice(0, end));
      chunks[chunks.length - 1] = chunk.slice(end);
      curLen += end;
    }
    if (curLine.length && curLine[curLine.length - 1].trim() === '') {
      curLen -= curLine[curLine.length - 1].length;
      curLine.pop();
    }
    if (curLine.length) lines.push(indent + curLine.join(''));
  }
  return lines;
}

// shutil.get_terminal_size().columns when stdout is not a terminal: COLUMNS if it is a positive int, else 80.
function termWidth() {
  const c = process.env.COLUMNS === undefined ? null : pyInt(process.env.COLUMNS);
  return c !== null && c > 0 ? c : 80;
}

/**
 * argparse.ArgumentParser for the actions csvkit uses (store, store_true, store_false, append, help and
 * version): parse_args, the usage and help text, and error reporting.
 */
class ArgumentParser {
  /**
   * Creates the parser with argparse's automatic -h/--help action.
   * @param {{prog: string, description?: string, epilog?: string}} options the program name and the help text
   *   printed before and after the argument list
   */
  constructor({ prog, description = '', epilog = '' }) {
    this.prog = prog;
    this.description = description;
    this.epilog = epilog;
    this.actions = [];
    this.addArgument(['-h', '--help'], { action: 'help', help: 'show this help message and exit' });
  }

  /**
   * ArgumentParser.add_argument: registers an action. `dest` defaults to the first long option without dashes, with
   * "-" turned into "_" (the first flag for a positional).
   * @param {string[]} flags option strings such as ['-d', '--delimiter'], or one positional name
   * @param {object} [opts] add_argument's keywords: dest, action, nargs, default, const, type
   *   ('int' or a function (value, action, parser) => converted), choices, required, metavar, help, version
   * @returns {object} the action record the parser keeps
   */
  addArgument(flags, opts = {}) {
    const a = { ...opts };
    a.optionStrings = flags.filter((f) => f.startsWith('-'));
    a.positional = a.optionStrings.length === 0;
    if (!a.dest) {
      if (a.positional) a.dest = flags[0];
      else {
        const long = a.optionStrings.find((f) => f.startsWith('--')) || a.optionStrings[0];
        a.dest = long.replace(/^-+/, '').replace(/-/g, '_');
      }
    }
    a.action = a.action || 'store';
    if (a.action === 'store_true') { a.nargs = 0; if (a.default === undefined) a.default = false; }
    if (a.action === 'store_false') { a.nargs = 0; if (a.default === undefined) a.default = true; }
    if (a.action === 'help' || a.action === 'version') a.nargs = 0;
    if (a.default === undefined) a.default = null;
    this.actions.push(a);
    return a;
  }

  /**
   * The name an action's value shows under in usage and help.
   * @param {object} a the action
   * @returns {string} its metavar, "{a,b}" for choices, else the dest (upper-cased for an optional)
   */
  metavar(a) {
    if (a.metavar) return a.metavar;
    if (a.choices) return `{${a.choices.join(',')}}`;
    return a.positional ? a.dest : a.dest.toUpperCase();
  }

  /**
   * HelpFormatter._format_args: the value part of an action's usage, by its nargs.
   * @param {object} a the action
   * @returns {string}
   */
  formatArgs(a) {
    const m = this.metavar(a);
    if (a.nargs === '?') return `[${m}]`;
    if (a.nargs === '*') return `[${m} ...]`;
    if (a.nargs === '+') return `${m} [${m} ...]`;
    if (typeof a.nargs === 'number' && a.nargs > 0) return Array(a.nargs).fill(m).join(' ');
    return m;
  }

  /**
   * HelpFormatter._format_action_invocation: the left column of an action's help line.
   * @param {object} a the action
   * @returns {string}
   */
  invocation(a) {
    if (a.positional) return this.metavar(a);
    if (a.nargs === 0) return a.optionStrings.join(', ');
    const args = this.formatArgs(a);
    return a.optionStrings.map((o) => `${o} ${args}`).join(', ');
  }

  /**
   * The usage parts of the optionals and of the positionals, in the order they were added.
   * @returns {string[][]} [optional parts, positional parts]
   */
  usageParts() {
    const opt = [];
    const pos = [];
    for (const a of this.actions) {
      if (a.positional) {
        pos.push(this.formatArgs(a));
      } else {
        let part = a.optionStrings[0];
        if (a.nargs !== 0) part += ' ' + this.formatArgs(a);
        if (!a.required) part = `[${part}]`;
        opt.push(part);
      }
    }
    return [opt, pos];
  }

  /**
   * format_usage: "usage: prog ..." wrapped to the terminal width the way HelpFormatter._format_usage wraps it.
   * @returns {string} the usage text, ending in a newline
   */
  formatUsage() {
    const width = termWidth() - 2;
    const prefix = 'usage: ';
    const [opt, pos] = this.usageParts();
    let usage = [this.prog, ...opt, ...pos].join(' ');
    const textWidth = width;
    if (prefix.length + usage.length > textWidth) {
      const getLines = (parts, indent, pfx) => {
        const lines = [];
        let line = [];
        let lineLen = pfx !== undefined ? pfx.length - 1 : indent.length - 1;
        for (const part of parts) {
          if (lineLen + 1 + part.length > textWidth && line.length) {
            lines.push(indent + line.join(' '));
            line = [];
            lineLen = indent.length - 1;
          }
          line.push(part);
          lineLen += part.length + 1;
        }
        if (line.length) lines.push(indent + line.join(' '));
        if (pfx !== undefined) lines[0] = lines[0].slice(indent.length);
        return lines;
      };
      let lines;
      if (prefix.length + this.prog.length <= 0.75 * textWidth) {
        const indent = ' '.repeat(prefix.length + this.prog.length + 1);
        if (opt.length) {
          lines = getLines([this.prog, ...opt], indent, prefix);
          lines.push(...getLines(pos, indent));
        } else if (pos.length) {
          lines = getLines([this.prog, ...pos], indent, prefix);
        } else lines = [this.prog];
      } else {
        const indent = ' '.repeat(prefix.length);
        const parts = [...opt, ...pos];
        lines = getLines(parts, indent);
        if (lines.length > 1) {
          lines = [];
          lines.push(...getLines(opt, indent));
          lines.push(...getLines(pos, indent));
        }
        lines = [this.prog, ...lines];
      }
      usage = lines.join('\n');
    }
    return `${prefix}${usage}\n`;
  }

  /**
   * HelpFormatter._expand_help: an action's help with %(default)s, %(prog)s and %% filled in.
   * @param {object} a the action
   * @returns {string}
   */
  expandHelp(a) {
    let h = a.help || '';
    h = h.replace(/%\((\w+)\)s/g, (m, k) => {
      if (k === 'default') return String(a.default === null ? 'None' : a.default);
      if (k === 'prog') return this.prog;
      return m;
    });
    return h.replace(/%%/g, '%');
  }

  /**
   * format_help: usage, description, the positional and optional argument sections and the epilog.
   * @returns {string}
   */
  formatHelp() {
    const width = termWidth() - 2;
    const maxHelpPosition = Math.min(24, Math.max(width - 20, 4));
    let out = this.formatUsage() + '\n';
    if (this.description) {
      const text = this.description.replace(/\s+/g, ' ').trim();
      out += textwrap(text, Math.max(width, 11)).join('\n') + '\n\n';
    }
    let actionMax = 0;
    for (const a of this.actions) actionMax = Math.max(actionMax, this.invocation(a).length + 2);
    const helpPosition = Math.min(actionMax + 2, maxHelpPosition);
    const helpWidth = Math.max(width - helpPosition, 11);
    const actionWidth = helpPosition - 2 - 2;
    const section = (title, acts) => {
      if (!acts.length) return '';
      let s = `${title}:\n`;
      for (const a of acts) {
        const header = this.invocation(a);
        let lines;
        if (a.help) {
          const h = this.expandHelp(a).replace(/\s+/g, ' ').trim();
          lines = textwrap(h, helpWidth);
        } else lines = [];
        if (!lines.length) {
          s += `  ${header}\n`;
        } else if (header.length <= actionWidth) {
          s += `  ${header.padEnd(actionWidth)}  ${lines[0]}\n`;
          for (const l of lines.slice(1)) s += `${' '.repeat(helpPosition)}${l}\n`;
        } else {
          s += `  ${header}\n`;
          for (const l of lines) s += `${' '.repeat(helpPosition)}${l}\n`;
        }
      }
      return s + '\n';
    };
    out += section('positional arguments', this.actions.filter((a) => a.positional));
    out += section('options', this.actions.filter((a) => !a.positional));
    if (this.epilog) {
      const text = this.epilog.replace(/\s+/g, ' ').trim();
      out += textwrap(text, Math.max(width, 11)).join('\n') + '\n';
    }
    out = out.replace(/\n\n$/, '\n');
    return out;
  }

  /**
   * ArgumentParser.error: prints the usage and "prog: error: message" to standard error and exits with status 2.
   * @param {string} message
   * @returns {never}
   * @throws {ExitError} always, with exit code 2
   */
  error(message) {
    process.stderr.write(this.formatUsage());
    process.stderr.write(`${this.prog}: error: ${message}\n`);
    throw new ExitError(2);
  }

  /**
   * argparse._get_action_name: how error messages name an action.
   * @param {object} a the action
   * @returns {string} the metavar or dest of a positional, the option strings joined with "/" for an optional
   */
  argName(a) {
    if (a.positional) return a.metavar || a.dest;
    return a.optionStrings.join('/');
  }

  /**
   * _get_value and _check_value: converts one argument string by the action's type and checks it against its choices.
   * @param {object} a the action
   * @param {string} value the argument string
   * @returns {*} the converted value
   * @throws {ArgumentError} for a value that is not an int (type 'int') or not one of the choices; a type function
   *   may throw its own ArgumentError
   */
  convert(a, value) {
    if (a.type === 'int') {
      const v = pyInt(value);
      if (v === null) throw new ArgumentError(`argument ${this.argName(a)}: invalid int value: ${pyRepr(value)}`);
      value = v;
    } else if (typeof a.type === 'function') {
      value = a.type(value, a, this);
    }
    if (a.choices && !a.choices.includes(value)) {
      const shown = typeof value === 'string' ? pyRepr(value) : String(value);
      throw new ArgumentError(
        `argument ${this.argName(a)}: invalid choice: ${shown} (choose from ${a.choices.map((c) => (typeof c === 'string' ? pyRepr(c) : String(c))).join(', ')})`,
      );
    }
    return value;
  }

  /**
   * parse_args: parses the command line into a namespace of dest to value.
   * @param {string[]} argv the arguments after the program name
   * @returns {Object<string, *>} the namespace
   * @throws {ExitError} with code 2 after printing the error for a bad command line, with code 0 after -h or
   *   --version
   */
  parseArgs(argv) {
    try {
      return this._parse(argv);
    } catch (e) {
      if (e instanceof ArgumentError) this.error(e.message);
      throw e;
    }
  }

  /**
   * _parse_optional: classifies one argument string.
   * @param {string} arg
   * @returns {Array|null} [action or null, option string, explicit argument or null] for an optional, null for a
   *   positional
   * @throws {ArgumentError} for an abbreviation that matches more than one option
   */
  parseOptional(arg) {
    if (!arg || arg[0] !== '-') return null;
    const byString = this.optionStringActions();
    if (byString.has(arg)) return [byString.get(arg), arg, null];
    if (arg.length === 1) return null;
    if (arg.includes('=')) {
      const at = arg.indexOf('=');
      const optionString = arg.slice(0, at);
      if (byString.has(optionString)) return [byString.get(optionString), optionString, arg.slice(at + 1)];
    }
    const tuples = this.optionTuples(arg);
    if (tuples.length > 1) {
      throw new ArgumentError(`ambiguous option: ${arg} could match ${tuples.map((t) => t[1]).join(', ')}`);
    }
    if (tuples.length === 1) return tuples[0];
    if (NEGATIVE_NUMBER.test(arg) && ![...byString.keys()].some((o) => NEGATIVE_NUMBER.test(o))) return null;
    if (arg.includes(' ')) return null;
    return [null, arg, null];
  }

  /**
   * _get_option_tuples: the options an abbreviated (or, for short options, value-joined) string can mean.
   * @param {string} arg
   * @returns {Array[]} [action, option string, explicit argument or null] tuples
   */
  optionTuples(arg) {
    const result = [];
    if (arg[1] === '-') {
      const at = arg.indexOf('=');
      const prefix = at >= 0 ? arg.slice(0, at) : arg;
      const explicit = at >= 0 ? arg.slice(at + 1) : null;
      for (const [o, a] of this.optionStringActions()) if (o.startsWith(prefix)) result.push([a, o, explicit]);
    } else {
      const short = arg.slice(0, 2);
      for (const [o, a] of this.optionStringActions()) {
        if (o === short) result.push([a, o, arg.slice(2)]);
        else if (o.startsWith(arg)) result.push([a, o, null]);
      }
    }
    return result;
  }

  /** @returns {Map<string, object>} every option string mapped to its action */
  optionStringActions() {
    const map = new Map();
    for (const a of this.actions) for (const o of a.optionStrings) map.set(o, a);
    return map;
  }

  /**
   * _get_nargs_pattern: the regular expression, over the A/O/- pattern of the arguments, that an action's nargs
   * matches.
   * @param {object} a the action
   * @returns {string}
   */
  nargsPattern(a) {
    let pattern;
    if (a.nargs === undefined || a.nargs === null) pattern = '(-*A-*)';
    else if (a.nargs === '?') pattern = '(-*A?-*)';
    else if (a.nargs === '*') pattern = '(-*[A-]*)';
    else if (a.nargs === '+') pattern = '(-*A[A-]*)';
    else pattern = `(-*${'A'.repeat(a.nargs).split('').join('-*')}-*)`;
    if (!a.positional) pattern = pattern.replace(/-\*/g, '').replace(/-/g, '');
    return pattern;
  }

  /**
   * _match_argument: how many of the arguments (given as a pattern of A, O and -) the action takes.
   * @param {object} a the action
   * @param {string} pattern the A/O/- pattern of the arguments that follow it
   * @returns {number}
   * @throws {ArgumentError} "expected one argument" and the like when the pattern does not fit
   */
  matchArgument(a, pattern) {
    const m = new RegExp(`^${this.nargsPattern(a)}`).exec(pattern);
    if (m === null) {
      const messages = { undefined: 'expected one argument', null: 'expected one argument',
        '?': 'expected at most one argument', '+': 'expected at least one argument' };
      const msg = messages[a.nargs] || `expected ${a.nargs} argument${a.nargs === 1 ? '' : 's'}`;
      throw new ArgumentError(`argument ${this.argName(a)}: ${msg}`);
    }
    return m[1].length;
  }

  /**
   * _match_arguments_partial: how many arguments each of the leading positionals takes, for the longest prefix of
   * `actions` that matches.
   * @param {object[]} actions the positionals still to fill
   * @param {string} pattern the A/O/- pattern of the remaining arguments
   * @returns {number[]} one count per matched action
   */
  matchArgumentsPartial(actions, pattern) {
    for (let i = actions.length; i > 0; i--) {
      const m = new RegExp(`^${actions.slice(0, i).map((a) => this.nargsPattern(a)).join('')}`).exec(pattern);
      if (m !== null) return m.slice(1).map((g) => g.length);
    }
    return [];
  }

  /**
   * _get_values: the converted value or values an action receives for its argument strings.
   * @param {object} a the action
   * @param {string[]} argStrings
   * @returns {*}
   * @throws {ArgumentError} from convert()
   */
  getValues(a, argStrings) {
    const strings = [...argStrings];
    if (strings.includes('--')) strings.splice(strings.indexOf('--'), 1);
    if (!strings.length && a.nargs === '?') {
      const value = a.positional ? a.default : (a.const === undefined ? null : a.const);
      return typeof value === 'string' ? this.convert(a, value) : value;
    }
    if (!strings.length && a.nargs === '*' && a.positional) return a.default !== null ? a.default : strings;
    if (strings.length === 1 && (a.nargs === undefined || a.nargs === null || a.nargs === '?')) {
      return this.convert(a, strings[0]);
    }
    return strings.map((v) => this.convert(a, v));
  }

  // _parse_known_args followed by parse_args' check for unrecognized arguments
  _parse(argStrings) {
    const ns = {};
    for (const a of this.actions) {
      if (a.action === 'help' || a.action === 'version') continue;
      ns[a.dest] = Array.isArray(a.default) ? [...a.default] : a.default;
    }
    const optionIndices = new Map();
    let pattern = '';
    for (let i = 0; i < argStrings.length; i++) {
      if (argStrings[i] === '--') {
        pattern += '-' + 'A'.repeat(argStrings.length - i - 1);
        break;
      }
      const tuple = this.parseOptional(argStrings[i]);
      if (tuple === null) pattern += 'A';
      else {
        optionIndices.set(i, tuple);
        pattern += 'O';
      }
    }
    const seen = new Set();
    const extras = [];
    const takeAction = (a, args) => {
      seen.add(a);
      this.applyAction(a, this.getValues(a, args), ns);
    };
    const consumeOptional = (startIndex) => {
      let [a, optionString, explicit] = optionIndices.get(startIndex);
      const actionTuples = [];
      let stop;
      for (;;) {
        if (a === null) {
          extras.push(argStrings[startIndex]);
          return startIndex + 1;
        }
        if (explicit !== null) {
          const count = this.matchArgument(a, 'A');
          if (count === 0 && optionString[1] !== '-' && explicit !== '') {
            actionTuples.push([a, []]);
            optionString = optionString[0] + explicit[0];
            const next = this.optionStringActions().get(optionString);
            if (next === undefined) throw new ArgumentError(`argument ${this.argName(a)}: ignored explicit argument ${pyRepr(explicit)}`);
            a = next;
            explicit = explicit.slice(1) || null;
          } else if (count === 1) {
            stop = startIndex + 1;
            actionTuples.push([a, [explicit]]);
            break;
          } else {
            throw new ArgumentError(`argument ${this.argName(a)}: ignored explicit argument ${pyRepr(explicit)}`);
          }
        } else {
          const start = startIndex + 1;
          stop = start + this.matchArgument(a, pattern.slice(start));
          actionTuples.push([a, argStrings.slice(start, stop)]);
          break;
        }
      }
      for (const [action, args] of actionTuples) takeAction(action, args);
      return stop;
    };
    const positionals = this.actions.filter((a) => a.positional);
    const consumePositionals = (startIndex) => {
      const counts = this.matchArgumentsPartial(positionals, pattern.slice(startIndex));
      counts.forEach((count, k) => {
        takeAction(positionals[k], argStrings.slice(startIndex, startIndex + count));
        startIndex += count;
      });
      positionals.splice(0, counts.length);
      return startIndex;
    };
    let startIndex = 0;
    const maxOptionIndex = optionIndices.size ? Math.max(...optionIndices.keys()) : -1;
    while (startIndex <= maxOptionIndex) {
      const nextOptionIndex = Math.min(...[...optionIndices.keys()].filter((k) => k >= startIndex));
      if (startIndex !== nextOptionIndex) {
        const end = consumePositionals(startIndex);
        if (end > startIndex) {
          startIndex = end;
          continue;
        }
        startIndex = end;
      }
      if (!optionIndices.has(startIndex)) {
        extras.push(...argStrings.slice(startIndex, nextOptionIndex));
        startIndex = nextOptionIndex;
      }
      startIndex = consumeOptional(startIndex);
    }
    extras.push(...argStrings.slice(consumePositionals(startIndex)));
    const required = this.actions.filter((a) => !seen.has(a) && (a.positional ? a.nargs !== '?' && a.nargs !== '*' : a.required));
    if (required.length) {
      throw new ArgumentError(`the following arguments are required: ${required.map((a) => this.argName(a)).join(', ')}`);
    }
    for (const a of this.actions) {
      if (!seen.has(a) && typeof a.default === 'string' && ns[a.dest] === a.default) ns[a.dest] = this.convert(a, a.default);
    }
    if (extras.length) throw new ArgumentError(`unrecognized arguments: ${extras.join(' ')}`);
    return ns;
  }

  /**
   * Stores an action's value in the namespace (Action.__call__ for each action kind).
   * @param {object} a the action
   * @param {*} value the converted value
   * @param {Object<string, *>} ns the namespace being built
   * @returns {void}
   * @throws {ExitError} with code 0 after printing the help or the version
   */
  applyAction(a, value, ns) {
    switch (a.action) {
      case 'help':
        process.stdout.write(this.formatHelp());
        throw new ExitError(0);
      case 'version':
        process.stdout.write(a.version.replace('%(prog)s', this.prog) + '\n');
        throw new ExitError(0);
      case 'store_true': ns[a.dest] = true; break;
      case 'store_false': ns[a.dest] = false; break;
      case 'append': ns[a.dest] = [...(Array.isArray(ns[a.dest]) ? ns[a.dest] : []), value]; break;
      default: ns[a.dest] = value;
    }
  }
}

module.exports = { ArgumentParser, ArgumentError, ExitError };
