#!/usr/bin/env node
'use strict';
// Port of csvkit.utilities.csvstack (csvkit 2.2.0, MIT).

const path = require('node:path');
const { pyError } = require('../lib/pyerrors');
const { pyRepr } = require('../lib/pystr');
const { Utility, stdinIsTTY, makeDefaultHeaders } = require('../lib/cli');
const { LineWriter } = require('../lib/table');
const pycsv = require('../lib/pycsv');

/** csvstack: stacks the rows of several CSV files, optionally with a grouping column. */
class CSVStack extends Utility {
  constructor() {
    super('csvstack', 'Stack up the rows from multiple CSV files, optionally adding a grouping value.', '', ['f', 'L', 'I']);
  }

  /**
   * CSVStack.add_arguments: the files, -g, -n and --filenames.
   * @returns {void}
   */
  addArguments() {
    const p = this.argparser;
    p.addArgument(['FILE'], { metavar: 'FILE', nargs: '*', dest: 'input_paths', default: ['-'], help: 'The CSV file(s) to operate on. If omitted, will accept input as piped data via STDIN.' });
    p.addArgument(['-g', '--groups'], { dest: 'groups', help: 'A comma-separated list of values to add as "grouping factors", one per CSV being stacked. These are added to the output as a new column. You may specify a name for the new column using the -n flag.' });
    p.addArgument(['-n', '--group-name'], { dest: 'group_name', help: 'A name for the grouping column, e.g. "year". Only used when also specifying -g.' });
    p.addArgument(['--filenames'], { dest: 'group_by_filenames', action: 'store_true', help: 'Use the filename of each input file as its grouping value. When specified, -g will be ignored.' });
  }

  /**
   * CSVStack.main.
   * @returns {void}
   * @throws {ExitError} with status 2 when the -g groups do not match the files
   * @throws {Error} pyName ValueError when a row has a field the header does not name (csv.DictWriter)
   */
  main() {
    const a = this.args;
    const paths = a.input_paths;
    if (stdinIsTTY() && paths.length === 1 && paths[0] === '-') process.stderr.write('No input file or piped data provided. Waiting for standard input:\n');
    const hasGroups = a.groups !== null || a.group_by_filenames;
    let groups = null;
    if (a.groups !== null && !a.group_by_filenames) {
      groups = a.groups.split(',');
      if (groups.length !== paths.length) this.argparser.error('The number of grouping values must be equal to the number of CSV files being stacked.');
    }
    const groupName = a.group_name ? a.group_name : 'group';
    const useFieldnames = !a.no_header_row;
    const kw = { ...this.reader_kwargs };
    delete kw.header;
    let headers = [];
    const files = new Map();
    const skip = (f) => { let n = a.skip_lines; while (n > 0) { f.readline(); n--; } };
    const getFile = (p) => {
      if (p === '-') {
        if (!files.has('-')) files.set('-', this.openInputFile('-'));
        return files.get('-');
      }
      return this.openInputFile(p);
    };
    const readers = [];
    for (const p of paths) {
      const f = getFile(p);
      if (p !== '-' || !f.skipped) { skip(f); f.skipped = true; }
      const r = new pycsv.Reader(f.lines(), kw);
      if (useFieldnames) {
        const fn = r.readRow();
        const fieldnames = fn || [];
        for (const fld of fieldnames) if (!headers.includes(fld)) headers.push(fld);
        readers.push({ f, r, fieldnames, p });
      } else {
        const row = r.readRow() || [];
        headers = makeDefaultHeaders(row.length);
        readers.push({ f, r, first: row, p });
        break;
      }
    }
    if (hasGroups) headers.unshift(groupName);
    const out = new LineWriter(this.out, this.writer_kwargs);
    if (useFieldnames) {
      const wk = this.writer_kwargs;
      const hdr = wk.lineNumbers ? ['line_number', ...headers] : headers;
      // DictWriter
      const w = new pycsv.Writer(this.out, { lineterminator: '\n' });
      w.writerow(hdr);
      let count = 1;
      const seenStdin = new Set();
      paths.forEach((p, i) => {
        const group = hasGroups ? (groups ? groups[i] : path.basename(p === '-' ? '<stdin>' : p)) : null;
        let entry = readers[i];
        if (p === '-' && seenStdin.has('-')) entry = { ...entry, fieldnames: entry.fieldnames };
        seenStdin.add(p);
        const { r, fieldnames } = entry;
        for (;;) {
          const row = r.readRow();
          if (row === null) break;
          if (fieldnames.length === 0 && row.length === 0) continue;
          if (row.length === 0) continue;
          const d = new Map();
          fieldnames.forEach((k, j) => d.set(k, j < row.length ? row[j] : null));
          if (row.length > fieldnames.length) d.set(null, row.slice(fieldnames.length));
          if (hasGroups) d.set(groupName, group);
          for (const [k, v] of d) if (typeof v === 'string') d.set(k, v.replace(/\r/g, '\n'));
          if (wk.lineNumbers) { d.set('line_number', count); count++; }
          const extra = [...d.keys()].filter((k) => !hdr.includes(k));
          if (extra.length) {
            throw pyError('ValueError', `dict contains fields not in fieldnames: ${extra.map((k) => (k === null ? 'None' : pyRepr(k))).join(', ')}`);
          }
          w.writerow(hdr.map((h) => (d.has(h) ? d.get(h) : '')));
        }
      });
    } else {
      out.writerow(headers);
      paths.forEach((p, i) => {
        const group = hasGroups ? (groups ? groups[i] : path.basename(p === '-' ? '<stdin>' : p)) : null;
        let r;
        if (p === '-' && readers[0].p === '-' && !readers[0].used) {
          readers[0].used = true;
          r = readers[0].r;
          if (readers[0].first.length) out.writerow(readers[0].first);
        } else {
          const f = p === '-' ? getFile(p) : this.openInputFile(p);
          if (p !== '-') skip(f);
          r = new pycsv.Reader(f.lines(), kw);
        }
        for (;;) {
          const row = r.readRow();
          if (row === null) break;
          if (hasGroups) row.unshift(group);
          out.writerow(row);
        }
      });
    }
  }
}

new CSVStack().launch();
