'use strict';
// Python's posixpath helpers that more than one tool or module needs.

/**
 * os.path.splitext (posixpath): splits off the last extension. A leading run of dots in the last path component is
 * not an extension, so ".bashrc" and "dir/..x" keep their whole name.
 * @param {string} p the path
 * @returns {[string, string]} the root and the extension ('' when there is none); root + ext === p
 */
function splitext(p) {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  if (dot <= slash + 1 || /^\.+$/.test(p.slice(slash + 1, dot))) return [p, ''];
  return [p.slice(0, dot), p.slice(dot)];
}

module.exports = { splitext };
