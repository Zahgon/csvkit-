'use strict';
// Python's default warnings output: printed once per (message, category, location).

/**
 * Where the original's Python packages live. A Python warning names the source file of the code that issues it, so
 * the warnings the tools reproduce name files under this folder, as the original prints them.
 */
const SITE_PACKAGES = '/opt/csvkit-venv/lib/python3.11/site-packages';

const seen = new Set();
const filters = [];

/**
 * warnings.filterwarnings("ignore", message=pattern): drops warnings whose message starts with the pattern.
 * @param {string} pattern
 */
function ignore(pattern) {
  filters.push(pattern);
}

/**
 * warnings.warn as Python's default filter shows it: "file:line: Category: message" and the source line,
 * once per location and message.
 * @param {string} file
 * @param {number} line
 * @param {string} category
 * @param {string} message
 * @param {string} sourceLine
 */
function warn(file, line, category, message, sourceLine) {
  if (filters.some((p) => message.startsWith(p))) return;
  const key = `${file}:${line}:${category}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  process.stderr.write(`${file}:${line}: ${category}: ${message}\n${sourceLine}\n`);
}

module.exports = { SITE_PACKAGES, warn, ignore };
